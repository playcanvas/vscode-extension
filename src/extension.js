// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const CloudStorageProvider = require('./cloudStorageProvider');

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

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('playcanvas: Congratulations, your extension "playcanvas" is now active!');

	try {

		const fileProvider = new CloudStorageProvider();
		context.subscriptions.push(vscode.workspace.registerFileSystemProvider('playcanvas', fileProvider, { isCaseSensitive: true }));

		await fileProvider.fetchProjects();

		// Register a command to open a workspace that uses your file system provider
		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.addProject', async (item) => {

			const project = await selectProject(fileProvider);
			if (project) {
				vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, 0, { uri: vscode.Uri.parse(`playcanvas:/${project.name}`), name: `${project.name}` });
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.switchBranch', async (item) => {
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
					await fileProvider.switchBranch(project, branch);
					vscode.window.showInformationMessage(`Switched to branch ${branch}`);
					
					// Refresh the tree view to reflect the file rename.
					await fileProvider.refreshProject(project);
					vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
				}				
			}
		}));
		
	} catch (error) {
		console.error('Failed to activate extension:', error);
	}
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
