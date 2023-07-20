// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const TreeDataProvider = require('./treeDataProvider');
const CloudStorageProvider = require('./cloudStorageProvider');
const path = require('path');
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

let copiedFile = null;
let cutFile = null;

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "playcanvas" is now active!');

	try {

		const fileProvider = new CloudStorageProvider();
		context.subscriptions.push(vscode.workspace.registerFileSystemProvider('playcanvas', fileProvider, { isCaseSensitive: true }));

		const treeDataProvider = new TreeDataProvider(fileProvider);
		const treeView = vscode.window.createTreeView('PlayCanvasExplorer', { treeDataProvider: treeDataProvider });

		treeView.onDidChangeSelection(async e => {
			try {
				if (e.selection && e.selection.length > 0) {
					const selectedItem = e.selection[0];
					// Now you can do something with the selected item.
					// For example, open it in a new editor tab:
					if (!selectedItem.project && selectedItem.contextValue !== 'folder') {
						const uri = vscode.Uri.parse(`playcanvas:/${selectedItem.path}`);
						vscode.commands.executeCommand('vscode.open', uri);
					}
				}
			} catch (error) {
				console.log(error);
			}
		});

		treeView.onDidExpandElement(async e => {
			treeDataProvider.onElementExpanded(e.element.path);
		});

		treeView.onDidCollapseElement(async e => {
			treeDataProvider.onElementCollapsed(e.element);
		});

		context.subscriptions.push(treeView);

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.refresh', (item) => {
			vscode.commands.executeCommand('workbench.actions.treeView.PlayCanvasExplorer.collapseAll');
			fileProvider.refresh();
			treeDataProvider.refresh();
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.collapseAll', (item) => {
			vscode.commands.executeCommand('workbench.actions.treeView.PlayCanvasExplorer.collapseAll');
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.switchBranch', async (item) => {
			const projectUri = vscode.Uri.parse(`playcanvas:/${item.path}`);
			const project = await fileProvider.getProject(projectUri.path);
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
					fileProvider.refreshProject(project);
					treeDataProvider.refresh();

					// refresh all currently opened files
					vscode.commands.executeCommand('workbench.action.closeAllEditors');					
					treeView.reveal(item, { select: true, focus: true });
				}				
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.newFile', async (item) => {
			// Prompt the user for the new name.
			const name = await vscode.window.showInputBox({
				prompt: 'Enter the name'
			});

			if (name) {
				const folderUri = vscode.Uri.parse(`playcanvas:/${item.path}`);
				
				// Construct the new Uri using the folder path and new name
				try {
					await fileProvider.createFile(name, folderUri);
					vscode.window.showInformationMessage('File created successfully');
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to create a file: ${error.message}`);
				}
				
				// Refresh the tree view to reflect the file rename.
				fileProvider.refreshProject(fileProvider.getProject(folderUri.path));
				treeDataProvider.refresh();		
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.newFolder', async (item) => {
			// Prompt the user for the new name.
			const name = await vscode.window.showInputBox({
				prompt: 'Enter the name'
			});

			if (name) {
				const folderUri = vscode.Uri.parse(`playcanvas:/${item.path}`);
				
				// Construct the new Uri using the folder path and new name
				try {
					await fileProvider.createFile(name, folderUri, 'folder');
					vscode.window.showInformationMessage('File created successfully');
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to create a file: ${error.message}`);
				}
				
				// Refresh the tree view to reflect the file rename.
				fileProvider.refreshProject(fileProvider.getProject(folderUri.path));
				treeDataProvider.refresh();		
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.copy', (item) => {
			copiedFile = item.path;
			cutFile = null;
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.cut', (item) => {
			copiedFile = null;
			cutFile = item.path;
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.paste', async (item) => {
			const file = copiedFile || cutFile;
			if (!file) {
				vscode.window.showErrorMessage('No file copied');
				return;
			}

			const uri = vscode.Uri.parse(`playcanvas:/${file}`);
			const targetUri = vscode.Uri.parse(`playcanvas:/${item.path}/${path.basename(file)}`);
			try {
				// create a copy of the file in a new location
				await vscode.workspace.fs.copy(uri, targetUri);

				if (cutFile) {
					// delete original file
					await vscode.workspace.fs.delete(uri, {recursive: true, useTrash: false});
				} 

				vscode.window.showInformationMessage('File pasted successfully');
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to paste file: ${error.message}`);
				copiedFile = null;
				cutFile = null;
			}

			// Refresh the tree view
			if (cutFile) {
				fileProvider.refreshProject(fileProvider.getProject(uri.path));
			}
			fileProvider.refreshProject(fileProvider.getProject(targetUri.path));
			treeDataProvider.refresh();				

			copiedFile = null;
			cutFile = null;

		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.rename', async (item) => {
			// Prompt the user for the new name.
			const newName = await vscode.window.showInputBox({
				prompt: 'Enter the new name for the file'
			});

			if (newName) {
				const uri = vscode.Uri.parse(`playcanvas:/${item.path}`);
				const dir = path.dirname(item.path);
				
				// Construct the new Uri using the old Uri and the new name.
				const newUri = vscode.Uri.parse(`playcanvas:/${path.join(dir, newName)}`);
				try {
					await vscode.workspace.fs.rename(uri, newUri, { overwrite: false });
					vscode.window.showInformationMessage('File renamed successfully');
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to rename file: ${error.message}`);
				}
				
				// Refresh the tree view to reflect the file rename.
				fileProvider.refreshProject(fileProvider.getProject(uri.path));
				treeDataProvider.refresh();		
			}
		}));
		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.delete', async (item) => {
			const uri = vscode.Uri.parse(`playcanvas:/${item.path}`);

			// Show a confirmation dialog
			const confirm = await vscode.window.showWarningMessage('Are you sure you want to delete?', { modal: true }, 'Delete');

			// If the user clicked 'Delete', delete the file
			if (confirm === 'Delete') {

				try {
					await vscode.workspace.fs.delete(uri, {recursive: true, useTrash: false});
					vscode.window.showInformationMessage('File deleted successfully');

					// Refresh the tree view to reflect the file deletion.
					fileProvider.refreshProject(fileProvider.getProject(uri.path));
					treeDataProvider.refresh();
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to delete file: ${error.message}`);
				}
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.refreshFile', async (item) => {
			const uri = vscode.Uri.parse(`playcanvas:/${item.path}`);
			const fileData = fileProvider.getFileData(uri);
			const oldContent = new TextEncoder().encode(fileData.content);
			if (fileData) {
				delete fileData.content;
			}
			const newContent = await fileProvider.readFile(uri);
			if (oldContent !== newContent) {
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				// Re-open the file to update the editor.
				const document = await vscode.workspace.openTextDocument(uri);
				vscode.window.showTextDocument(document);
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand('playcanvas.openFile', (item) => {
			const uri = vscode.Uri.parse(`playcanvas:/${item.path}`);
			vscode.commands.executeCommand('vscode.open', uri);
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
