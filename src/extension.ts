import * as vscode from 'vscode';

import { Auth } from './auth';
import { API_URL, ENV, NAME, HOME_URL, MESSENGER_URL, REALTIME_URL, RELAY_URL, ROOT_FOLDER, DEBUG } from './config';
import { Messenger } from './connections/messenger';
import { Relay } from './connections/relay';
import { Rest } from './connections/rest';
import { ShareDb } from './connections/sharedb';
import { Disk } from './disk';
import { UriHandler } from './handlers/uri-handler';
import { Log } from './log';
import { Metrics } from './metrics';
import { simpleNotification } from './notification';
import { ProjectManager } from './project-manager';
import { CollabProvider } from './providers/collab-provider';
import { closeSentry, setSentryProject, setSentryUser } from './sentry';
import type { EventMap } from './typings/event-map';
import type { Project } from './typings/models';
import { EventEmitter } from './utils/event-emitter';
import { computed, effect } from './utils/signal';
import { projectToName, retry, tryCatch, uriStartsWith } from './utils/utils';

export const activate = async (context: vscode.ExtensionContext) => {
    // ! defer by 1 tick to allow for tests to stub modules before extension loads
    await new Promise((resolve) => setTimeout(resolve, 0));

    // register log channel and sentry for cleanup
    context.subscriptions.push(Log.channel);
    context.subscriptions.push(
        new vscode.Disposable(() => {
            void closeSentry();
        })
    );
    if (DEBUG) {
        Log.channel.show(true);
    }
    const log = new Log('Extension');

    // load config
    const config = vscode.workspace.getConfiguration(NAME);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration(NAME)) {
                return;
            }

            const confirmation = 'Reload Now';
            const selection = await vscode.window.showInformationMessage(
                'PlayCanvas configuration changed. Please reload the window to apply changes.',
                confirmation
            );
            if (selection !== confirmation) {
                return;
            }
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        })
    );

    // root uri
    // FIXME: need to use file schema - plugin not loading types correctly with vscode-data:///
    // ! This cannot be tested as ROOT_FOLDER overrides it in tests
    const rootUri = ROOT_FOLDER
        ? vscode.Uri.parse(`${ROOT_FOLDER}/${ENV}`)
        : vscode.Uri.parse(config.get<string>('rootDir') || `${context.globalStorageUri.path}/${ENV}`);

    // auth
    const auth = new Auth(context);
    context.subscriptions.push(vscode.commands.registerCommand(`${NAME}.login`, async () => auth.getAccessToken(true)));
    const accessToken = await auth.getAccessToken();

    // metrics
    const metrics = new Metrics(accessToken);
    context.subscriptions.push(metrics.disposable);
    metrics.increment('session.start');

    // error handler
    const handleError = async (error?: Error) => {
        if (!error) {
            return;
        }

        // log to output channel (also reports to sentry)
        log.error(error.message);
        if (error.stack) {
            log.error(error.stack);
        }

        metrics.logError(error);

        // handle auth errors
        if (/access token/.test(error.message)) {
            await auth.reset(`Auth Error: ${error.message}`);
        }

        vscode.window.showErrorMessage(`PlayCanvas Error: ${error.message}`);
    };

    // create events
    const events = new EventEmitter<EventMap>();
    context.subscriptions.push(
        new vscode.Disposable(() => {
            events.removeAllListeners();
        })
    );

    // rest client
    const rest = new Rest({
        url: API_URL,
        origin: HOME_URL,
        accessToken
    });
    context.subscriptions.push(new vscode.Disposable(() => rest.dispose()));

    // realtime connection
    const sharedb = new ShareDb({
        url: REALTIME_URL,
        origin: HOME_URL
    });
    effect(() => {
        const err = sharedb.error.get();
        if (err) {
            void handleError(err).catch((e) => log.error(e.message));
        }
    });

    // messenger
    const messenger = new Messenger({
        url: MESSENGER_URL,
        origin: HOME_URL
    });

    // relay
    const relay = new Relay({
        url: RELAY_URL,
        origin: HOME_URL
    });
    effect(() => {
        const err = relay.error.get();
        if (err) {
            void handleError(err).catch((e) => log.error(e.message));
        }
    });

    // find user id
    const userId = await rest.id();
    setSentryUser(userId);

    // state
    const state: {
        projectId: number | null;
    } = {
        projectId: null
    };

    // cache
    const cache = new Map<
        number,
        {
            branchId: string;
            projectManager: ProjectManager;
        }
    >();

    const disk = new Disk({
        events
    });
    effect(() => {
        const err = disk.error.get();
        if (err) {
            void handleError(err).catch((e) => log.error(e.message));
        }
    });

    let reloading: Promise<void> | null = null;
    const reload = async (projectManager: ProjectManager, branchId?: string) => {
        while (reloading) {
            await tryCatch(reloading);
        }
        reloading = (async () => {
            await projectManager.flushPending();
            const collabState = await collabProvider.unlink();
            const uriState = await uriHandler.unlink();
            const diskState = await disk.unlink();
            const projectState = await projectManager.unlink();
            projectState.branchId = branchId ?? projectState.branchId;

            // TODO: figure out why this is needed to avoid ShareDB issues
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // retry link phase — transient network failures during reload
            // should not leave the extension in a broken unlinked state
            await retry(() => projectManager.link(projectState), {
                retries: 2,
                delay: (i) => 3000 * (i + 1),
                warn: (err, attempt) => log.warn(`reload link failed (attempt ${attempt}/3): ${err.message}`)
            });

            await disk.link(diskState);
            await collabProvider.link(collabState);
            await uriHandler.link(uriState);
        })();
        const [err] = await tryCatch(reloading);
        reloading = null;
        if (err) {
            throw err;
        }
    };

    // uri handler
    const uriHandler = new UriHandler({
        context,
        rootUri,
        userId,
        rest
    });
    effect(() => {
        const err = uriHandler.error.get();
        if (err) {
            void handleError(err).catch((e) => log.error(e.message));
        }
    });
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

    // collab provider
    const collabProvider = new CollabProvider({
        relay,
        rest
    });
    effect(() => {
        const err = collabProvider.error.get();
        if (err) {
            void handleError(err).catch((e) => log.error(e.message));
        }
    });
    context.subscriptions.push(vscode.window.registerTreeDataProvider('collab-view', collabProvider));

    // connection status bar item
    const connectionStatusColors = {
        connected: '#2ecc71',
        disconnected: '#e74c3c'
    };
    const connectionStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    context.subscriptions.push(connectionStatusItem);
    connectionStatusItem.color = connectionStatusColors.disconnected;
    connectionStatusItem.text = `$(primitive-dot) Disconnected`;
    connectionStatusItem.tooltip = 'PlayCanvas Connection';
    connectionStatusItem.show();
    const connected = computed(() => {
        return sharedb.connected.get() && messenger.connected.get() && relay.connected.get();
    });
    effect(() => {
        const enabled = connected.get();
        metrics.increment('connection', { status: enabled ? 'connected' : 'disconnected' });
    });
    effect(() => {
        const enabled = connected.get();
        connectionStatusItem.color = enabled ? connectionStatusColors.connected : connectionStatusColors.disconnected;
        if (enabled) {
            const m = messenger.ping.get();
            const r = relay.ping.get();
            const vals = [m, r].filter((v) => v > 0);
            const suffix = vals.length ? ` ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}ms` : '';
            connectionStatusItem.text = `$(primitive-dot) Connected${suffix}`;
        } else {
            connectionStatusItem.text = `$(primitive-dot) Disconnected`;
        }
    });

    // collision status bar item
    const collisionStatusColors = {
        none: '',
        found: '#e67e22'
    };
    const collisionStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -9999);
    context.subscriptions.push(collisionStatusItem);
    collisionStatusItem.color = collisionStatusColors.none;
    collisionStatusItem.command = `${NAME}.showPathCollisions`;
    collisionStatusItem.text = `$(check) Path Collisions: 0`;
    collisionStatusItem.tooltip = 'PlayCanvas Asset Path Collisions';
    collisionStatusItem.show();

    // branch status bar item
    const branchStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
    context.subscriptions.push(branchStatusBarItem);
    branchStatusBarItem.command = `${NAME}.switchBranch`;
    branchStatusBarItem.text = `$(git-branch) no branch`;
    branchStatusBarItem.tooltip = 'Switch Branch';
    branchStatusBarItem.show();

    // watch for version control changes
    const branchSwitch = messenger.on('branch.switch', async (e) => {
        const [err] = await tryCatch(
            (async () => {
                const { project_id, branch_id, name } = e.data;

                // fetch project and disk from cache
                const { projectManager } = cache.get(project_id) ?? {};
                if (!projectManager) {
                    return;
                }

                metrics.increment('branch.switch');
                const branchSwitchDone = await simpleNotification(`Switching to branch ${name}...`);

                // reload project
                const [reloadErr] = await tryCatch(reload(projectManager, branch_id));
                branchSwitchDone();
                if (reloadErr) {
                    throw reloadErr;
                }

                // update cache
                cache.set(project_id, { branchId: branch_id, projectManager });

                // update branch status bar item
                branchStatusBarItem.text = `$(git-branch) ${name}`;
            })()
        );
        if (err) {
            handleError(err);
        }
    });
    const branchClose = messenger.on('branch.close', async (e) => {
        const [err] = await tryCatch(
            (async () => {
                const { project_id, branch_id } = e.data;

                // fetch project and disk from cache
                const { projectManager, branchId } = cache.get(project_id) ?? {};
                if (!projectManager) {
                    return;
                }
                if (branchId !== branch_id) {
                    return;
                }

                // find main branch
                const branches = await rest.projectBranches(project_id);
                const main = branches.find((b) => b.permanent);
                if (!main) {
                    throw new Error(`Failed to find main branch to switch to`);
                }

                // checkout main branch
                // NOTE: branch switch flow continues in messenger event above
                await rest.branchCheckout(main.id);
            })()
        );
        if (err) {
            handleError(err);
        }
    });
    const checkpointRestore = async (data: {
        project_id: number;
        branch_id: string;
        checkpoint_id: string;
        status: 'success' | 'error';
    }) => {
        const [err] = await tryCatch(
            (async () => {
                const { project_id, branch_id, checkpoint_id, status } = data;

                // check status
                if (status !== 'success') {
                    throw new Error(`Failed to restore to checkpoint ${checkpoint_id}`);
                }

                // fetch project and disk from cache
                const { projectManager, branchId } = cache.get(project_id) ?? {};
                if (!projectManager) {
                    return;
                }
                if (branchId !== branch_id) {
                    return;
                }

                const checkpointDone = await simpleNotification(
                    `Restoring to checkpoint ${checkpoint_id}. Reloading...`
                );

                // reload project
                const [reloadErr] = await tryCatch(reload(projectManager));
                checkpointDone();
                if (reloadErr) {
                    throw reloadErr;
                }
            })()
        );
        if (err) {
            handleError(err);
        }
    };
    const checkpointRevert = messenger.on('checkpoint.revertEnded', (e) => checkpointRestore(e.data));
    const checkpointHardReset = messenger.on('checkpoint.hardResetEnded', (e) => checkpointRestore(e.data));
    context.subscriptions.push(
        new vscode.Disposable(() => {
            messenger.off('branch.switch', branchSwitch);
            messenger.off('branch.close', branchClose);
            messenger.off('checkpoint.revertEnded', checkpointRevert);
            messenger.off('checkpoint.hardResetEnded', checkpointHardReset);
        })
    );

    // open project
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.openProject`, async () => {
            metrics.increment('command', { name: 'openProject' });
            // fetch all user projects
            const projects = await rest.userProjects(userId, 'profile');

            // show picker
            const list = projects.map((p) => projectToName(p, false)).reverse();
            const chosen = await vscode.window.showQuickPick(list, {
                placeHolder: 'Select a project'
            });
            const project = projects.find((p) => chosen === projectToName(p, false));
            if (!project) {
                return;
            }

            // open project folder
            const folder = vscode.Uri.joinPath(rootUri, projectToName(project));
            await vscode.workspace.fs.createDirectory(folder);
            await vscode.commands.executeCommand('vscode.openFolder', folder, false);
        })
    );

    // reload project
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.reloadProject`, async () => {
            metrics.increment('command', { name: 'reloadProject' });
            // check if we have an active editor
            if (!state.projectId) {
                return;
            }

            // fetch from cache
            const { projectManager } = cache.get(state.projectId) ?? {};
            if (!projectManager) {
                return;
            }

            const reloadDone = await simpleNotification('Reloading project...');

            // reload project
            const [err] = await tryCatch(reload(projectManager));
            reloadDone();
            if (err) {
                void handleError(err).catch((e) => log.error(e.message));
                return;
            }
        })
    );

    // switch branch
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.switchBranch`, async () => {
            metrics.increment('command', { name: 'switchBranch' });
            // check if we have an active project
            if (!state.projectId) {
                return;
            }

            // fetch from cache
            const { branchId } = cache.get(state.projectId) ?? {};
            if (!branchId) {
                return;
            }

            // fetch project branches (excluding current branch)
            const branches = await rest.projectBranches(state.projectId);
            const branchNames = branches.reduce((acc: string[], b) => {
                if (b.id === branchId) {
                    return acc;
                }
                acc.push(b.name);
                return acc;
            }, []);

            // show picker
            const chosen = await vscode.window.showQuickPick(branchNames, {
                placeHolder: 'Select a branch'
            });
            if (!chosen) {
                return;
            }

            // find branch
            const branch = branches.find((b) => b.name === chosen);
            if (!branch) {
                return;
            }

            // checkout branch
            // NOTE: branch switch flow continues in messenger event above
            await rest.branchCheckout(branch.id);
        })
    );

    // view collisions
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.showPathCollisions`, async () => {
            if (!state.projectId) {
                return;
            }
            const { projectManager } = cache.get(state.projectId) ?? {};
            if (!projectManager) {
                return;
            }

            const collisions = projectManager.collided();
            if (collisions.size === 0) {
                return;
            }

            // show warning message
            const options = ['Show Path Collisions', 'Reload project'];
            vscode.window
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
                            vscode.window.showQuickPick(list, {
                                title: 'Asset Path Collisions',
                                placeHolder: 'Filter paths',
                                canPickMany: false
                            });
                            break;
                        }
                        case options[1]: {
                            vscode.commands.executeCommand(`${NAME}.reloadProject`);
                            break;
                        }
                    }
                });
        })
    );

    // load project
    const projects = await rest.userProjects(userId, 'profile');
    const valid: [vscode.WorkspaceFolder, Project][] = (vscode.workspace.workspaceFolders ?? []).reduce(
        (list, f) => {
            // ensure folder is in home directory
            if (!uriStartsWith(f.uri, rootUri)) {
                return list;
            }

            // ensure folder matches a user project
            const project = projects.find((p) => projectToName(p) === f.name);
            if (!project) {
                return list;
            }

            list.push([f, project]);
            return list;
        },
        [] as [vscode.WorkspaceFolder, Project][]
    );

    for (const [folder, project] of valid) {
        // ensure folder directory exists
        await vscode.workspace.fs.createDirectory(folder.uri);

        // connect sharedb, messenger, relay if not connected
        if (!sharedb.connected.get()) {
            const [err] = await tryCatch(sharedb.connect(() => accessToken));
            if (err) {
                sharedb.disconnect();
                throw err;
            }
            context.subscriptions.push(
                new vscode.Disposable(() => {
                    sharedb.disconnect();
                })
            );
        }
        if (!messenger.connected.get()) {
            const [err] = await tryCatch(messenger.connect(() => accessToken));
            if (err) {
                messenger.disconnect();
                throw err;
            }
            context.subscriptions.push(
                new vscode.Disposable(() => {
                    messenger.disconnect();
                })
            );
        }
        if (!relay.connected.get()) {
            const [err] = await tryCatch(relay.connect(() => accessToken));
            if (err) {
                relay.disconnect();
                throw err;
            }
            context.subscriptions.push(
                new vscode.Disposable(() => {
                    relay.disconnect();
                })
            );
        }

        // load branch info
        const doc = await sharedb.subscribe('settings', `project_${project.id}_${userId}`);
        if (!doc) {
            handleError(new Error(`Failed to load project settings for project ${project.id}`));
            return;
        }
        context.subscriptions.push(
            new vscode.Disposable(() => {
                sharedb.unsubscribe('settings', `project_${project.id}_${userId}`);
            })
        );
        const branchId = doc.data?.branch ?? '';

        // fetch project branches
        const branches = await rest.projectBranches(project.id);
        const branch = branches.find((b) => b.id === branchId);
        if (branch) {
            // set branch name
            branchStatusBarItem.text = `$(git-branch) ${branch.name}`;
        }

        // watch project
        messenger.watch(project.id);
        context.subscriptions.push(
            new vscode.Disposable(() => {
                messenger.unwatch(project.id);
            })
        );

        // load project
        const projectManager = new ProjectManager({
            events,
            sharedb,
            messenger,
            relay,
            rest
        });
        effect(() => {
            const err = projectManager.error.get();
            if (err) {
                void handleError(err).catch((e) => log.error(e.message));
            }
        });
        effect(() => {
            const count = projectManager.collisions.get();
            collisionStatusItem.color = count > 0 ? collisionStatusColors.found : collisionStatusColors.none;
            collisionStatusItem.text = `$(${count > 0 ? 'warning' : 'check'}) Path Collisions: ${count}`;
        });

        // store in cache early so messenger events during loading can find it
        cache.set(project.id, { branchId, projectManager });

        setSentryProject(project.id, branchId);
        await projectManager.link({
            projectId: project.id,
            branchId: branchId
        });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                projectManager.unlink();
            })
        );

        const folderUri = vscode.Uri.joinPath(rootUri, projectToName(project));

        // mount disk
        await disk.link({
            folderUri,
            projectManager
        });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                disk.unlink();
            })
        );

        // link collab provider
        collabProvider.link({
            folderUri,
            projectManager
        });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                collabProvider.unlink();
            })
        );

        // link uri handler
        await uriHandler.link({
            folderUri,
            projectManager
        });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                uriHandler.unlink();
            })
        );

        metrics.increment('project.open');

        context.subscriptions.push(
            new vscode.Disposable(() => {
                cache.delete(project.id);
            })
        );

        // update active project
        state.projectId = project.id;

        // TODO: multiple projects per workspace not supported
        if (valid.length > 1) {
            break;
        }
    }
};
