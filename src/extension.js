// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const CloudStorageProvider = require('./cloudStorageProvider');

let fileProvider;

async function selectProject(fileProvider) {
	const projects = await fileProvider.fetchProjects();

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
	const names = projects.map(project => project.name );
	const project = await vscode.window.showQuickPick(names, { placeHolder: 'Select a project' });
	if (project) {
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

async function runSequentially(tasks) {
	for (const task of tasks) {
	  	await task;
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {

	if (!fileProvider) {
		fileProvider = new CloudStorageProvider(context);
	}
	
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('playcanvas', fileProvider, { isCaseSensitive: true }));

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
				// await fileProvider.fetchAssets(project);

				const start = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
				await vscode.workspace.updateWorkspaceFolders(start, 0, { uri: vscode.Uri.parse(`playcanvas:/${project.name}`), name: `${project.name}` });

				// refresh the folder after delay on timer
				setTimeout(async () => {
					console.log('Refreshing folder');
					await fileProvider.refreshProject(project);

					// Refresh the tree view to reflect the file rename.
					vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

					vscode.window.visibleTextEditors.forEach(editor => {
						if (editor.document.uri.scheme === 'playcanvas') {
							fileProvider.refreshUri(editor.document.uri);			
						}
					});

				}, 100);
			}
		} catch (error) {
			console.error('Add Project failed:', error);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('playcanvas.pullLatest', async (item) => {
		try {
			await fileProvider.pullLatest(item.path);

			// Refresh the tree view to reflect the file rename.
			vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

			vscode.window.visibleTextEditors.forEach(editor => {
				if (editor.document.uri.scheme === 'playcanvas') {
					fileProvider.refreshUri(editor.document.uri);			
				}
			});
		} catch (error) {
			console.error('Pull latest failed:', error);
		}		
	}));

	context.subscriptions.push(vscode.commands.registerCommand('playcanvas.switchBranch', async (item) => {

		try {

			const project = await fileProvider.getProject(item.path);
			const branches = await fileProvider.fetchBranches(project);

			const prevBranch = project.branchId ? (branches.find( b => b.id === project.branchId )).name : 'main';
			const names = branches.map(branch => branch.name );

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
					vscode.window.showInformationMessage(`Switched to branch ${branch}`);
					await fileProvider.refreshProject(project);
					vscode.commands.executeCommand('workbench.action.closeAllEditors');
					vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
				}
			}
		} catch (error) {
			console.error('Error during switching branches:', error);
		}
	}));

	try {
		const token = await context.secrets.get('playcanvas.accessToken');
			
		if (token) {
			await fileProvider.fetchUserId();
			await fileProvider.fetchProjects();

			// preload projects
			let promises = [];
			let folders = vscode.workspace.workspaceFolders;
			if (folders) {
				for (let folder of folders) {
					if (folder.uri.scheme.startsWith('playcanvas')) {
						const project = fileProvider.getProjectByName(folder.name);
						if (project) {
							let projectPromises = [];
							const branch = fileProvider.getBranchByFolderName(folder.name);
							if (branch != 'main') {
								projectPromises.push(fileProvider.fetchBranches(project));
								projectPromises.push(fileProvider.switchBranch(project, branch));
							}
							projectPromises.push(fileProvider.fetchAssets(project));
							promises.push(runSequentially(projectPromises));
						}
					}
				}
			}
			await Promise.all(promises);
		}

	} catch (err) {
		console.error('error during activation:', err);
		throw err;
	}

	console.log('playcanvas: Congratulations, your extension "playcanvas" is now active!');
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
