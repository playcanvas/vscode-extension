const vscode = require('vscode');
const Api = require('./api');

const defaultToken = 'cFT9ubWG5YHvGToNQoQi37KOLTY3yyRL';
const defaultUser = 'yakov-snap';

class CloudStorageProvider {
    constructor() {
        this.files = [];
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
        const file = uri.path.substr(1);
        const fileData = this.files.find(f => f.name === file); 
        if (fileData.type === 'folder') {
            return new Uint8Array();
        }
        if (!fileData.content) {
            fileData.content = await this.api.fetchFileContent(file);
        }

        if (!fileData.content) {       
            throw vscode.FileSystemError.FileNotFound();
        }
        return new TextEncoder().encode(fileData.content);
    }    

    watch(uri, options) {
        console.log('watch', uri, options);
    }
    
    async stat(uri) {
        const file = uri.path.substr(1);
        const fileData = this.files.find(f => f.name === file);
        if (fileData.type === 'folder') {
            return { type: vscode.FileType.Directory, size: 0, ctime: 0, mtime: 0 };
        }
        if (!fileData.content) {
            fileData.content = await this.api.fetchFileContent(file);
        }
        if (fileData.content) {
            return { type: vscode.FileType.File, size: fileData.content.length, ctime: 0, mtime: 0 };
        }
        throw vscode.FileSystemError.FileNotFound();
    }

    writeFile(uri, content) {
        this.content.set(uri.fsPath, content);
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
}

module.exports = CloudStorageProvider;
