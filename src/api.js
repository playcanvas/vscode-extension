const fetch = require('node-fetch');
const apiHost = 'https://local-playcanvas.com/api';
const FormData = require('form-data');
class Api {
    constructor(username, token) {
        this.username = username;
        this.token = token;        
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
    async fetchUserId() {
        const response = await this.apiCall(`${apiHost}/users/${this.username}`);
        const res = await response.json();
        return res.id;
    } 

    async fetchProjects(userId) {
        const response = await this.apiCall(`${apiHost}/users/${userId}/projects`);
        const res = await response.json();
        return res.result;
    }    

    async fetchFiles(projectId) {
        const response = await this.apiCall(`${apiHost}/projects/${projectId}/assets?view=extension&limit=10000`);
        const res = await response.json();
        return res.result;
    }

    async fetchFileContent(id, fileName) {
        const response = await this.apiCall(`${apiHost}/assets/${id}/file/${fileName}`);
        const res = await response.text();
        return res;
    }

    async uploadFile(id, filename, data) {
        const url = `${apiHost}/assets/${id}`;
        try {

            let form = new FormData();
            form.append('file', data, {
                filename: filename,
                contentType: 'text/plain',
            });

            const response = await fetch(url, {
                method: 'PUT',
                body: form,
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (!response.ok) {
                console.error('file upload failed:', response.statusText);
                return false;
            }

            return true;
        } catch(error) {
            console.error('API call failed:', error);
        }

        const response = await this.apiCall(`${apiHost}/assets/${id}/file/${fileName}`);
        const res = await response.text();
        return res;
    }    
}

module.exports = Api;
