const vscode = require('vscode');

class TreeDataProvider {
    constructor(files) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.files = files;
    }

    // When the user selects a file, open it in a new editor tab.
    onDidSelectItem(file) {
        const uri = vscode.Uri.parse(`cloudstorage:/${file.label}`);
        vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    }    

    getTreeItem(file) {
        let treeItem = new vscode.TreeItem(
            file.label,
            vscode.TreeItemCollapsibleState.None
        );
        // treeItem.command = {
        //     command: 'playcanvas.openFile',
        //     title: 'Open File',
        //     arguments: [file]
        // };
        return treeItem;
    }

    getChildren(element) {
        if (!element) {
            return this.files.map(file => ({
                label: file.name,  // replace 'name' with the actual property name in your data
                collapsibleState: vscode.TreeItemCollapsibleState.None
            }));
        }
    }
}

module.exports = TreeDataProvider;
