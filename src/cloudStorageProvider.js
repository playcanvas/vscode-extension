const vscode = require('vscode');
const Api = require('./api');
const { get } = require('http');
const path = require('path');

const defaultToken = 'cFT9ubWG5YHvGToNQoQi37KOLTY3yyRL';
const defaultUser = 'yakov-snap';

class CloudStorageProvider {
    constructor() {
        this.files = new Map();
        this.projects = [];
        this.userId = null;
        this.content = new Map();

        let token = vscode.workspace.getConfiguration('playcanvas').get('bearerToken');
        if (!token || token === '') {
            token = defaultToken;
        }

        let username = vscode.workspace.getConfiguration('playcanvas').get('username');
        if (!username || username === '') {
            username = defaultUser;
        }
        
        this.api = new Api(username, token);
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
            await this.fetchFiles(project.id, project.name);
        }
    }

    async stat(uri) {
        if (!this.getFileData(uri.path)) {
            await this.preloadProjectFiles(uri);
        }

        const fileData = this.getFileData(uri.path);
        if (!fileData) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (!fileData || fileData.type === 'folder') {
            return { type: vscode.FileType.Directory, size: 0, ctime: 0, mtime: 0 };
        }
        if (!fileData.content) {
            fileData.content = await this.fetchFileContent(fileData);
        }
        if (fileData.content !== null) {
            return { type: vscode.FileType.File, size: fileData.content.length, ctime: 0, mtime: 0 };
        }
        throw vscode.FileSystemError.FileNotFound();
    }

    async readFile(uri) {
        if (!this.getFileData(uri.path)) {
            await this.preloadProjectFiles(uri);
        }

        const fileData = this.getFileData(uri.path);
        if (!fileData || fileData.type === 'folder') {
            return new Uint8Array();
        }
        if (!fileData.content) {
            fileData.content = await this.fetchFileContent(fileData);
        }

        if (fileData.content === null) {       
            throw vscode.FileSystemError.FileNotFound();
        }
        return new TextEncoder().encode(fileData.content);
    }    

    async writeFile(uri, content) {
        const fileData = this.getFileData(uri.path);
        const asset = await this.api.uploadFile(fileData.id, fileData.file.filename, fileData.modifiedAt, content);
        fileData.modifiedAt = asset.modifiedAt;
        fileData.content = new TextDecoder().decode(content);
    }

    watch(uri, options) {
        console.log('watch', uri, options);
    }
    
    async rename(oldUri, newUri) {
        const newName = newUri.path.split('/').pop();
        const fileData = this.getFileData(oldUri.path);
        const asset = await this.api.renameAsset(fileData.id, newName);
        fileData.modifiedAt = asset.modifiedAt;
    }

    getProject(path) {
        const projectName = path.split('/')[1];
        return this.projects.find(p => p.name === projectName);
    }

    getProjectByName(name) {
        return this.projects.find(p => p.name === name);
    }    

    async copy(sourceUri, targetUri) {
        const fileData = this.getFileData(sourceUri.path);
        const folderData = this.getFileData(path.dirname(targetUri.path));
        const sourceProject = this.getProject(sourceUri.path);
        const targetProject = this.getProject(targetUri.path);
        const folderId = folderData ? folderData.id : null;
        await this.api.copyAsset(sourceProject.id, fileData.id, targetProject.id, folderId);        
    }

    async createFile(name, folderUri, type) {
        const project = this.getProject(folderUri.path);
        const folderData = this.getFileData(folderUri.path);
        await this.api.createAsset(project.id, folderData ? folderData.id : null, name, type);
    }

    async delete(uri) {
        const fileData = this.getFileData(uri.path);
        await this.api.deleteAsset(fileData.id);
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

    async fetchFiles(projectId, projectName) {
        const files = await this.api.fetchFiles(projectId);
        
        this.buildPaths(projectName, files);
        
        for (const file of files) {
            this.files.set('/' + file.path, file);
        }
        return files;
    } 

    async fetchFileContent(fileData) {
        return this.api.fetchFileContent(fileData.id, fileData.file.filename);              
    }

    getFileData(filename) {
        return this.files.get(filename);
    }

    refresh(clearProjects = true) {
        this.files = new Map();
        if (clearProjects) {
            this.projects = [];
        } else {
            this.projects.forEach(p => delete p.files);
        }
        this.content = new Map();
    }
}

module.exports = CloudStorageProvider;
