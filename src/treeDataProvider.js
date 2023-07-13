const vscode = require('vscode');

class TreeDataProvider {
    constructor(fileProvider) {
        this.fileProvider = fileProvider;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.projects = [];
    }

    // When the user selects a file, open it in a new editor tab.
    onDidSelectItem(file) {
        if (file.project || file.type === 'folder') {
            return;
        }
        const uri = vscode.Uri.parse(`cloudstorage:/${file.label}`);
        vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    }    

    getTreeItem(file) {
        return file;
        // treeItem.command = {
        //     command: 'playcanvas.openFile',
        //     title: 'Open File',
        //     arguments: [file]
        // };
    }

    async getChildren(element) {
        if (!element) {
            this.projects = await this.fileProvider.fetchProjects();
            return this.projects.map(project => ({
                label: project.name,
                project: true,
                iconPath: new vscode.ThemeIcon('project'),
                projectId: project.id,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            }));
        } else {
            const children = [];
            if (element.project) {
                // files inside a project folder
                if (!element.files) {
                    element.files = await this.fileProvider.fetchFiles(element.projectId);
                }
            } 
            for (const file of element.files) {
                if (element.project && file.parent) {
                    continue;
                }
                let state = vscode.TreeItemCollapsibleState.None;
                let files = [];
                let icon = 'file-code';
                if (file.type === 'folder') {
                    state = vscode.TreeItemCollapsibleState.Collapsed;
                    files = element.files.filter(f => f.parent === file.id);
                    if (files.length === 0) {
                        // folder with no scripts and no subfolders
                        continue;
                    }
                    icon = 'file-directory';
                }
                children.push({
                    label: file.name,
                    project: false,
                    files: files,
                    assetId: file.id,
                    iconPath: new vscode.ThemeIcon(icon),
                    collapsibleState: state,
                });
            }
            return children;
        }
    }
}

module.exports = TreeDataProvider;
