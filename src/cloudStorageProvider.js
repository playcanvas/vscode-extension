const vscode = require('vscode');
const Api = require('./api');

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

    async readFile(uri) {
        const fileData = this.getFileData(uri.path);
        if (!fileData || fileData.type === 'folder') {
            return new Uint8Array();
        }
        if (!fileData.content) {
            fileData.content = await this.fetchFileContent(fileData);
        }

        if (!fileData.content) {       
            throw vscode.FileSystemError.FileNotFound();
        }
        return new TextEncoder().encode(fileData.content);
    }    

    writeFile(uri, content) {
        const fileData = this.getFileData(uri.path);
        this.api.uploadFile(fileData.id, fileData.name, content);
        fileData.content = new TextDecoder().decode(content);
    }

    watch(uri, options) {
        console.log('watch', uri, options);
    }
    
    async stat(uri) {
        const fileData = this.getFileData(uri.path);
        if (!fileData || fileData.type === 'folder') {
            return { type: vscode.FileType.Directory, size: 0, ctime: 0, mtime: 0 };
        }
        if (!fileData.content) {
            fileData.content = await this.fetchFileContent(fileData);
        }
        if (fileData.content) {
            return { type: vscode.FileType.File, size: fileData.content.length, ctime: 0, mtime: 0 };
        }
        throw vscode.FileSystemError.FileNotFound();
    }

    rename(oldUri, newUri) {
        const data = this.content.get(oldUri.fsPath);
        if (data) {
            this.content.delete(oldUri.fsPath);
            this.content.set(newUri.fsPath, data);
        } else {
            throw vscode.FileSystemError.FileNotFound();
        }
    }

    delete(uri) {
        this.content.delete(uri.fsPath);
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
        this.projects = await this.api.fetchProjects(this.userId);
        return this.projects;
    }

    getPath(projectName, file, fileMap) {
        if (file.path) {
            return file.path;
        }

        if (file.parent) {
            const parent = fileMap.get(file.parent);
            if (parent) {
                file.path = this.getPath(projectName, parent, fileMap) + '/' + file.name;
            }
        } else {
            file.path = projectName + '/' + file.name;
        }        
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
        return this.api.fetchFileContent(fileData.id, fileData.name);              
    }

    getFileData(filename) {
        return this.files.get(filename);
    }
}

module.exports = CloudStorageProvider;
