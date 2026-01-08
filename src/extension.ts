import * as vscode from 'vscode';

import { Auth } from './auth';
import { API_URL, DEBUG, ENV, HOME_URL, MESSENGER_URL, REALTIME_URL, RELAY_URL, ROOT_FOLDER } from './config';
import { Messenger } from './connections/messenger';
import { Relay } from './connections/relay';
import { Rest } from './connections/rest';
import { ShareDb } from './connections/sharedb';
import { Disk } from './disk';
import { UriHandler } from './handlers/uri-handler';
import { simpleNotification } from './notification';
import { ProjectManager } from './project-manager';
import { CollabProvider } from './providers/collab-provider';
import type { EventMap } from './typings/event-map';
import type { Project } from './typings/models';
import { EventEmitter } from './utils/event-emitter';
import { computed, effect } from './utils/signal';
import { projectToName, uriStartsWith } from './utils/utils';

export const activate = async (context: vscode.ExtensionContext) => {
    // ! defer by 1 tick to allow for tests to stub modules before extension loads
    await new Promise((resolve) => setTimeout(resolve, 0));

    // load config
    const config = vscode.workspace.getConfiguration('playcanvas');
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration('playcanvas')) {
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
    context.subscriptions.push(
        vscode.commands.registerCommand('playcanvas.login', async () => auth.getAccessToken(true))
    );
    const accessToken = await auth.getAccessToken();

    // error handler
    const handleError = async (error?: Error) => {
        if (!error) {
            return;
        }

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
        debug: DEBUG,
        url: API_URL,
        origin: HOME_URL,
        accessToken
    });
    effect(() => handleError(rest.error.get()));

    // realtime connection
    const sharedb = new ShareDb({
        debug: DEBUG,
        url: REALTIME_URL,
        origin: HOME_URL
    });
    effect(() => handleError(sharedb.error.get()));

    // messenger
    const messenger = new Messenger({
        debug: DEBUG,
        url: MESSENGER_URL,
        origin: HOME_URL
    });

    // relay
    const relay = new Relay({
        debug: DEBUG,
        url: RELAY_URL,
        origin: HOME_URL
    });
    effect(() => handleError(relay.error.get()));

    // find user id
    const userId = await rest.id();

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
        debug: DEBUG,
        events
    });

    const reload = async (projectManager: ProjectManager, branchId?: string) => {
        const diskState = await disk.unlink();
        const projectState = await projectManager.unlink();
        projectState.branchId = branchId ?? projectState.branchId;

        // TODO: figure out why this is needed to avoid ShareDB issues
        await new Promise((resolve) => setTimeout(resolve, 1000));

        await projectManager.link(projectState);
        await disk.link(diskState);
    };

    // uri handler
    const uriHandler = new UriHandler({
        context,
        rootUri,
        userId,
        rest
    });
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

    // collab provider
    const collabProvider = new CollabProvider({
        debug: DEBUG,
        events,
        relay,
        rest
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
    connectionStatusItem.tooltip = 'PlayCanvas Connection Status';
    connectionStatusItem.show();
    const connected = computed(() => {
        return sharedb.connected.get() && messenger.connected.get() && relay.connected.get();
    });
    effect(() => {
        const enabled = connected.get();
        connectionStatusItem.color = enabled ? connectionStatusColors.connected : connectionStatusColors.disconnected;
        connectionStatusItem.text = `$(primitive-dot) ${enabled ? 'Connected' : 'Disconnected'}`;
    });

    // branch status bar item
    const branchStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
    context.subscriptions.push(branchStatusBarItem);
    branchStatusBarItem.command = 'playcanvas.switchBranch';
    branchStatusBarItem.text = `$(git-branch) no branch`;
    branchStatusBarItem.tooltip = 'Switch Branch';
    branchStatusBarItem.show();

    // watch for version control changes
    const branchSwitch = messenger.on('branch.switch', async (e) => {
        const { project_id, branch_id, name } = e.data;

        // fetch project and disk from cache
        const { projectManager } = cache.get(project_id) ?? {};
        if (!projectManager) {
            return;
        }

        const branchSwitchDone = await simpleNotification(`Switching to branch ${name}...`);

        // reload project
        await reload(projectManager, branch_id);

        // update cache
        cache.set(project_id, { branchId: branch_id, projectManager });

        // update branch status bar item
        branchStatusBarItem.text = `$(git-branch) ${name}`;

        branchSwitchDone();
    });
    const branchClose = messenger.on('branch.close', async (e) => {
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
            handleError(new Error(`Failed to find main branch to switch to`));
            return;
        }

        // checkout main branch
        // NOTE: branch switch flow continues in messenger event above
        await rest.branchCheckout(main.id);
    });
    const checkpointRestore = async (data: {
        project_id: number;
        branch_id: string;
        checkpoint_id: string;
        status: 'success' | 'error';
    }) => {
        const { project_id, branch_id, checkpoint_id, status } = data;

        // check status
        if (status !== 'success') {
            handleError(new Error(`Failed to restore to checkpoint ${checkpoint_id}`));
            return;
        }

        // fetch project and disk from cache
        const { projectManager, branchId } = cache.get(project_id) ?? {};
        if (!projectManager) {
            return;
        }
        if (branchId !== branch_id) {
            return;
        }

        const checkpointRestore = await simpleNotification(`Restoring to checkpoint ${checkpoint_id}. Reloading...`);

        // reload project
        await reload(projectManager);

        checkpointRestore();
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
        vscode.commands.registerCommand('playcanvas.openProject', async () => {
            // fetch all user projects
            const projects = await rest.userProjects(userId, 'profile');

            // show picker
            const list = projects.map((p) => projectToName(p)).reverse();
            const chosen = await vscode.window.showQuickPick(list, {
                placeHolder: 'Select a project'
            });
            const project = projects.find((p) => chosen === projectToName(p));
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
        vscode.commands.registerCommand('playcanvas.reloadProject', async () => {
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
            await reload(projectManager);

            reloadDone();
        })
    );

    // switch branch
    context.subscriptions.push(
        vscode.commands.registerCommand('playcanvas.switchBranch', async () => {
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
            await sharedb.connect(accessToken);
            context.subscriptions.push(
                new vscode.Disposable(() => {
                    sharedb.disconnect();
                })
            );
        }
        if (!messenger.connected.get()) {
            await messenger.connect(accessToken);
            context.subscriptions.push(
                new vscode.Disposable(() => {
                    messenger.disconnect();
                })
            );
        }
        if (!relay.connected.get()) {
            await relay.connect(accessToken);
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
            debug: DEBUG,
            events,
            sharedb,
            messenger,
            relay,
            rest
        });
        effect(() => handleError(projectManager.error.get()));
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
            projectManager,
            openFilePath: await uriHandler.getOpenFilePath(folderUri)
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

        // store in cache
        cache.set(project.id, { branchId, projectManager });
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
