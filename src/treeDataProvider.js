const { dirname } = require('path');
const vscode = require('vscode');

class TreeDataProvider {
    constructor(fileProvider) {
        this.fileProvider = fileProvider;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.expanded = new Set();
    }

    // When the user selects a file, open it in a new editor tab.
    onDidSelectItem(file) {
        if (file.project || file.type === 'folder') {
            return;
        }
        const uri = vscode.Uri.parse(`playcanvas:/${file.label}`);
        vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    }    

    getTreeItem(item) {
        if (item.project) {
            item.node = item;
        }
        return item;
        // treeItem.command = {
        //     command: 'playcanvas.openFile',
        //     title: 'Open File',
        //     arguments: [file]
        // };
    }
    
    sortFiles(files) {
        // sort the files by path

        // folders first
        files.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder' ) {
                return -1;
            }
            if (a.type !== 'folder' && b.type === 'folder' ) {
                return 1;
            }

            if (a.path.toLowerCase() < b.path.toLowerCase()) {
                return -1;
            } else if (a.path.toLowerCase() > b.path.toLowerCase()) {
                return 1;
            }
            return 0;
        });
    }

    async getChildren(element) {
        
        // projects
        if (!element) {
            const projects = await this.fileProvider.fetchProjects();
            const children = [];
            for (const project of projects) {
                const state = this.expanded.has(project.name) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed; 
                let branch = '';
                if (project.branchId) {
                    const branchName = project.branches.find( b => b.id === project.branchId ).name;
                    if (branchName !== 'main') {
                        branch = ` (${branchName})`;
                    }                    
                }
                children.push({
                    label: project.name + branch,
                    project: true,
                    iconPath: new vscode.ThemeIcon('project'),
                    projectId: project.id,
                    projectName: project.name,
                    path: project.name,
                    collapsibleState: state,
                    contextValue: 'project',
                    parent: element
                });
            };
            return children;
        } 

        const project = this.fileProvider.getProjectById(element.projectId);

        // project folders and files
        const children = [];
        if (element.project) {
            // files inside a project folder 
            // populated when the project is expanded
            const files = await this.fileProvider.fetchFiles(project);
            element.files = files.filter(f => f.parent === null);
            this.sortFiles(element.files);
        } 

        for (const file of element.files) {
            let state = vscode.TreeItemCollapsibleState.None;
            let files = [];
            let icon = 'file-code';
            if (file.type === 'folder') {
                state = this.expanded.has(file.path) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
                files = project.files.filter(f => f.parent === file.id);
                this.sortFiles(files);
                icon = 'file-directory';
            }
            children.push({
                label: file.file ? file.file.filename : file.name,
                project: false,
                projectName: element.projectName,
                projectId: element.projectId,
                files: files,
                assetId: file.id,
                iconPath: new vscode.ThemeIcon(icon),
                collapsibleState: state,
                path: file.path,
                contextValue: file.type == 'folder' ? 'folder' : 'file',
                parent: element
            });
        }
        return children;
    }

    onElementExpanded(path) {
        this.expanded.add(path);
    };
    
    onElementCollapsed(path) {
        this.expanded.delete(path);
    }

    getParent(element) {
        return element.parent;
    }

    refresh() {
        // cleanup cache
        this._onDidChangeTreeData.fire();
    }
}

module.exports = TreeDataProvider;
