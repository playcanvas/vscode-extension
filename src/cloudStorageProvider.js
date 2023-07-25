const vscode = require('vscode');
const Api = require('./api');
const path = require('path');


class CloudStorageProvider {
    constructor() {
        this.files = new Map();
        this.projects = [];
        this.userId = null;
        this.content = new Map();
        this.currentProject = null;
        this._onDidChangeFile = new vscode.EventEmitter();
        this.refresh();
    }

    get onDidChangeFile() {
        console.log('playcanvas: onDidChangeFile');
        return this._onDidChangeFile.event;
    }

    async refreshProjectFiles(uri) {
        console.log(`playcanvas: refreshProjectFiles ${uri.path}`);

        // special case - the list of projects is not loaded yet
        const projects = await this.fetchProjects();
        // extract project name from url
        const projectName = uri.path.split('/')[1];
        const project = projects.find(p => p.name === projectName);
        if (project) {
            // force refresh the file list
            delete project.files;
            await this.fetchFiles(project);
        }
    }

    async stat(uri) {
        console.log(`playcanvas: stat ${uri.path}`);
        
        await this.fetchProjects();
        const project = this.getProject(uri.path);
        if (!project) {
            throw vscode.FileSystemError.FileNotFound();
        }

        const projectModified = new Date(project.modified).getTime();
        const projectCreated = new Date(project.created).getTime();

        if (uri.path === `/${project.name}`) {
            return { type: vscode.FileType.Directory, permissions: 0, size: 0, ctime: projectCreated, mtime: projectModified };
        }

        if (!this.getFileData(uri)) {
            await this.refreshProjectFiles(uri);
        }

        const fileData = this.getFileData(uri);
        if (!fileData) {
            throw vscode.FileSystemError.FileNotFound();
        }

        const modified = new Date(fileData.modifiedAt).getTime();
        const created = new Date(fileData.createdAt).getTime();

        if (!fileData) {
            throw vscode.FileSystemError.FileNotFound();
        } 
        
        if (fileData.type === 'folder') {
            return { type: vscode.FileType.Directory, permissions: 0, size: 0, ctime: created, mtime: modified };
        }

        return { type: vscode.FileType.File, permissions: 0, size: fileData.file.size, ctime: created, mtime: modified };
      }

    async readFile(uri) {
        console.log(`playcanvas: readFile ${uri.path}`);

        const project = this.getProject(uri.path);
        if (!project) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (!this.getFileData(uri)) {
            await this.refreshProjectFiles(uri);
        }

        const fileData = this.getFileData(uri);
        if (!fileData || fileData.type === 'folder') {
            return new Uint8Array();
        }
        // if (!fileData.content) {
        fileData.content = await this.fetchFileContent(fileData, project.branchId);
        // }

        if (fileData.content === null) {       
            throw vscode.FileSystemError.FileNotFound();
        }
        return new TextEncoder().encode(fileData.content);
    }    

    async writeFile(uri, content, options) {
        console.log(`playcanvas: writeFile ${uri.path}`);

        const project = this.getProject(uri.path);
        const fileData = this.getFileData(uri);
        if (!fileData) {

            if (!options.create) {
                throw vscode.FileSystemError.FileNotFound();
            }

            const folderPath = path.dirname(uri.path);
            const folderUri = vscode.Uri.parse(`playcanvas:${path.dirname(uri.path)}`);
            
            // Construct the new Uri using the folder path and new name
            try {
                const root = folderPath === `/${project.name}`;
                const folderData = root ? null : this.getFileData(folderUri);
                const name = uri.path.split('/').pop();
                await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create a file: ${error.message}`);
            }
        } else {
            const asset = await this.api.uploadFile(fileData.id, fileData.file.filename, fileData.modifiedAt, project.branchId, content);
            fileData.modifiedAt = asset.modifiedAt;
            fileData.content = new TextDecoder().decode(content);
        }
    }


	watch(uri) {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => { });
	}

    isWritableFileSystem(scheme) {
        return true;
    }
    
    async rename(oldUri, newUri) {
        console.log(`playcanvas: rename ${oldUri.path}`);

        const newName = newUri.path.split('/').pop();
        const fileData = this.getFileData(oldUri);
        const project = this.getProject(oldUri.path);
        const asset = await this.api.renameAsset(fileData.id, newName, project.branchId);
        fileData.modifiedAt = asset.modifiedAt;
    }

    getProject(path) {
        const projectName = path.split('/')[1];
        return this.projects.find(p => p.name === projectName);
    }

    getProjectByName(name) {
        return this.projects.find(p => p.name === name);
    } 
    
    getProjectById(id) {
        return this.projects.find(p => p.id === id);
    } 

    async copy(sourceUri, targetUri) {
        console.log(`playcanvas: copy ${sourceUri.path}`);

        const fileData = this.getFileData(sourceUri);
        const folderUri = vscode.Uri.parse(`playcanvas:${path.dirname(targetUri.path)}`);
        const folderData = this.getFileData(folderUri);
        const sourceProject = this.getProject(sourceUri.path);
        const targetProject = this.getProject(targetUri.path);
        const folderId = folderData ? folderData.id : null;
        await this.api.copyAsset(sourceProject.id, sourceProject.branchId, fileData.id, 
            targetProject.id, targetProject.branchId, folderId);        
    }

    async delete(uri) {
        const fileData = this.getFileData(uri);
        const project = this.getProject(uri.path);
        await this.api.deleteAsset(fileData.id, project.branchId);
    }

    async readDirectory(uri) {
        console.log(`playcanvas: readDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        const files = await this.fetchFiles(project);
        const file = this.getFileData(uri);
        const parentId = file ? file.id : null;
        const folderFiles = files.filter(f => f.parent === parentId);
        return folderFiles.map(f => [f.name, f.type == 'folder' ? vscode.FileType.Directory : vscode.FileType.File]);
    }

    async createDirectory(uri) {
        console.log(`playcanvas: createDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        const fileData = this.getFileData(uri);
        if (!fileData) {
            const folderPath = path.dirname(uri.path);
            const folderUri = vscode.Uri.parse(`playcanvas:/${path.dirname(uri.path)}`);
            
            // Construct the new Uri using the folder path and new name
            try {
                const root = folderPath === `/${project.name}`;
                const folderData = root ? null : this.getFileData(folderUri);
                const name = uri.path.split('/').pop();
                await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name, 'folder');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create a folder: ${error.message}`);
            }
        }
    }

    async fetchProjects() {
        console.log(`playcanvas: fetchProjects`);
        if (!this.userId) {
            this.userId = await this.api.fetchUserId();
        }
        if (this.projects.length === 0) {
            this.projects = await this.api.fetchProjects(this.userId);
        }
        
        return this.projects;
    }

    async fetchBranches(project) {
        console.log(`playcanvas: fetchBranches ${project.name}`);
        if (!project.branches) {
            const branches = await this.api.fetchBranches(project.id);
            project.branches = branches;
        }
        return project.branches;
    }

    switchBranch(project, branchName) {
        project.branchId = project.branches.find(b => b.name === branchName).id;
    }

    getFilename(fileData) {
        return fileData.file ? fileData.file.filename : fileData.name;
    }

    getPath(projectName, file, fileMap) {
        if (file.path) {
            return file.path;
        }

        if (file.parent) {
            const parent = fileMap.get(file.parent);
            if (parent) {
                file.path = this.getPath(projectName, parent, fileMap) + '/' + this.getFilename(file);
            }
        } else {
            file.path = projectName + '/' + this.getFilename(file);
        } 
        
        return file.path;
    }

    buildPaths(projectName, files) {
        console.log(`playcanvas: buildPaths ${projectName}`);
        const fileMap = new Map();
        for (const file of files) {
            fileMap.set(file.id, file);
        }

        for (const file of files) {
            this.getPath(projectName, file, fileMap);
        }
    }

    async fetchFiles(project) {
        console.log(`playcanvas: fetchFiles ${project.name}`);
        if (!project.files) {
            const files = await this.api.fetchFiles(project.id, project.branchId);
            this.buildPaths(project.name, files);
        
            for (const file of files) {
                const uri = vscode.Uri.parse(`playcanvas:/${file.path}`);
                const key = this.getFileDataKey(uri);
                this.files.set(key, file);
            }

            project.files = files;
        }
        return project.files;
    } 

    async fetchFileContent(fileData, branchId) {
        console.log(`playcanvas: fetchFileContent ${fileData.name}`);
        return this.api.fetchFileContent(fileData.id, fileData.file.filename, branchId);
    }

    // key for the file map is branch id and filename
    getFileDataKey(uri) {
        console.log(`playcanvas: getFileDataKey ${uri.path}`);
        const filename = uri.path;
        if (filename.length === 0) {
            return '';
        }
        const project = this.getProject(filename);
        const branchId = project.branchId ? `:${project.branchId}` : ''; 
        return `${filename}${branchId}`;
    }

    getFileData(uri) {
        return this.files.get(this.getFileDataKey(uri));
    }

    refresh(clearProjects = true) {

        const config = vscode.workspace.getConfiguration('playcanvas');
        let token = config.get('accessToken');
        let username = config.get('username');
        
        this.api = new Api(username, token);

        this.files = new Map();
        if (clearProjects) {
            this.projects = [];
        } else {
            this.projects.forEach(p => { delete p.files; delete p.branches; delete p.branchId } );
        }
        this.content = new Map();
    }

    refreshUri(uri) {
        // Fire the event to signal that a file has been changed.
        // VS Code will call your readDirectory and other methods to update its view.
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: uri }]);
    }

    async refreshProject(project) {
        delete project.files;
        await this.fetchFiles(project);
    }
}

module.exports = CloudStorageProvider;
