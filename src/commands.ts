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
    failure
}: {
    context: vscode.ExtensionContext;
    auth: Auth;
    rootUri: vscode.Uri;
    failure: ReturnType<typeof signal<{ err: Error; source?: string } | undefined>>;
}) => {
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.openProject`, async () => {
            const [err] = await tryCatch(async () => {
                const client = await auth.getClient(true);
                if (!client) {
                    return;
                }
                const [err1, projects] = await tryCatch(client.rest.userProjects(client.userId, 'profile'));
                client.rest.dispose();
                if (err1) {
                    throw err1;
                }
                await openFolder(rootUri, projects);
            });
            if (err) {
                failure.set(() => ({ err, source: 'commands' }));
            }
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
            failure.set(() => ({ err, source: 'uri-handler' }));
        }
    });
    context.subscriptions.push(new vscode.Disposable(disposeUriError));
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.reportIssue`, async (value?: string) => {
            const [err] = await tryCatch(report({ value, userId: 'anonymous' }));
            if (err) {
                failure.set(() => ({ err, source: 'commands' }));
            }
        })
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
    reload,
    failure
}: {
    context: vscode.ExtensionContext;
    rootUri: vscode.Uri;
    userId: number;
    rest: Rest;
    metrics: Metrics;
    state: State;
    cache: Cache;
    reload: ReturnType<typeof signal<{ projectManager: ProjectManager } | undefined>>;
    failure: ReturnType<typeof signal<{ err: Error; source?: string } | undefined>>;
}) => {
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.openProject`, async () => {
            const [err] = await tryCatch(async () => {
                metrics.increment('command', { name: 'openProject' });
                const projects = await rest.userProjects(userId, 'profile');
                await openFolder(rootUri, projects);
            });
            if (err) {
                failure.set(() => ({ err, source: 'commands' }));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.reloadProject`, async () => {
            const [err] = await tryCatch(async () => {
                metrics.increment('command', { name: 'reloadProject' });
                if (!state.projectId) {
                    return;
                }

                const { projectManager } = cache.get(state.projectId) ?? {};
                if (!projectManager) {
                    return;
                }

                if (projectManager.unsafeFiles().length) {
                    void vscode.window.showWarningMessage(
                        'PlayCanvas changes are not saved. Try again when saving finishes.'
                    );
                    return;
                }

                reload.set(() => ({ projectManager }));
            });
            if (err) {
                failure.set(() => ({ err, source: 'commands' }));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.switchBranch`, async () => {
            const [err] = await tryCatch(async () => {
                metrics.increment('command', { name: 'switchBranch' });
                if (!state.projectId) {
                    return;
                }

                const { branchId, projectManager } = cache.get(state.projectId) ?? {};
                if (!branchId || !projectManager) {
                    return;
                }

                if (projectManager.unsafeFiles().length) {
                    void vscode.window.showWarningMessage(
                        'PlayCanvas changes are not saved. Try again when saving finishes.'
                    );
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
            });
            if (err) {
                failure.set(() => ({ err, source: 'commands' }));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.showPathCollisions`, async () => {
            const [err] = await tryCatch(async () => {
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
                const option = await vscode.window.showWarningMessage(
                    [
                        `${collisions.size} asset path collision${collisions.size !== 1 ? 's' : ''} found.`,
                        'Rename or move the colliding assets in the Editor to resolve.'
                    ].join('\n'),
                    ...options
                );
                switch (option) {
                    case options[0]: {
                        const list = Array.from(collisions.entries()).map(([path, ids]) => ({
                            label: path,
                            description: `(${ids.join(', ')})`
                        }));
                        await vscode.window.showQuickPick(list, {
                            title: 'Asset Path Collisions',
                            placeHolder: 'Filter paths',
                            canPickMany: false
                        });
                        break;
                    }
                    case options[1]: {
                        await vscode.commands.executeCommand(`${NAME}.reloadProject`);
                        break;
                    }
                }
            });
            if (err) {
                failure.set(() => ({ err, source: 'commands' }));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.reportIssue`, async (value?: string) => {
            const [err] = await tryCatch(report({ value, userId, state, cache }));
            if (err) {
                failure.set(() => ({ err, source: 'commands' }));
            }
        })
    );
};
