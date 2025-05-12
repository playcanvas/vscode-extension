// @ts-nocheck
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import CloudStorageProvider from './cloudStorageProvider.js';
import ProjectDataProvider from './projectDataProvider.js';

const vscode = require('vscode');

let fileProvider;
let projectDataProvider;
let workspaceFolderChangeListener;
let outputChannel;
let statusBar;
let currentProject;

async function selectProject(fileProvider) {
    const projects = await fileProvider.fetchProjects(true);

    // find most recently modified
    projects.sort((a, b) => {
        if (a.modified < b.modified) {
            return 1;
        }

        if (a.modified > b.modified) {
            return -1;
        }

        return 0;
    });

    if (projects.length === 0) {
        return [];
    }

    const names = projects.map(project => project.name);
    const project = await vscode.window.showQuickPick(names, { placeHolder: 'Select a project' });
    if (project) {

        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
            for (const folder of folders) {
                if (folder.name === project) {
                    vscode.window.showErrorMessage('Project with identical name already added. Please rename.');
                    return;
                }
            }
        }
        // cache projects
        fileProvider.setProjects(projects);

        return projects.find(p => p.name === project);
    }
}

function renameWorkspaceFolder(oldName, newName) {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) return;

    const folder = workspaceFolders.find(folder => folder.name === oldName);
    if (!folder) {
        vscode.window.showErrorMessage(`Folder named ${oldName} not found.`);
        return;
    }

    const folderUri = folder.uri;
    const newUri = folderUri.with({ path: folderUri.path.replace(oldName, newName) });

    // Remove old folder and add new folder
    vscode.workspace.updateWorkspaceFolders(folder.index, 1, { uri: newUri, name: newName });
}

function displaySearchResults(results) {
    const config = vscode.workspace.getConfiguration('playcanvas');
    const maxSearchResults = config.get('maxSearchResults');

    let count = 0;
    for (const result of results) {
        let filePath = result.uri.fsPath;
        const line = result.line;
        if (count < maxSearchResults) {

            // reverse the slashes for windows
            if (process.platform === 'win32') {
                filePath = filePath.replace(/\\/g, '/');
            }
            outputChannel.appendLine(`${filePath}:${line} - ${result.lineText}`);
        }
        count += 1;
    }

    if (results.length) {
        outputChannel.appendLine('');
    }

    if (count === maxSearchResults) {
        outputChannel.appendLine(`Done. Displaying first ${maxSearchResults} results.`);
    } else {
        outputChannel.appendLine(`Done. Found ${results.length} results.`);
    }
}

async function updateStatusBarItem(statusBarItem, uri) {

    if (uri) {
        currentProject = fileProvider.getProject(uri.path);
        if (currentProject) {
            const projectUri = fileProvider.getProjectUri(currentProject);
            const data = projectDataProvider.getWorkspaceData(projectUri.path);
            const branchName = data ? data.branch : await fileProvider.getProjectBranchName(currentProject);
            statusBarItem.text = `$(git-branch) ${currentProject.name}: ${branchName}`;
            statusBarItem.show();
        }
    } else {
        statusBarItem.hide();
    }
}

async function switchBranch(project) {
    if (!project) {
        return;
    }

    try {
        const branches = await fileProvider.fetchBranches(project);

        const prevBranch = project.branchId ? (branches.find(b => b.id === project.branchId)).name : 'main';
        const names = branches.map(branch => branch.name);

        // put current branch on the first place in the list
        const index = names.indexOf(prevBranch);
        if (index !== -1) {
            names.splice(index, 1);
            names.unshift(prevBranch);
        }

        const branch = await vscode.window.showQuickPick(names, { placeHolder: 'Select a branch to switch to' });

        if (branch) {

            // switch to the selected branch
            if (prevBranch !== branch) {
                fileProvider.switchBranch(project, branch);
                const projectUri = fileProvider.getProjectUri(project);
                projectDataProvider.setWorkspaceData(projectUri.path, {
                    branch: branch
                });
                vscode.window.showInformationMessage(`Switched to branch ${branch}`);
                await fileProvider.refreshProject(project);

                // update status bar
                updateStatusBarItem(statusBar, projectUri);

                vscode.commands.executeCommand('workbench.action.closeAllEditors');
                vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            }
        }
    } catch (error) {
        console.error('Error during switching branches:', error);
    }
}

/**
 * Activates the PlayCanvas extension.
 * @param {vscode.ExtensionContext} context - The extension context provided by VS Code.
 */
function activate(context) {
    projectDataProvider = new ProjectDataProvider(context);
    vscode.window.registerTreeDataProvider('PlayCanvasView', projectDataProvider);

    if (!fileProvider) {
        fileProvider = new CloudStorageProvider(context, projectDataProvider);
    }

    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('playcanvas', fileProvider, { isCaseSensitive: true }));

    // display the current branch in the status bar
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'playcanvas.switchBranch';
    context.subscriptions.push(statusBar);

    updateStatusBarItem(statusBar);

    // Update status bar on editor change
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document) {
            updateStatusBarItem(statusBar, editor.document.uri);
        }
    }));

    // Function to handle new workspace folder
    const handleNewWorkspaceFolder = (workspaceFolder) => {
        console.log(`New workspace folder added: ${workspaceFolder.uri.fsPath}`);
        // Add your initialization or sync logic here

    };

    // Event listener for workspace folder changes
    workspaceFolderChangeListener = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        if (event.added.length > 0) {
            event.added.forEach(handleNewWorkspaceFolder);
        }
    });

    // Ensure the listener is disposed when the extension is deactivated
    context.subscriptions.push(workspaceFolderChangeListener);

    // Register a command to open a workspace that uses your file system provider
    context.subscriptions.push(vscode.commands.registerCommand('playcanvas.addProject', async (item) => {
        try {
            const token = await fileProvider.api.getToken();

            if (!token) {
                vscode.window.showErrorMessage('Please generate your PlayCanvas access token.');
                return;
            }

            const project = await selectProject(fileProvider);
            if (project) {
                // refresh the folder after delay on timer
                await fileProvider.refreshProject(project);

                const currentBranch = await fileProvider.getProjectBranchName(project);
                const start = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;

                const projectUri = fileProvider.getProjectUri(project);
                await vscode.workspace.updateWorkspaceFolders(start, 0, { uri: projectUri, name: `${project.name}` });

                projectDataProvider.setWorkspaceData(projectUri.path, {
                    branch: currentBranch
                });

                // Refresh the tree view to reflect the file rename.
                vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            }
        } catch (error) {
            console.error('Add Project failed:', error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('playcanvas.pullLatest', async (item) => {
        try {

            if (!item) {

                // get path from the active file
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    item = editor.document.uri;
                } else {
                    // show warning if no project is selected
                    vscode.window.showWarningMessage('Please use the command "PlayCanvas: Pull Latest" from the context menu.');
                    return;
                }
            }

            await fileProvider.pullLatest(item.path);

            // Refresh the tree view to reflect the file rename.
            vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

            vscode.window.visibleTextEditors.forEach((editor) => {
                if (editor.document.uri.scheme === 'playcanvas') {
                    fileProvider.refreshUri(editor.document.uri);
                }
            });
        } catch (error) {
            console.error('Pull latest failed:', error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('playcanvas.switchBranch', async (item) => {
        if (!item) {

            // get path from the active file
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                item = editor.document.uri;
            } else {
                // show warning if no project is selected
                vscode.window.showWarningMessage('Please use the command "PlayCanvas: Switch Branch" from the context menu.');
                return;
            }
        }
        switchBranch(item ? await fileProvider.getProject(item.path) : currentProject);
        updateStatusBarItem(statusBar);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('playcanvas.search', async () => {

        // Get the currently selected text
        const editor = vscode.window.activeTextEditor;
        let project;
        let selectedText = '';
        let selectedPath;

        if (editor) {
            const selection = editor.selection;
            const document = editor.document;
            selectedText = document.getText(selection);
            const uri = document.uri;
            project = fileProvider.getProject(uri.path);
            if (project) {
                selectedPath = fileProvider.getProjectUri(project);
            }
        }

        const searchPattern = await vscode.window.showInputBox({ prompt: 'Enter search pattern', value: selectedText });
        if (!searchPattern) {
            return;
        }

        if (searchPattern.length < 3) {
            vscode.window.showErrorMessage('Search pattern must be at least 3 characters long.');
            return;
        }

        if (!outputChannel) {
            outputChannel = vscode.window.createOutputChannel('PlayCanvas File Search');
        } else {
            outputChannel.clear();
        }

        outputChannel.show();

        if (project) {
            outputChannel.appendLine(`Searching for '${searchPattern}' in ${project.name}...`);
        } else {
            outputChannel.appendLine(`Searching for '${searchPattern}'...`);
        }
        outputChannel.appendLine('');

        const results = await fileProvider.searchFiles(searchPattern, selectedPath);

        displaySearchResults(results);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('playcanvas.findInFolder', async (item) => {
        // Get the currently selected text
        const editor = vscode.window.activeTextEditor;
        let selectedText = '';
        if (editor) {
            const selection = editor.selection;
            selectedText = editor.document.getText(selection);
        }

        const searchPattern = await vscode.window.showInputBox({ prompt: 'Enter search pattern', value: selectedText });
        if (!searchPattern) {
            return;
        }

        if (!outputChannel) {
            outputChannel = vscode.window.createOutputChannel('PlayCanvas File Search');
        } else {
            outputChannel.clear();
        }

        outputChannel.show();

        outputChannel.appendLine(`Searching for '${searchPattern}' in ${item.path}...`);
        outputChannel.appendLine('');

        const results = await fileProvider.searchFiles(searchPattern, item);

        displaySearchResults(results);
    }));

    fileProvider.getToken().catch((err) => {
        vscode.window.showInformationMessage(`Failed to authorize. Error: ${err.message}`);
    });

    console.log('playcanvas: Congratulations, your extension "playcanvas" is now active!');
}

// This method is called when your extension is deactivated
function deactivate() {
    if (workspaceFolderChangeListener) {
        workspaceFolderChangeListener.dispose();
    }
}

module.exports = {
    activate,
    deactivate
};
