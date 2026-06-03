import * as vscode from 'vscode';

import { Auth } from './auth';
import { registerIdleCommands, registerProjectCommands } from './commands';
import {
    DEBUG,
    ENV,
    HOME_URL,
    MESSENGER_URL,
    NAME,
    REALTIME_URL,
    RELAY_URL,
    ROOT_FOLDER,
    VERSION,
    WEB
} from './config';
import { Messenger } from './connections/messenger';
import { Relay } from './connections/relay';
import { ShareDb } from './connections/sharedb';
import { Disk } from './disk';
import { UriHandler } from './handlers/uri-handler';
import { Log } from './log';
import { Metrics } from './metrics';
import { simpleNotification } from './notification';
import { ProjectManager } from './project-manager';
import { CollabProvider } from './providers/collab-provider';
import { DecorationProvider } from './providers/decoration-provider';
import { closeSentry, setSentryCollaborators, setSentryProject, setSentryUser } from './sentry';
import { TypeInstaller } from './type-installer';
import type { EventMap } from './typings/event-map';
import type { Project } from './typings/models';
import { fail } from './utils/error';
import { EventEmitter } from './utils/event-emitter';
import { computed, effect, signal } from './utils/signal';
import { projectToName, tryCatch, uriStartsWith, wait } from './utils/utils';

const HEARTBEAT_MS = 5 * 60 * 1000;
const PING_SAMPLE_MS = 60 * 1000;
const SESSION_DIMENSIONS = {
    version: `v${VERSION.replace(/[^a-z0-9]/gi, '_')}`,
    os: WEB ? 'web' : process.platform
};
const COLORS = {
    success: '#2ecc71',
    warning: '#e67e22',
    error: '#e74c3c'
};

export const activate = async (context: vscode.ExtensionContext) => {
    // ! defer by 1 tick to allow for tests to stub modules before extension loads
    await wait(0);

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
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
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
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => uriStartsWith(f.uri, rootUri));
    const projectWindow = folders.length > 0;
    const telemetry: { metrics?: Metrics } = {};

    // error handler
    const handleError = async (err?: Error, source?: string) => {
        if (!err) {
            return;
        }

        // user-initiated cancel — surface as warning + retry, not an error
        if (err.message === 'Authentication cancelled.') {
            const login = 'Log in';
            void vscode.window.showWarningMessage(err.message, login).then((choice) => {
                if (choice === login) {
                    void vscode.commands.executeCommand(`${NAME}.login`);
                }
            });
            return;
        }

        // log to output channel (also reports to sentry)
        log.error(err);

        telemetry.metrics?.logError(err, source ? { source } : undefined);

        // handle auth errors
        if (/access token/.test(err.message)) {
            await auth.reset(`Auth Error: ${err.message}`);
        }

        void vscode.window.showErrorMessage(`PlayCanvas Error: ${err.message}`, 'Report Issue').then((choice) => {
            if (choice === 'Report Issue') {
                void vscode.commands.executeCommand(`${NAME}.reportIssue`, err.message);
            }
        });
    };

    const failure = signal<{ err: Error; source?: string } | undefined>(undefined);
    context.subscriptions.push(
        new vscode.Disposable(
            effect(() => {
                const f = failure.get();
                if (f) {
                    void handleError(f.err, f.source).catch((e) => log.error(e.message));
                }
            })
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.login`, async () => {
            const [err] = await tryCatch(auth.getAccessToken(true));
            if (err) {
                failure.set(() => ({ err, source: 'auth' }));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${NAME}.logout`, async () => {
            const [err] = await tryCatch(auth.logout());
            if (err) {
                failure.set(() => ({ err, source: 'auth' }));
            }
        })
    );

    // idle commands
    const registerIdle = () => {
        registerIdleCommands({ context, auth, rootUri, failure });
    };
    if (!projectWindow) {
        registerIdle();
        return;
    }

    // connection status bar item
    const connectionStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    context.subscriptions.push(connectionStatusItem);
    connectionStatusItem.color = COLORS.error;
    connectionStatusItem.text = `$(primitive-dot) Disconnected`;
    connectionStatusItem.tooltip = 'PlayCanvas Connection';

    const [err1, client] = await tryCatch(auth.getClient(false));
    if (err1) {
        registerIdle();
        connectionStatusItem.show();
        failure.set(() => ({ err: err1, source: 'auth' }));
        return;
    }
    if (!client) {
        registerIdle();
        connectionStatusItem.show();
        void tryCatch(auth.getAccessToken(true)).then(([err2]) => {
            if (err2) {
                failure.set(() => ({ err: err2, source: 'auth' }));
            }
        });
        return;
    }
    const { accessToken, rest, userId } = client;
    context.subscriptions.push(new vscode.Disposable(() => rest.dispose()));

    // metrics
    const metrics = new Metrics(accessToken);
    telemetry.metrics = metrics;
    context.subscriptions.push(metrics.disposable);
    metrics.increment('session.start', SESSION_DIMENSIONS);
    const heartbeat = setInterval(() => metrics.increment('session.heartbeat'), HEARTBEAT_MS);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(heartbeat)));

    // create events
    const events = new EventEmitter<EventMap>();
    context.subscriptions.push(
        new vscode.Disposable(() => {
            events.removeAllListeners();
        })
    );

    // realtime connection
    const sharedb = new ShareDb({
        url: REALTIME_URL,
        origin: HOME_URL
    });
    effect(() => {
        const err = sharedb.error.get();
        if (err) {
            failure.set(() => ({ err, source: 'sharedb' }));
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
            failure.set(() => ({ err, source: 'relay' }));
        }
    });

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

    // disk
    const typeInstaller = new TypeInstaller({ context });

    const disk = new Disk({
        events
    });
    effect(() => {
        const err = disk.error.get();
        if (err) {
            failure.set(() => ({ err, source: 'disk' }));
        }
    });

    // reload function
    let reloading = false;
    const reload = async (projectManager: ProjectManager, branchId?: string) => {
        if (reloading) {
            void vscode.window.showWarningMessage('Dropping reload request to avoid overlapping reloads');
            return false;
        }
        if (projectManager.unsafeFiles().length) {
            void vscode.window.showWarningMessage('PlayCanvas changes are not saved. Try again when saving finishes.');
            return false;
        }
        reloading = true;
        const [err] = await tryCatch(async () => {
            // unlink everything
            const uriState = await uriHandler.unlink();
            const collabState = await collabProvider.unlink();
            const dirtyState = await decorationProvider.unlink();
            const diskState = await disk.unlink();
            const projectState = await projectManager.unlink();

            // update branch id if provided (branch switch flow)
            projectState.branchId = branchId ?? projectState.branchId;

            // relink everything
            await projectManager.link(projectState);
            const config = await auth.getEditorConfig();
            const types = await typeInstaller.install({
                projectId: projectState.projectId,
                version: config.engineVersion
            });
            await disk.link({ ...diskState, types });
            await decorationProvider.link(dirtyState);
            await collabProvider.link(collabState);
            await uriHandler.link(uriState);
        });
        reloading = false;
        if (err) {
            throw err;
        }
        return true;
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
            failure.set(() => ({ err, source: 'uri-handler' }));
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
            failure.set(() => ({ err, source: 'collab-provider' }));
        }
    });
    context.subscriptions.push(vscode.window.registerTreeDataProvider('collab-view', collabProvider));
    const updateCollabTags = () => {
        const { same, other } = collabProvider.counts();
        setSentryCollaborators(same, other);
    };
    relay.on('room:join', updateCollabTags);
    relay.on('room:leave', updateCollabTags);

    // dirty decoration provider
    const decorationProvider = new DecorationProvider({ events });
    effect(() => {
        const err = decorationProvider.error.get();
        if (err) {
            failure.set(() => ({ err, source: 'dirty-decoration-provider' }));
        }
    });
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    const connected = computed(() => {
        return sharedb.connected.get() && messenger.connected.get() && relay.connected.get();
    });
    const services = [
        { service: 'sharedb', connected: sharedb.connected },
        { service: 'messenger', connected: messenger.connected },
        { service: 'relay', connected: relay.connected }
    ] as const;
    for (const { service, connected } of services) {
        let prev: boolean | null = null;
        let seen = false;
        effect(() => {
            const next = connected.get();
            if (prev !== null) {
                if (prev && !next) {
                    metrics.increment('connection.down', { service });
                }
                if (seen && !prev && next) {
                    metrics.increment('reconnect', { service });
                }
            }
            if (next) {
                seen = true;
            }
            prev = next;
        });
    }
    effect(() => {
        const enabled = connected.get();
        connectionStatusItem.color = enabled ? COLORS.success : COLORS.error;
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
    const pingSampler = setInterval(() => {
        const m = messenger.ping.get();
        const r = relay.ping.get();
        if (m > 0) {
            metrics.addTimer('ws.ping', m, { service: 'messenger' });
        }
        if (r > 0) {
            metrics.addTimer('ws.ping', r, { service: 'relay' });
        }
    }, PING_SAMPLE_MS);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(pingSampler)));

    // collision status bar item — hidden until collisions.count > 0
    const collisionStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -9999);
    context.subscriptions.push(collisionStatusItem);
    collisionStatusItem.color = COLORS.warning;
    collisionStatusItem.command = `${NAME}.showPathCollisions`;
    collisionStatusItem.tooltip = 'PlayCanvas Asset Path Collisions';

    // desync status bar item — hidden until project.desync flips true
    const desyncStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    context.subscriptions.push(desyncStatusItem);
    desyncStatusItem.color = COLORS.warning;
    desyncStatusItem.command = `${NAME}.reloadProject`;
    desyncStatusItem.text = '$(warning) Out of Sync';
    desyncStatusItem.tooltip = 'PlayCanvas project is out of sync — click to reload';

    // branch status bar item
    const branchStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
    context.subscriptions.push(branchStatusBarItem);
    branchStatusBarItem.command = `${NAME}.switchBranch`;
    branchStatusBarItem.text = `$(git-branch) no branch`;
    branchStatusBarItem.tooltip = 'Switch Branch';

    // watch for version control changes
    const branchSwitch = messenger.on('branch.switch', async (e) => {
        const [err] = await tryCatch(async () => {
            const { project_id, branch_id, name } = e.data;

            // fetch project and disk from cache
            const { projectManager } = cache.get(project_id) ?? {};
            if (!projectManager) {
                return;
            }

            metrics.increment('branch.switch');
            const branchSwitchDone = await simpleNotification(`Switching to branch ${name}...`);

            // reload project
            const [err1, reloaded] = await tryCatch(reload(projectManager, branch_id));
            branchSwitchDone();
            if (err1) {
                throw err1;
            }
            if (!reloaded) {
                return;
            }

            // update cache
            cache.set(project_id, { branchId: branch_id, projectManager });

            // update branch status bar item
            branchStatusBarItem.text = `$(git-branch) ${name}`;
            branchStatusBarItem.show();
        });
        if (err) {
            failure.set(() => ({ err, source: 'messenger' }));
        }
    });
    const branchClose = messenger.on('branch.close', async (e) => {
        const [err] = await tryCatch(async () => {
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
                throw fail`Failed to find main branch to switch to`;
            }

            // checkout main branch
            // NOTE: branch switch flow continues in messenger event above
            await rest.branchCheckout(main.id);
        });
        if (err) {
            failure.set(() => ({ err, source: 'messenger' }));
        }
    });
    const checkpointRestore = async (data: {
        project_id: number;
        branch_id: string;
        checkpoint_id: string;
        status: 'success' | 'error';
    }) => {
        const [err] = await tryCatch(async () => {
            const { project_id, branch_id, checkpoint_id, status } = data;

            // check status
            if (status !== 'success') {
                throw fail`Failed to restore to checkpoint ${checkpoint_id}`;
            }

            // fetch project and disk from cache
            const { projectManager, branchId } = cache.get(project_id) ?? {};
            if (!projectManager) {
                return;
            }
            if (branchId !== branch_id) {
                return;
            }

            const checkpointDone = await simpleNotification(`Restoring to checkpoint ${checkpoint_id}. Reloading...`);

            // reload project
            const [err1, reloaded] = await tryCatch(reload(projectManager));
            checkpointDone();
            if (err1) {
                throw err1;
            }
            if (!reloaded) {
                return;
            }
        });
        if (err) {
            failure.set(() => ({ err, source: 'messenger' }));
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

    // project commands
    const commandReload = signal<{ projectManager: ProjectManager } | undefined>(undefined);
    registerProjectCommands({
        context,
        rootUri,
        userId,
        rest,
        metrics,
        state,
        cache,
        reload: commandReload,
        failure
    });
    context.subscriptions.push(
        new vscode.Disposable(
            effect(() => {
                const req = commandReload.get();
                if (req) {
                    void simpleNotification('Reloading project...').then(async (reloadDone) => {
                        const [err] = await tryCatch(reload(req.projectManager));
                        reloadDone();
                        if (err) {
                            failure.set(() => ({ err, source: 'commands' }));
                        }
                    });
                }
            })
        )
    );

    // load project
    const [projectsErr, projects] = await tryCatch(rest.userProjects(userId, 'profile'));
    if (projectsErr) {
        failure.set(() => ({ err: projectsErr, source: 'rest' }));
        return;
    }
    const valid: [vscode.WorkspaceFolder, Project][] = folders.reduce(
        (list, f) => {
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
    if (valid.length === 0) {
        const msg = 'This PlayCanvas workspace is not available for the current account.';
        const login = 'Log in';
        const open = 'Open Project';

        connectionStatusItem.text = `$(primitive-dot) Not Available`;
        connectionStatusItem.tooltip = msg;
        connectionStatusItem.show();
        void vscode.window.showWarningMessage(msg, login, open).then((choice) => {
            switch (choice) {
                case login: {
                    void vscode.commands.executeCommand(`${NAME}.login`);
                    break;
                }
                case open: {
                    void vscode.commands.executeCommand(`${NAME}.openProject`);
                    break;
                }
            }
        });
        return;
    }

    for (const [folder, project] of valid) {
        connectionStatusItem.show();

        // ensure folder directory exists
        await vscode.workspace.fs.createDirectory(folder.uri);

        // connect sharedb, messenger, relay if not connected
        if (!sharedb.connected.get()) {
            const [err] = await tryCatch(sharedb.connect(() => accessToken));
            if (err) {
                sharedb.disconnect();
                failure.set(() => ({ err, source: 'sharedb' }));
                return;
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
                failure.set(() => ({ err, source: 'messenger' }));
                return;
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
                failure.set(() => ({ err, source: 'relay' }));
                return;
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
            failure.set(() => ({
                err: fail`Failed to load project settings for project ${project.id}`,
                source: 'sharedb'
            }));
            return;
        }
        context.subscriptions.push(
            new vscode.Disposable(() => {
                void sharedb.unsubscribe('settings', `project_${project.id}_${userId}`);
            })
        );
        const branchId = doc.data?.branch ?? '';

        // fetch project branches
        const branches = await rest.projectBranches(project.id);
        const branch = branches.find((b) => b.id === branchId);
        if (branch) {
            // set branch name
            branchStatusBarItem.text = `$(git-branch) ${branch.name}`;
            branchStatusBarItem.show();
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
                failure.set(() => ({ err, source: 'project-manager' }));
            }
        });
        effect(() => {
            const count = projectManager.collisions.count.get();
            if (count > 0) {
                collisionStatusItem.text = `$(warning) Path Collisions: ${count}`;
                collisionStatusItem.show();
            } else {
                collisionStatusItem.hide();
            }
        });

        // store in cache early so messenger events during loading can find it
        cache.set(project.id, { branchId, projectManager });

        // notify sentry of project and branch for better error context
        setSentryProject(project.id, branchId);

        // link project manager (loads project)
        const t0 = Date.now();
        await projectManager.link({
            projectId: project.id,
            branchId: branchId
        });
        metrics.addTimer('project.load', Date.now() - t0);
        metrics.addHistogram('project.assets', projectManager.files.size - 1);
        context.subscriptions.push(
            new vscode.Disposable(() => {
                void projectManager.unlink();
            })
        );

        const folderUri = vscode.Uri.joinPath(rootUri, projectToName(project));
        const editorConfig = await auth.getEditorConfig();
        const types = await typeInstaller.install({
            projectId: project.id,
            version: editorConfig.engineVersion
        });

        // mount disk
        await disk.link({
            folderUri,
            projectManager,
            types
        });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                void disk.unlink();
            })
        );

        // link dirty decoration provider
        await decorationProvider.link({ folderUri, projectManager });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                void decorationProvider.unlink();
            })
        );

        // desync surfaces — sticky status-bar item + one-shot toast per
        // false→true transition. signal resets to false on project unlink.
        effect(() => {
            const desynced = projectManager.desync.get();
            if (desynced) {
                desyncStatusItem.show();
            } else {
                desyncStatusItem.hide();
                desyncStatusItem.command = `${NAME}.reloadProject`;
                desyncStatusItem.tooltip = 'PlayCanvas project is out of sync — click to reload';
                return;
            }

            if (projectManager.saveFailed()) {
                desyncStatusItem.command = `${NAME}.reportIssue`;
                desyncStatusItem.tooltip = 'PlayCanvas could not save changes — click to report';
                void vscode.window
                    .showWarningMessage('PlayCanvas could not save changes.', 'Report Issue')
                    .then((choice) => {
                        if (choice === 'Report Issue') {
                            void vscode.commands.executeCommand(
                                `${NAME}.reportIssue`,
                                'PlayCanvas could not save changes'
                            );
                        }
                    });
                return;
            }

            desyncStatusItem.command = `${NAME}.reloadProject`;
            desyncStatusItem.tooltip = 'PlayCanvas project is out of sync — click to reload';
            void vscode.window
                .showWarningMessage(
                    'PlayCanvas project is out of sync. Reload to recover.',
                    'Reload project',
                    'Report Issue'
                )
                .then((choice) => {
                    switch (choice) {
                        case 'Reload project': {
                            void vscode.commands.executeCommand(`${NAME}.reloadProject`);
                            break;
                        }
                        case 'Report Issue': {
                            void vscode.commands.executeCommand(`${NAME}.reportIssue`, 'Out of sync');
                            break;
                        }
                    }
                });
        });

        // disable autosave for playcanvas workspace — autosave interferes
        // with realtime collaborative editing
        const disableAutosave = () => {
            const f = vscode.workspace.getConfiguration('files');
            if (f.get('autoSave') !== 'off') {
                log.debug('disabling files.autoSave for workspace');
                void f.update('autoSave', 'off', vscode.ConfigurationTarget.Workspace);
            }
        };
        // force LF — OT canonical state is always LF, and native CRLF saves
        // cause false "diverged" readings on reopen that overwrite collaborator edits
        const forceLF = () => {
            const f = vscode.workspace.getConfiguration('files');
            if (f.get('eol') !== '\n') {
                log.debug('forcing files.eol to LF for workspace');
                void f.update('eol', '\n', vscode.ConfigurationTarget.Workspace);
            }
        };
        disableAutosave();
        forceLF();
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('files.autoSave')) {
                    disableAutosave();
                }
                if (e.affectsConfiguration('files.eol')) {
                    forceLF();
                }
            })
        );

        // link collab provider
        await collabProvider.link({
            folderUri,
            projectManager
        });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                void collabProvider.unlink();
            })
        );

        // link uri handler
        await uriHandler.link({
            folderUri,
            projectManager
        });
        context.subscriptions.push(
            new vscode.Disposable(() => {
                void uriHandler.unlink();
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
