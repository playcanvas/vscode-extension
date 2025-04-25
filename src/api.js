const fetch = require('node-fetch');
const FormData = require('form-data');
const Script = require('./script');
const vscode = require('vscode');

const apiHost = 'https://playcanvas.com/api';

const AssetModifiedError = new Error('Asset was modified, please pull the latest version');

/**
 * @typedef {Object} Asset
 * @property {number} id
 * @property {string} modifiedAt
 * @property {string} createdAt
 * @property {"ready"|"processing"|"error"} state
 * @property {string} name
 * @property {string} type
 * @property {{type: string, id: number}} scope
 * @property {boolean} source
 * @property {boolean} sourceId
 * @property {string[]} tags
 * @property {boolean} preload
 * @property {{hash: string, filename: string, size: number, url: string}} file
 * @property {number} parent
 */

class Api {
    /**
     * @param {vscode.ExtensionContext} context - The VSCode extension context.
     */
    constructor(context) {
        this.context = context;
    }

    /**
     * Retrieves the PlayCanvas access token from VSCode secrets or prompts the user to enter one.
     * @returns {Promise<string>} The access token.
     * @throws {Error} If the user cancels or provides an invalid token.
     */
    async getToken() {

        // clear token from plain text storage
        const config = vscode.workspace.getConfiguration("playcanvas");
        const accessToken = config.get("accessToken");
        if (accessToken && accessToken !== "") {
            await this.context.secrets.store("playcanvas.accessToken", accessToken);
            config.update("accessToken", undefined, vscode.ConfigurationTarget.Global);
        }

        // get a secret
        let token = await this.context.secrets.get("playcanvas.accessToken");
        if (!token) {
            token = await vscode.window.showInputBox({
                prompt: "Please set your PlayCanvas Access Token. Generate an access token on your [account page](https://playcanvas.com/account)",
                placeHolder: "Input your access token here.",
                ignoreFocusOut: true,
            });

            if (!token) {
                throw new Error('Unauthorized');
            }

            await this.context.secrets.store("playcanvas.accessToken", token);

            // Test access token
            try {
                await this.fetchUserId()
            } catch (error) {
                throw new Error('Invalid access token. Please check your token and try again.');
            }
        }
        return token;
    }

    /**
     * Makes an authenticated API call to the PlayCanvas REST API.
     * @param {string} url - The endpoint URL.
     * @param {string} [method='GET'] - HTTP method.
     * @param {any} [body=null] - Request body.
     * @param {Object} [headers={}] - Additional headers.
     * @returns {Promise<Response>} The fetch response object.
     * @throws {Error} On HTTP or network error.
     */
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
                params.headers['Content-Type'] = "application/json";
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

    /**
     * Fetches the current user's PlayCanvas user ID.
     * @returns {Promise<number>} The user ID.
     */
    async fetchUserId() {
        const response = await this.apiCall(`${apiHost}/id`);
        const res = await response.json();
        return res.id;
    }

    /**
     * Fetches all projects for a given user.
     * @param {number} userId - The PlayCanvas user ID.
     * @returns {Promise<Array>} List of projects.
     */
    async fetchProjects(userId) {
        const response = await this.apiCall(`${apiHost}/users/${userId}/projects`);
        const res = await response.json();
        return res.result;
    }

    /**
     * Fetches details for a specific project.
     * @param {number} id - The project ID.
     * @returns {Promise<Object>} Project details.
     */
    async fetchProject(id) {
        const response = await this.apiCall(`${apiHost}/projects/${id}`);
        const res = await response.json();
        return res;
    }

    /**
     * Fetches all branches for a given project.
     * @param {number} projectId - The project ID.
     * @returns {Promise<Array>} List of branches.
     */
    async fetchBranches(projectId) {
        const response = await this.apiCall(`${apiHost}/projects/${projectId}/branches`);
        const res = await response.json();
        return res.result;
    }

    /**
     * Fetches all assets for a project and branch.
     * @param {number} projectId - The project ID.
     * @param {string} [branchId] - The branch ID (optional).
     * @returns {Promise<Asset[]>} List of assets.
     */
    async fetchAssets(projectId, branchId) {
        const url = `${apiHost}/projects/${projectId}/assets?view=extension&limit=10000` + (branchId ? `&branchId=${branchId}` : '');
        const response = await this.apiCall(url);
        const res = await response.json();
        return res.result;
    }

    /**
     * Fetches details for a specific asset.
     * @param {number} assetId - The asset ID.
     * @param {string} [branchId] - The branch ID (optional).
     * @returns {Promise<Asset>} Asset details.
     */
    async fetchAsset(assetId, branchId) {
        const url = `${apiHost}/assets/${assetId}` + (branchId ? `?branchId=${branchId}` : '');
        const response = await this.apiCall(url);
        const res = await response.json();
        return res;
    }

    /**
     * Fetches the file content of an asset.
     * @param {number} id - The asset ID.
     * @param {string} fileName - The filename.
     * @param {string} [branchId] - The branch ID (optional).
     * @returns {Promise<string>} File content as text.
     */
    async fetchFileContent(id, fileName, branchId) {
        const url = `${apiHost}/assets/${id}/file/${fileName}` + (branchId ? `?branchId=${branchId}` : '');
        const response = await this.apiCall(url);
        const res = await response.text();
        return res;
    }

    /**
     * Renames an asset and/or moves it to a different folder.
     * @param {number} id - The asset ID.
     * @param {number} folderId - The target folder ID.
     * @param {string} newName - The new asset name.
     * @param {string} [branchId] - The branch ID (optional).
     * @returns {Promise<Asset>} The updated asset.
     */
    async renameAsset(id, folderId, newName, branchId) {
        const url = `${apiHost}/assets/${id}`;
        let form = new FormData();
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

    /**
     * Copies an asset from one project/branch to another.
     * @param {number} sourceProjectId - Source project ID.
     * @param {string} sourceProjectBranchId - Source branch ID.
     * @param {number} assetId - Asset ID to copy.
     * @param {number} targetProjectId - Target project ID.
     * @param {string} targetProjectBranchId - Target branch ID.
     * @param {number} folderId - Target folder ID.
     * @returns {Promise<Asset>} The copied asset.
     */
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

    /**
     * Creates a new asset in a project.
     * @param {number} projectId - The project ID.
     * @param {string} branchId - The branch ID.
     * @param {number} folderId - The parent folder ID.
     * @param {string} name - The asset name.
     * @param {string} type - The asset type.
     * @returns {Promise<Asset>} The created asset.
     */
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

    /**
     * Deletes an asset from a branch.
     * @param {number} id - The asset ID.
     * @param {string} branchId - The branch ID.
     * @returns {Promise<string>} The response text.
     */
    async deleteAsset(id, branchId) {
        const url = `${apiHost}/assets/${id}` + (branchId ? `?branchId=${branchId}` : '');
        const response = await this.apiCall(url, 'DELETE');
        const res = await response.text();
        return res;
    }

    /**
     * Uploads a new file for an asset, updating its content.
     * @param {number} id - The asset ID.
     * @param {string} filename - The filename.
     * @param {string} modifiedAt - The base modification time.
     * @param {string} branchId - The branch ID.
     * @param {Buffer|string} data - The file data.
     * @returns {Promise<Asset>} The updated asset.
     * @throws {Error|AssetModifiedError} On upload or conflict error.
     */
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
