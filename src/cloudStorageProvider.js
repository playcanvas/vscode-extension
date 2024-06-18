const vscode = require('vscode');
const Api = require('./api');
const path = require('path');

let projects = [];
let userId = null;

class CloudStorageProvider {
    constructor(context) {
        this.context = context;
        this._onDidChangeFile = new vscode.EventEmitter();

        const filePath = path.join(__dirname, '..', 'node_modules', 'playcanvas', 'build/playcanvas.d.ts');
        this.typesReference = '///<reference path="' + filePath + '" />;\n';

        this.refresh();
    }

    get onDidChangeFile() {
        console.log('playcanvas: onDidChangeFile');
        return this._onDidChangeFile.event;
    }

    isProjectPath(path) {
        return path.split('/').length === 2;        
    }

    async stat(uri) {
        console.log(`playcanvas: stat ${uri.path}`);
        
        if (uri.path.includes('.vscode') || uri.path.includes('.git') || 
            uri.path.includes('.devcontainer') || uri.path.includes('node_modules') ||
            uri.path.includes('pom.xml') || uri.path.includes('AndroidManifest.xml')) {
            console.log(`playcanvas: stat ${uri.path} not found`);
            throw vscode.FileSystemError.FileNotFound();
        } 

        const project = this.getProject(uri.path);
        if (!project) {
            console.log(`playcanvas: stat ${uri.path} not found`);
            throw vscode.FileSystemError.FileNotFound();
        }

        if (this.isProjectPath(uri.path)) {
            const projectModified = new Date(project.modified).getTime();
            const projectCreated = new Date(project.created).getTime();
            return { type: vscode.FileType.Directory, permissions: 0, size: 0, ctime: projectCreated, mtime: projectModified };
        }

        let asset = this.lookup(uri);
        if (!asset) {
            console.log(`playcanvas: stat ${uri.path} not found`);
            throw vscode.FileSystemError.FileNotFound();
        }

        const modified = new Date(asset.modifiedAt).getTime();
        const created = new Date(asset.createdAt).getTime();

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

        const config = vscode.workspace.getConfiguration('playcanvas');

        if (config.get('usePlaycanvasTypes') && (asset.file.filename.endsWith('.js') || asset.file.filename.endsWith('.mjs'))) {
            return new TextEncoder().encode(this.typesReference + asset.content);
        }

        return new TextEncoder().encode(asset.content);
    }   

    addFile(path, asset) {
        const parts = path.split('/');
        const project = this.getProjectByName(parts[1]);
        if (!project || parts.length === 0) {
            return null;
        }
        
        let files = project.files;
        for (let i=2; i<parts.length-1; ++i) {
            const folder = files.get(parts[i]);
            if (!folder) {
                throw new Error(`Failed to find folder ${parts[i]}`);
            }            
            files = folder.files;
        }
        files.set(parts[parts.length-1], asset);
    }

    removeFile(path) {
        const parts = path.split('/');
        const project = this.getProjectByName(parts[1]);
        if (!project || parts.length === 0) {
            return null;
        }
        
        let files = project.files;
        for (let i=2; i<parts.length-1; ++i) {
            const folder = files.get(parts[i]);
            if (!folder) {
                throw new Error(`Failed to find folder ${parts[i]}`);
            }             
            files = folder.files;
        }
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
                const root = this.isProjectPath(folderPath);
                const folderData = root ? null : this.lookup(folderUri);
                const name = uri.path.split('/').pop();
                await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name);
                await this.refreshProject(project);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create a file: ${error.message}`);
            }
        } else {
            // remove reference line before saving
            const config = vscode.workspace.getConfiguration('playcanvas');

            if (config.get('usePlaycanvasTypes') && (asset.file.filename.endsWith('.js') || asset.file.filename.endsWith('.mjs'))) {
                let strContent = new TextDecoder().decode(content);
                if (strContent.startsWith(this.typesReference)) {
                    strContent = strContent.substring(this.typesReference.length);
                    content = Buffer.from(strContent);
                }
            }

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
        const folder = this.lookup(vscode.Uri.parse(`playcanvas:${path.dirname(newUri.path)}`));
        const asset = await this.api.renameAsset(oldAsset.id, folder ? folder.id : null, newName, project.branchId);
        asset.modifiedAt = asset.modifiedAt;
        await this.refreshProject(project);
    }

    getProject(path) {
        const projectName = path.split('/')[1];
        return this.getProjectByName(projectName);
    }

    getProjectByName(name) {
        const projectBranch = name.split(':');
        return projects.find(p => p.name === projectBranch[0]);
    }

    getBranchByFolderName(folderName) {
        const projectBranch = folderName.split(':');
        return projectBranch[1] ? projectBranch[1] : 'main';
    }
    
    getProjectById(id) {
        return projects.find(p => p.id === id);
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
        await this.refreshProject(targetProject);     
    }

    async delete(uri) {
        const asset = this.lookup(uri);
        const project = this.getProject(uri.path);
        await this.api.deleteAsset(asset.id, project.branchId);
        await this.refreshProject(project);
    }

    async readDirectory(uri) {
        console.log(`playcanvas: readDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        await this.fetchAssets(project);
        const folder = this.lookup(uri);
        const folderFiles = folder ? [...folder.files.values()] : [...project.files.values()];
        console.log(`playcanvas: readDirectory return files ${folderFiles.length}`);
        return folderFiles.map(f => [this.getFilename(f), f.type == 'folder' ? vscode.FileType.Directory : vscode.FileType.File]);
    }

    async createDirectory(uri) {
        console.log(`playcanvas: createDirectory ${uri.path}`);
        const project = this.getProject(uri.path);
        const asset = this.lookup(uri);
        if (!asset) {
            const folderPath = path.dirname(uri.path);
            const folderUri = vscode.Uri.parse(`${folderPath}`);
            
            // Construct the new Uri using the folder path and new name
            try {
                const root = this.isProjectPath(folderPath);
                const folderData = root ? null : this.lookup(folderUri);
                const name = uri.path.split('/').pop();
                await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name, 'folder');
                await this.refreshProject(project);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create a folder: ${error.message}`);
            }
        }
    }

    async fetchUserId() {
        userId = await this.api.fetchUserId();
    }

    async getProjects() {
        return projects;
    }

    async fetchProjects() {
        if (!userId) {
            userId = await this.api.fetchUserId();
        }
        console.log(`playcanvas: fetchProjects`);
        projects = await this.api.fetchProjects(userId);
        return projects;
    }

    async fetchProject(id) {
        console.log(`playcanvas: fetchProject`);
        return await this.api.fetchProject(id);
    }    

    async fetchBranches(project) {
        console.log(`playcanvas: fetchBranches ${project.name}`);
        // if (!project.branches) {
            const branches = await this.api.fetchBranches(project.id);
            project.branches = branches;
        // }
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

        const filename = this.getFilename(file);

        if (file.parent) {
            const parent = fileMap.get(file.parent);
            if (parent) {
                file.path = this.getPath(projectName, parent, fileMap) + '/' + filename;
                parent.files.set(filename, file);
            }
        } else {
            file.path = projectName + '/' + filename;
        } 
        
        return file.path;
    }

    buildPaths(projectName, files) {
        console.log(`playcanvas: buildPaths ${projectName}`);
        const fileMap = new Map();
        for (const file of files) {
            fileMap.set(file.id, file);
            if (file.type === 'folder') {
                file.files = new Map();
            }
        }

        for (const file of files) {
            this.getPath(projectName, file, fileMap);
        }
    }

    async fetchAssets(project) {
        console.log(`playcanvas: fetchAssets ${project.name}`);
        if (!project.files) {            
            const files = await this.api.fetchAssets(project.id, project.branchId);
            project.files = new Map();
            for (const file of files) {
                if (!file.parent) {
                    project.files.set(this.getFilename(file), file);
                }
            }
            this.buildPaths(project.name, files);
        }
        return project.files;
    } 

    async fetchFileContent(asset, branchId) {
        console.log(`playcanvas: fetchFileContent ${asset.name}`);
        return this.api.fetchFileContent(asset.id, asset.file.filename, branchId);
    }

    lookup(uri) {
        const parts = uri.path.split('/');
        const project = this.getProjectByName(parts[1]);
        if (!project || parts.length === 0) {
            return null;
        }
        
        let files = project.files;
        if (!files) {
            return null;
        }
        for (let i=2; i<parts.length-1; ++i) {
            const folder = files.get(parts[i]);
            if (!folder) {
                return null;
            } 
            files = folder.files;
        }
        return files.get(parts[parts.length-1]);
    }

    refresh(clearProjects = true) {
        this.api = new Api(this.context);

        if (clearProjects) {
            projects = [];
        } else {
            projects.forEach(p => { delete p.files; delete p.branches; delete p.branchId } );
        }
    }

    refreshUri(uri) {
        console.log('refreshUri ' + uri.path);
        // Fire the event to signal that a file has been changed.
        // VS Code will call your readDirectory and other methods to update its view.
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: uri }]);
    }

    async refreshProject(project) {
        console.log('refreshProject' + project.name);
        delete project.files;
        await this.fetchAssets(project);
    }

    async pullLatest(path) {
        console.log('pullLatest ' + path);
        const project = this.getProject(path);
        await this.refreshProject(project);
    }
}

module.exports = CloudStorageProvider;
