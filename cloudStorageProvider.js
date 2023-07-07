const vscode = require('vscode');
const axios = require('axios');

class CloudStorageProvider {
    constructor() {
        this.files = [];
        this.content = new Map();
    }

    async readFile(uri) {
        const file = uri.path.substr(1);
        const content = await this.fetchFileContent(file);
        if (content.length > 0) {
            this.content.set(uri.fsPath, content);
            return content;
        }
        
        throw vscode.FileSystemError.FileNotFound();
    }    

    watch(uri, options) {
        console.log('watch', uri, options);
    }
    
    stat(uri) {
        const data = this.content.get(uri.fsPath);
        if (data) {
            return { type: vscode.FileType.File, size: data.length, ctime: 0, mtime: 0 };
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

    async fetchFiles() {
        let token = vscode.workspace.getConfiguration('playcanvas').get('bearerToken');
        if (!token || token === '') {
            token = 'GJyg1hwBGE3wDABG72bA8GfeugUPisBU';
        }

        try {
            const response = await axios.get('https://local-playcanvas.com/api/projects/45/assets?limit=100', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            this.files = response.data.result;

        } catch(error) {
            console.error('Failed to fetch files:', error);
        };

        return this.files;
    }

    async fetchFileContent(file) {

        // file file in files
        const fileData = this.files.find(f => f.name === file);

        const config = vscode.workspace.getConfiguration('playcanvas');
        let token = config.get('bearerToken');
        if (!token || token === '') {
            token = 'GJyg1hwBGE3wDABG72bA8GfeugUPisBU';
        }
        try {
            const response = await axios.get(`https://local-playcanvas.com/api/assets/${fileData.id}/file/${fileData.name}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
    
            // Assuming the API returns the file content as a string.
            // Modify as necessary based on your API's response.
            return response.data;
        } catch (error) {
            console.error('Failed to fetch file content:', error);
            return '';
        }
    }
}

module.exports = CloudStorageProvider;
