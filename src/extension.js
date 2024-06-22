// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const CloudStorageProvider = require('./cloudStorageProvider');

let fileProvider;
let workspaceFolderChangeListener;
let outputChannel;

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

function displaySearchResults(results) {
	const config = vscode.workspace.getConfiguration('playcanvas');
	const maxSearchResults = config.get('maxSearchResults');

	let count = 0;
	for (const result of results) {
		const filePath = result.uri.fsPath;
		const line = result.line;
		if (count < maxSearchResults) {
			if (process.platform === 'win32') {
				outputChannel.appendLine(`/${filePath.substring(1)}:${line} - ${result.lineText}`);
			} else {
				outputChannel.appendLine(`${filePath}:${line} - ${result.lineText}`);
			}
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

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {

	if (!fileProvider) {
		fileProvider = new CloudStorageProvider(context);
	}
	
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('playcanvas', fileProvider, { isCaseSensitive: true }));

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

				const start = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
				await vscode.workspace.updateWorkspaceFolders(start, 0, { uri: fileProvider.getProjectUri(project), name: `${project.name}` });

				// Refresh the tree view to reflect the file rename.
				vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
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

		const searchPattern = await vscode.window.showInputBox({ prompt: 'Enter search pattern', value: selectedText  });
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

		const searchPattern = await vscode.window.showInputBox({ prompt: 'Enter search pattern', value: selectedText  });
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

	fileProvider.getToken().catch(err => {
		vscode.window.showInformationMessage('Failed to authorize. Error: ' + err.message);
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
}
