const vscode = require('vscode');
const axios = require('axios');

const tempToken = 'cFT9ubWG5YHvGToNQoQi37KOLTY3yyRL';

class CloudStorageProvider {
    constructor() {
        this.files = [];
        this.projects = [];
        this.content = new Map();
    }

    onDidChangeFile() {
        console.log('onDidChangeFile');
    }

    async readFile(uri) {
        const file = uri.path.substr(1);
        const fileData = this.files.find(f => f.name === file); 
        if (!fileData.content) {
            fileData.content = await this.fetchFileContent(file);
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
        if (!fileData.content) {
            fileData.content = await this.fetchFileContent(file);
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

    async fetchProjects() {
        let token = vscode.workspace.getConfiguration('playcanvas').get('bearerToken');
        if (!token || token === '') {
            token = tempToken;
        }

        try {
            const response = await axios.get('https://local-playcanvas.com/api/users/23/projects', {
                headers: {
                    'Content-Type': "application/json",
                    'Authorization': `Bearer ${token}`
                }
            });

            this.projects = response.data.result;

        } catch(error) {
            console.error('Failed to fetch projects:', error);
        };

        return this.projects;
    }    

    async fetchFiles(projectId) {
        let token = vscode.workspace.getConfiguration('playcanvas').get('bearerToken');
        if (!token || token === '') {
            token = tempToken;
        }

        try {
            const response = await axios.get(`https://local-playcanvas.com/api/projects/${projectId}/assets?view=extension&limit=10000`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            this.files = this.files.concat(response.data.result);

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
            token = tempToken;
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
