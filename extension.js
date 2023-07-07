// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const TreeDataProvider = require('./treeDataProvider');
const CloudStorageProvider = require('./cloudStorageProvider');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "playcanvas" is now active!');

	try {

		const fileProvider = new CloudStorageProvider();
		context.subscriptions.push(vscode.workspace.registerFileSystemProvider('cloudstorage', fileProvider, { isCaseSensitive: true }));

		const files = await fileProvider.fetchFiles();
		const treeDataProvider = new TreeDataProvider(files);
		const treeView = vscode.window.createTreeView('PlayCanvasExplorer', { treeDataProvider: treeDataProvider });

		treeView.onDidChangeSelection(async e => {
			try {
				if (e.selection && e.selection.length > 0) {
					const selectedItem = e.selection[0];
					// Now you can do something with the selected item.
					// For example, open it in a new editor tab:
					const uri = vscode.Uri.parse(`cloudstorage:/${selectedItem.label}`);
					const doc = await vscode.workspace.openTextDocument(uri);
					vscode.window.showTextDocument(doc);
				}
			} catch (error) {
				console.log(error);
			}
		});

		context.subscriptions.push(treeView);

		context.subscriptions.push(
			vscode.commands.registerCommand('playcanvas.openFile', async (file) => {
				const content = await fileProvider.fetchFileContent(file); // You have to implement this function
				const document = await vscode.workspace.openTextDocument({ 
					content: content,
					language: 'javascript'
				});
				vscode.window.showTextDocument(document);
			})
		);
		
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
