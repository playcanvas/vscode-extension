// @ts-nocheck
const FormData = require('form-data');
const fetch = require('node-fetch');
const vscode = require('vscode');

const Script = require('./script.js');

const apiHost = 'https://playcanvas.com/api';

const AssetModifiedError = new Error('Asset was modified, please pull the latest version');

class Api {
    constructor(context) {
        this.context = context;
    }

    async getToken() {

        // clear token from plain text storage
        const config = vscode.workspace.getConfiguration('playcanvas');
        const accessToken = config.get('accessToken');
        if (accessToken && accessToken !== '') {
            await this.context.secrets.store('playcanvas.accessToken', accessToken);
            config.update('accessToken', undefined, vscode.ConfigurationTarget.Global);
        }

        // get a secret
        let token = await this.context.secrets.get('playcanvas.accessToken');
        if (!token) {
            token = await vscode.window.showInputBox({
                prompt: 'Please set your PlayCanvas Access Token. Generate an access token on your [account page](https://playcanvas.com/account)',
                placeHolder: 'Input your access token here.',
                ignoreFocusOut: true
            });

            if (!token) {
                throw new Error('Unauthorized');
            }

            await this.context.secrets.store('playcanvas.accessToken', token);

            // Test access token
            try {
                await this.fetchUserId();
            } catch (error) {
                throw new Error('Invalid access token. Please check your token and try again.');
            }
        }
        return token;
    }


    async apiCall(url, method = 'GET', body = null, headers = {}) {
        try {

            // ensure token exists
            const token = await this.getToken();
            if (!token) {
                throw new Error('Unauthorized');
            }

            const params = {
                method: method,
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            };
            if (body) {
                params.body = body;
            } else {
                params.headers['Content-Type'] = 'application/json';
            }
            for (const header in headers) {
                if (headers.hasOwnProperty(header)) { // This checks that the key is not from the object's prototype chain
                    params.headers[header] = headers[header];
                }
            }

            const response = await fetch(url, params);

            if (!response.ok) {
                const contentType = response.headers.get('content-type');

                if (contentType && contentType.includes('application/json')) {
                    const res = await response.json();
                    throw new Error(res.error ? res.error : 'apiCall failed');
                } else {
                    // Fallback (HTML, and other)
                    const text = await response.text();
                    throw new Error(`[${response.status}] ${response.statusText}: ${text}`);
                }
            }
            return response;
        } catch (error) {
            // if message has 'Unauthorized' in the string then clear token
            if (error.message.includes('Unauthorized')) {
                // clear token
                await this.context.secrets.delete('playcanvas.accessToken');
                throw new Error('Unauthorized. Please try again.');
            } else if (error.message.includes(AssetModifiedError.message)) {
                throw AssetModifiedError;
            }

            console.error('API call failed:', error);
            throw error;
        }
    }

    // get current user id
    async fetchUserId() {
        const response = await this.apiCall(`${apiHost}/id`);
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

    async fetchAssets(projectId, branchId) {
        const url = `${apiHost}/projects/${projectId}/assets?view=extension&limit=10000${branchId ? `&branchId=${branchId}` : ''}`;
        const response = await this.apiCall(url);
        const res = await response.json();
        return res.result;
    }

    async fetchAsset(assetId, branchId) {
        const url = `${apiHost}/assets/${assetId}${branchId ? `?branchId=${branchId}` : ''}`;
        const response = await this.apiCall(url);
        const res = await response.json();
        return res;
    }

    async fetchFileContent(id, fileName, branchId) {
        const url = `${apiHost}/assets/${id}/file/${fileName}${branchId ? `?branchId=${branchId}` : ''}`;
        const response = await this.apiCall(url);
        const res = await response.text();
        return res;
    }

    async renameAsset(id, folderId, newName, branchId) {
        const url = `${apiHost}/assets/${id}`;
        const form = new FormData();
        form.append('name', newName);
        form.append('parent', folderId ? folderId : 'null');
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
            'Content-Type': 'application/json'
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
        const asset = (ext === 'js') ? Script.create({ filename: name }) : {
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
        const url = `${apiHost}/assets/${id}${branchId ? `?branchId=${branchId}` : ''}`;
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

        try {
            const response = await this.apiCall(url, 'PUT', form);

            if (!response.ok) {
                const res = await response.json();

                if (res.message && res.message.includes(AssetModifiedError.message)) {
                    throw AssetModifiedError;
                }

                throw new Error(res.error);
            }

            const asset = await response.json();
            return asset;
        } catch (error) {
            switch (error) {
                case AssetModifiedError:
                    throw AssetModifiedError;
                default:
                    console.error('file upload failed:', error);
                    throw error;
            }
        }
    }
}

module.exports = { Api, AssetModifiedError };
