const vscode = require('vscode');

class ProjectDataProvider {
    constructor(context) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.context = context;
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!element) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                return Promise.resolve(workspaceFolders.map(folder => new WorkspaceItem(folder, this.getWorkspaceData(folder))));
            }
        }
        return Promise.resolve([]);
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    setWorkspaceData(folder, data) {
        const workspaceData = this.context.workspaceState.get('workspaceData') || {};
        workspaceData[folder] = data;
        this.context.workspaceState.update('workspaceData', workspaceData);
        this.refresh();
    }

    getWorkspaceData(folder) {
        const workspaceData = this.context.workspaceState.get('workspaceData') || {};
        return workspaceData[folder] || '';
    }
}

class WorkspaceItem extends vscode.TreeItem {
    constructor(folder, data) {
        super(folder.name, vscode.TreeItemCollapsibleState.None);
        this.folder = folder;
        this.description = data;
        this.contextValue = 'workspaceItem';
    }
}

module.exports = ProjectDataProvider;