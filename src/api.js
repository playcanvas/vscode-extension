const fetch = require('node-fetch');
const apiHost = 'https://local-playcanvas.com/api';

class Api {
    constructor(username, token) {
        this.username = username;
        this.token = token;        
        this.files = [];
        this.projects = [];
        this.userId = null;
        this.content = new Map();
    }

    async apiCall(url) {
        try {
            const response = await fetch(url, {
                headers: {
                    'Content-Type': "application/json",
                    'Authorization': `Bearer ${this.token}`
                }
            });

            return response;
        } catch(error) {
            console.error('API call failed:', error);
        }
    }

    // get current user id from username
    async fetchUser() {
        const response = await this.apiCall(`${apiHost}/users/${this.username}`);
        this.userId =  response.data.id;
        return this.userId;
    } 

    async fetchProjects() {
        if (!this.userId) {
            await this.fetchUser();
        }
        const response = await this.apiCall(`${apiHost}/users/${this.userId}/projects`);
        this.projects =  response.data.result;
        return this.projects;
    }    

    async fetchFiles(projectId) {
        const response = await this.apiCall(`${apiHost}/projects/${projectId}/assets?view=extension&limit=10000`);
        this.files = this.files.concat(response.data.result);
        return this.files;
    }

    async fetchFileContent(file) {
        const fileData = this.files.find(f => f.name === file);        
        const response = await this.apiCall(`${apiHost}/assets/${fileData.id}/file/${fileData.name}`);
        return response.data;
    }
}

module.exports = Api;
