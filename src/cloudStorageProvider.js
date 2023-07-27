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

    async stat(uri) {
        console.log(`playcanvas: stat ${uri.path}`);
        
        if (uri.path.includes('.vscode') || uri.path.includes('.git') || uri.path.includes('.devcontainer')) {
            throw vscode.FileSystemError.FileNotFound();
        } 

        // make sure that we have the latest list of projects
        await this.fetchProjects();

        const project = this.getProject(uri.path);
        if (!project) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (uri.path === `/${project.name}`) {
            const projectModified = new Date(project.modified).getTime();
            const projectCreated = new Date(project.created).getTime();
            return { type: vscode.FileType.Directory, permissions: 0, size: 0, ctime: projectCreated, mtime: projectModified };
        }

        let asset = this.lookup(uri);
        if (!asset) {
            // at startup, vs code tries to read the file before 
            // the list of files for the project is downloaded
            await this.fetchFiles(project);
            asset = this.lookup(uri);
        }

        if (!asset) {
            throw vscode.FileSystemError.FileNotFound();
        }

        const modified = new Date(asset.modifiedAt).getTime();
        const created = new Date(asset.createdAt).getTime();

        if (!asset) {
            throw vscode.FileSystemError.FileNotFound();
        } 
        
        if (asset.type === 'folder') {
            return { type: vscode.FileType.Directory, permissions: 0, size: 0, ctime: created, mtime: modified };
        }

        return { type: vscode.FileType.File, permissions: 0, size: asset.file.size, ctime: created, mtime: modified };
    }

      async readFile(uri) {
        console.log(`playcanvas: readFile ${uri.path}`);

        if (uri.path.includes('.vscode') || uri.path.includes('.git') || uri.path.includes('.devcontainer')) {
            throw vscode.FileSystemError.FileNotFound();
        }        

        const project = this.getProject(uri.path);
        if (!project) {
            throw vscode.FileSystemError.FileNotFound();
        }

        let asset = this.lookup(uri);
        if (!asset) {
            // at startup, vs code tries to read the file before 
            // the list of files for the project is downloaded
            await this.fetchFiles(project);
            asset = this.lookup(uri);
        }

        if (!asset) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (asset && asset.type === 'folder') {
            return new Uint8Array();
        }       
        
        if (!asset.content) {
            asset.content = await this.fetchFileContent(asset, project.branchId);
        }

        if (asset.content === null) {       
            throw vscode.FileSystemError.FileNotFound();
        }
        return new TextEncoder().encode(asset.content);
    }   

    async writeFile(uri, content, options) {
        console.log(`playcanvas: writeFile ${uri.path}`);

        const project = this.getProject(uri.path);
        const asset = this.lookup(uri);
        if (!asset) {

            if (!options.create) {
                throw vscode.FileSystemError.FileNotFound();
            }

            const folderPath = path.dirname(uri.path);
            const folderUri = vscode.Uri.parse(`playcanvas:${path.dirname(uri.path)}`);
            
            // Construct the new Uri using the folder path and new name
            try {
                const root = folderPath === `/${project.name}`;
                const folderData = root ? null : this.lookup(folderUri);
                const name = uri.path.split('/').pop();
                await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create a file: ${error.message}`);
            }
        } else {
            const updatedAsset = await this.api.uploadFile(asset.id, asset.file.filename, asset.modifiedAt, project.branchId, content);
            asset.modifiedAt = updatedAsset.modifiedAt;
            asset.content = new TextDecoder().decode(content);
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
        const oldAsset = this.lookup(oldUri);
        const project = this.getProject(oldUri.path);
        const asset = await this.api.renameAsset(oldAsset.id, newName, project.branchId);
        this.files.delete(this.getFileDataKey(oldUri));
        this.files.set(this.getFileDataKey(newUri), asset);
        asset.modifiedAt = asset.modifiedAt;
        this.refreshProject(project);
    }

    getProject(path) {
        const projectName = path.split('/')[1];
        return this.getProjectByName(projectName);
    }

    getProjectByName(name) {
        return this.projects.find(p => p.name === name);
    }  
    
    getProjectById(id) {
        return this.projects.find(p => p.id === id);
    }  

    async copy(sourceUri, targetUri) {
        console.log(`playcanvas: copy ${sourceUri.path}`);

        const asset = this.lookup(sourceUri);
        const folderUri = vscode.Uri.parse(`playcanvas:${path.dirname(targetUri.path)}`);
        const folderData = this.lookup(folderUri);
        const sourceProject = this.getProject(sourceUri.path);
        const targetProject = this.getProject(targetUri.path);
        const folderId = folderData ? folderData.id : null;
        await this.api.copyAsset(sourceProject.id, sourceProject.branchId, asset.id, 
            targetProject.id, targetProject.branchId, folderId); 
        this.refreshProject(targetProject);     
    }

    async delete(uri) {
        const asset = this.lookup(uri);
        const project = this.getProject(uri.path);
        await this.api.deleteAsset(asset.id, project.branchId);
        this.files.delete(this.getFileDataKey(uri));
        this.refreshProject(project);
    }

    async readDirectory(uri) {
        console.log(`playcanvas: readDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        const files = await this.fetchFiles(project);
        const file = this.lookup(uri);
        const parentId = file ? file.id : null;
        const folderFiles = files.filter(f => f.parent === parentId);
        console.log(`playcanvas: readDirectory return files ${files.length}`);
        return folderFiles.map(f => [this.getFilename(f), f.type == 'folder' ? vscode.FileType.Directory : vscode.FileType.File]);
    }

    async createDirectory(uri) {
        console.log(`playcanvas: createDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        const asset = this.lookup(uri);
        if (!asset) {
            const folderPath = path.dirname(uri.path);
            const folderUri = vscode.Uri.parse(`playcanvas:/${path.dirname(uri.path)}`);
            
            // Construct the new Uri using the folder path and new name
            try {
                const root = folderPath === `/${project.name}`;
                const folderData = root ? null : this.lookup(folderUri);
                const name = uri.path.split('/').pop();
                const asset = await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name, 'folder');
                this.files.set(this.getFileDataKey(uri), asset);
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

    async fetchProject(id) {
        console.log(`playcanvas: fetchProject`);
        return await this.api.fetchProject(id);
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

    getFilename(asset) {
        return asset.file ? asset.file.filename : asset.name;
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

    async fetchFileContent(asset, branchId) {
        console.log(`playcanvas: fetchFileContent ${asset.name}`);
        return this.api.fetchFileContent(asset.id, asset.file.filename, branchId);
    }

    // key for the file map is branch id and filename
    getFileDataKey(uri) {
        const filename = uri.path;
        if (filename.length === 0) {
            return '';
        }
        const project = this.getProject(filename);
        const branchId = project.branchId ? `:${project.branchId}` : ''; 
        return `${filename}${branchId}`;
    }

    lookup(uri) {
        return this.files.get(this.getFileDataKey(uri));
    }

    refresh(clearProjects = true) {
        this.api = new Api();

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

    async pullLatest(path) {
        const project = this.getProject(path);
        const uri = vscode.Uri.parse(`playcanvas:${path}`);
        delete project.files;
        await this.fetchFiles(project);        
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: uri }]);
    }    
}

module.exports = CloudStorageProvider;
