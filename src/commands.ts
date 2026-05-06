import * as os from 'os';

import * as vscode from 'vscode';

import type { Auth } from './auth';
import { NAME, VERSION, ENV } from './config';
import type { Rest } from './connections/rest';
import { UriHandler } from './handlers/uri-handler';
import { Log } from './log';
import type { Metrics } from './metrics';
import type { ProjectManager } from './project-manager';
import { addAttachment, captureIssue, getLastSentryEventId } from './sentry';
import * as redact from './utils/redact';
import type { signal } from './utils/signal';
import { effect } from './utils/signal';
import { fmtLog, projectToName, tryCatch } from './utils/utils';

type State = {
    projectId: number | null;
};

type Cache = Map<
    number,
    {
        branchId: string;
        projectManager: ProjectManager;
    }
>;

const openFolder = async (rootUri: vscode.Uri, projects: Awaited<ReturnType<Rest['userProjects']>>) => {
    const list = projects.map((p) => projectToName(p, false)).reverse();
    const chosen = await vscode.window.showQuickPick(list, {
        placeHolder: 'Select a project'
    });
    const project = projects.find((p) => chosen === projectToName(p, false));
    if (!project) {
        return;
    }

    const folder = vscode.Uri.joinPath(rootUri, projectToName(project));
    await vscode.workspace.fs.createDirectory(folder);
    await vscode.commands.executeCommand('vscode.openFolder', folder, false);
};

const report = async ({
    value,
    userId,
    state,
    cache
}: {
    value?: string;
    userId: number | 'anonymous';
    state?: State;
    cache?: Cache;
}) => {
    const text =
        value ??
        (await vscode.window.showInputBox({
            title: 'PlayCanvas: Report Issue',
            prompt: 'Describe the issue',
            placeHolder: 'e.g. scripts are not syncing with online IDE',
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : 'Description is required')
        }));
    if (!text) {
        return;
    }

    const project = state?.projectId ? cache?.get(state.projectId) : undefined;
    const bundle = redact.text(Log.dump().map(fmtLog).join('\n'));
    addAttachment({ filename: `${userId}.log`, data: bundle, contentType: 'text/plain' });

    const eventId = captureIssue(text, {
        report: {
            extension: VERSION,
            vscode: vscode.version,
            platform: `${process.platform} ${os.release()}`,
            env: ENV,
            project: state?.projectId ?? 'none',
            branch: project?.branchId ?? 'none',
            desync: project?.projectManager.desync.get() ?? false,
            last_sentry_event: getLastSentryEventId() ?? 'none'
        }
    });

    const copy = 'Copy ID';
    void vscode.window
        .showInformationMessage(`Report sent to PlayCanvas team. Reference: ${eventId}`, copy)
        .then((c) => {
            if (c === copy) {
                void vscode.env.clipboard.writeText(eventId);
            }
        });
};

export const registerIdleCommands = ({
    context,
    auth,
    rootUri,
    error
}: {
    context: vscode.ExtensionContext;
    auth: Auth;
    rootUri: vscode.Uri;
    error: ReturnType<typeof signal<Error | undefined>>;
}) => {
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.openProject`, async () => {
            const [err1, client] = await tryCatch(auth.getClient(true));
            if (err1) {
                error.set(() => err1);
                return;
            }
            if (!client) {
                return;
            }
            const [err2, projects] = await tryCatch(client.rest.userProjects(client.userId, 'profile'));
            client.rest.dispose();
            if (err2) {
                error.set(() => err2);
                return;
            }
            await openFolder(rootUri, projects);
        })
    );
    context.subscriptions.push(vscode.commands.registerCommand(`${NAME}.reloadProject`, () => undefined));
    context.subscriptions.push(vscode.commands.registerCommand(`${NAME}.switchBranch`, () => undefined));
    context.subscriptions.push(vscode.commands.registerCommand(`${NAME}.showPathCollisions`, () => undefined));
    const uriHandler = new UriHandler({
        context,
        rootUri,
        auth
    });
    const disposeUriError = effect(() => {
        const err = uriHandler.error.get();
        if (err) {
            error.set(() => err);
        }
    });
    context.subscriptions.push(new vscode.Disposable(disposeUriError));
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.reportIssue`, (value?: string) =>
            report({ value, userId: 'anonymous' })
        )
    );
};

export const registerProjectCommands = ({
    context,
    rootUri,
    userId,
    rest,
    metrics,
    state,
    cache,
    reload
}: {
    context: vscode.ExtensionContext;
    rootUri: vscode.Uri;
    userId: number;
    rest: Rest;
    metrics: Metrics;
    state: State;
    cache: Cache;
    reload: ReturnType<typeof signal<{ projectManager: ProjectManager } | undefined>>;
}) => {
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.openProject`, async () => {
            metrics.increment('command', { name: 'openProject' });
            const projects = await rest.userProjects(userId, 'profile');
            await openFolder(rootUri, projects);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.reloadProject`, async () => {
            metrics.increment('command', { name: 'reloadProject' });
            if (!state.projectId) {
                return;
            }

            const { projectManager } = cache.get(state.projectId) ?? {};
            if (!projectManager) {
                return;
            }

            reload.set(() => ({ projectManager }));
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.switchBranch`, async () => {
            metrics.increment('command', { name: 'switchBranch' });
            if (!state.projectId) {
                return;
            }

            const { branchId } = cache.get(state.projectId) ?? {};
            if (!branchId) {
                return;
            }

            const branches = await rest.projectBranches(state.projectId);
            const names = branches.reduce((acc: string[], b) => {
                if (b.id !== branchId) {
                    acc.push(b.name);
                }
                return acc;
            }, []);
            const chosen = await vscode.window.showQuickPick(names, {
                placeHolder: 'Select a branch'
            });
            if (!chosen) {
                return;
            }

            const branch = branches.find((b) => b.name === chosen);
            if (!branch) {
                return;
            }

            await rest.branchCheckout(branch.id);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.showPathCollisions`, async () => {
            if (!state.projectId) {
                return;
            }
            const { projectManager } = cache.get(state.projectId) ?? {};
            if (!projectManager) {
                return;
            }

            const collisions = projectManager.collisions.snapshot();
            if (collisions.size === 0) {
                return;
            }

            const options = ['Show Path Collisions', 'Reload project'];
            void vscode.window
                .showWarningMessage(
                    [
                        `${collisions.size} asset path collision${collisions.size !== 1 ? 's' : ''} found.`,
                        'Rename or move the colliding assets in the Editor to resolve.'
                    ].join('\n'),
                    ...options
                )
                .then((option) => {
                    switch (option) {
                        case options[0]: {
                            const list = Array.from(collisions.entries()).map(([path, ids]) => ({
                                label: path,
                                description: `(${ids.join(', ')})`
                            }));
                            void vscode.window.showQuickPick(list, {
                                title: 'Asset Path Collisions',
                                placeHolder: 'Filter paths',
                                canPickMany: false
                            });
                            break;
                        }
                        case options[1]: {
                            void vscode.commands.executeCommand(`${NAME}.reloadProject`);
                            break;
                        }
                    }
                });
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.reportIssue`, (value?: string) =>
            report({ value, userId, state, cache })
        )
    );
};
