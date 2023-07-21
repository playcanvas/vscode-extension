const vscode = require('vscode');
const Api = require('./api');
const { get } = require('http');
const path = require('path');

// local
// const defaultToken = 'cFT9ubWG5YHvGToNQoQi37KOLTY3yyRL';
// dev
const defaultToken = 'ycokBkYiHO5o4nsMTEOYtMD05BAQ7lrW';
const defaultUser = 'yakov-snap';

class CloudStorageProvider {
    constructor() {
        this.files = new Map();
        this.projects = [];
        this.userId = null;
        this.content = new Map();

        this.refresh();
    }

    onDidChangeFile() {
        console.log('onDidChangeFile');
    }

    async preloadProjectFiles(uri) {
        // special case - the list of projects is not loaded yet
        const projects = await this.fetchProjects();
        // extract project name from url
        const projectName = uri.path.split('/')[1];
        const project = projects.find(p => p.name === projectName);
        if (project) {
            await this.fetchFiles(project);
        }
    }

    async stat(uri) {
        if (!this.getFileData(uri)) {
            await this.preloadProjectFiles(uri);
        }

        const fileData = this.getFileData(uri);
        if (!fileData) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (!fileData || fileData.type === 'folder') {
            return { type: vscode.FileType.Directory, size: 0, ctime: 0, mtime: 0 };
        }
        if (!fileData.content) {
            const project = this.getProject(uri.path);
            fileData.content = await this.fetchFileContent(fileData, project.branchId);
        }
        if (fileData.content !== null) {
            return { type: vscode.FileType.File, size: fileData.content.length, ctime: 0, mtime: 0 };
        }
        throw vscode.FileSystemError.FileNotFound();
    }

    async readFile(uri) {
        if (!this.getFileData(uri)) {
            await this.preloadProjectFiles(uri);
        }

        const fileData = this.getFileData(uri);
        if (!fileData || fileData.type === 'folder') {
            return new Uint8Array();
        }
        if (!fileData.content) {
            const project = this.getProject(uri.path);
            fileData.content = await this.fetchFileContent(fileData, project.branchId);
        }

        if (fileData.content === null) {       
            throw vscode.FileSystemError.FileNotFound();
        }
        return new TextEncoder().encode(fileData.content);
    }    

    async writeFile(uri, content) {
        const fileData = this.getFileData(uri);
        const project = this.getProject(uri.path);
        const asset = await this.api.uploadFile(fileData.id, fileData.file.filename, fileData.modifiedAt, project.branchId, content);
        fileData.modifiedAt = asset.modifiedAt;
        fileData.content = new TextDecoder().decode(content);
    }

    watch(uri, options) {
        console.log('watch', uri, options);
    }
    
    async rename(oldUri, newUri) {
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
        const fileData = this.getFileData(sourceUri);
        const folderUri = vscode.Uri.parse(`playcanvas:/${path.dirname(targetUri.path)}`);
        const folderData = this.getFileData(folderUri);
        const sourceProject = this.getProject(sourceUri.path);
        const targetProject = this.getProject(targetUri.path);
        const folderId = folderData ? folderData.id : null;
        await this.api.copyAsset(sourceProject.id, sourceProject.branchId, fileData.id, 
            targetProject.id, targetProject.branchId, folderId);        
    }

    async createFile(name, folderUri, type) {
        const project = this.getProject(folderUri.path);
        const folderData = this.getFileData(folderUri);
        await this.api.createAsset(project.id, project.branchId, folderData ? folderData.id : null, name, type);
    }

    async delete(uri) {
        const fileData = this.getFileData(uri);
        const project = this.getProject(uri.path);
        await this.api.deleteAsset(fileData.id, project.branchId);
    }

    readDirectory(uri) {
        console.log('readDirectory', uri);
    }

    createDirectory(uri) {
        console.log('createDirectory', uri);
    }

    async fetchProjects() {
        if (!this.userId) {
            this.userId = await this.api.fetchUserId();
        }
        if (this.projects.length === 0) {
            this.projects = await this.api.fetchProjects(this.userId);
        }
        
        return this.projects;
    }

    async fetchBranches(project) {
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
        const fileMap = new Map();
        for (const file of files) {
            fileMap.set(file.id, file);
        }

        for (const file of files) {
            this.getPath(projectName, file, fileMap);
        }
    }

    async fetchFiles(project) {
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
        return this.api.fetchFileContent(fileData.id, fileData.file.filename, branchId);
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

    refreshProject(project) {
        delete project.files;
    }
}

module.exports = CloudStorageProvider;
