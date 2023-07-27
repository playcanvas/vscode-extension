const fetch = require('node-fetch');
const apiHost = 'https://playcanvas.com/api';
const FormData = require('form-data');
const Script = require('./script');
const vscode = require('vscode');
class Api {
    constructor() {  
        this.token = null; 
    }

    getToken() {
        if (!this.token) {
            const config = vscode.workspace.getConfiguration('playcanvas');
            this.token = config.get('accessToken');
        }
        return this.token;
    }

    async apiCall(url, method = 'GET', body = null, headers = {}) {
        try {
            const params = {
                method: method,
                headers: {
                    'Authorization': `Bearer ${this.getToken()}`
                }
            };
            if (body) {
                params.body = body;
            } else {
                params.headers['Content-Type'] = "application/json";
            }
            for (const header in headers) {
                if (headers.hasOwnProperty(header)) { // This checks that the key is not from the object's prototype chain
                  params.headers[header] = headers[header];
                }
              }            
            
            const response = await fetch(url, params);
            if (!response.ok) {
                const res = await response.json();
                throw new Error(res.error ? res.error : 'apiCall failed');
            }
            return response;
        } catch(error) {
            console.error('API call failed:', error);
            throw error;
        }
    }

    // get current user id from username
    async fetchUserId() {

        const config = vscode.workspace.getConfiguration('playcanvas');
        const username = config.get('username');

        const response = await this.apiCall(`${apiHost}/users/${username}`);        
        const res = await response.json();
        return res.id;
    } 

    async fetchProjects(userId) {
        const response = await this.apiCall(`${apiHost}/users/${userId}/projects`);
        const res = await response.json();
        return res.result;
    }  
    
    async fetchProject(id) {
        const response = await this.apiCall(`${apiHost}/projects/${id}`);
        const res = await response.json();
        return res;
    }      

    async fetchBranches(projectId) {
        const response = await this.apiCall(`${apiHost}/projects/${projectId}/branches`);
        const res = await response.json();
        return res.result;
    }

    async fetchFiles(projectId, branchId) {
        const url = `${apiHost}/projects/${projectId}/assets?view=extension&limit=10000` + (branchId ? `&branchId=${branchId}` : '');
        const response = await this.apiCall(url);
        const res = await response.json();
        return res.result;
    }

    async fetchFileContent(id, fileName, branchId) {
        const url = `${apiHost}/assets/${id}/file/${fileName}` + (branchId ? `?branchId=${branchId}` : '');
        const response = await this.apiCall(url);
        const res = await response.text();
        return res;
    }

    async renameAsset(id, newName, branchId) {
        const url = `${apiHost}/assets/${id}`;
        let form = new FormData();
        form.append('name', newName);
        if (branchId) {
            form.append('branchId', branchId);
        }

        const response = await this.apiCall(url, 'PUT', form);
        if (!response.ok) {
            const res = await response.json();
            throw new Error(res.error);
        }

        const asset = await response.json();
        return asset;
    } 

    async copyAsset(sourceProjectId, sourceProjectBranchId, assetId, targetProjectId, targetProjectBranchId, folderId) {
        const url = `${apiHost}/assets/paste`;
        const body = {
            projectId: sourceProjectId,
            assets: [assetId],
            targetProjectId: targetProjectId,          
            targetFolderId: folderId
        };

        if (sourceProjectBranchId) {
            body.branchId = sourceProjectBranchId;
        }

        if (targetProjectBranchId) {
            body.targetBranchId = targetProjectBranchId;
        }

        const response = await this.apiCall(url, 'POST', JSON.stringify(body), {
            'Content-Type': "application/json"
        });
        if (!response.ok) {
            const res = await response.json();
            throw new Error(res.error);
        }

        const asset = await response.json();
        return asset;
    } 

    async createAsset(projectId, branchId, folderId, name, type) {
        const url = `${apiHost}/assets/`;

        const ext = name.split('.').pop();
        const asset = (ext === 'js') ? Script.create({filename: name}) : {
            contentType: 'text/plain',
            content: '',
            filename: name,
            preload: false            
        };

        const form = new FormData();
        if (type !== 'folder') {
            form.append('file', asset.content, {
                filename: asset.filename,
                contentType: asset.contentType
            });
        }

        form.append('preload', asset.preload ? 'true' : 'false');
        form.append('projectId', projectId);
        form.append('name', name);

        if (type) {
            form.append('type', type);
        }

        if (folderId) {
            form.append('parent', folderId);
        }

        if (branchId) {
            form.append('branchId', branchId);
        }

        const response = await this.apiCall(url, 'POST', form);
        if (!response.ok) {
            const res = await response.json();
            console.error('file upload failed:', res.error);
            throw new Error(res.error);
        }

        return await response.json();
    } 

    async deleteAsset(id, branchId) {
        const url = `${apiHost}/assets/${id}` + (branchId ? `?branchId=${branchId}` : '');
        const response = await this.apiCall(url, 'DELETE');
        const res = await response.text();
        return res;
    }    

    async uploadFile(id, filename, modifiedAt, branchId, data) {
        const url = `${apiHost}/assets/${id}`;

        const form = new FormData();
        form.append('file', data, {
            filename: filename,
            contentType: 'text/plain'
        });
        form.append('baseModificationTime', modifiedAt);
        if (branchId) {
            form.append('branchId', branchId);
        }

        const response = await this.apiCall(url, 'PUT', form);
        if (!response.ok) {
            const res = await response.json();
            console.error('file upload failed:', res.error);
            throw new Error(res.error);
        }

        const asset = await response.json();
        return asset;
    }
}

module.exports = Api;
