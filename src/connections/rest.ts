import type { Asset, Branch, Project, User } from '../typings/models';

class Rest {
    private _debug: boolean;

    url: string;

    origin: string;

    accessToken: string;

    constructor({
        debug = false,
        url,
        origin,
        accessToken
    }: {
        debug?: boolean;
        url: string;
        origin: string;
        accessToken: string;
    }) {
        this._debug = debug;

        this.url = url;
        this.origin = origin;
        this.accessToken = accessToken;
    }

    private _log(...args: unknown[]) {
        if (!this._debug) {
            return;
        }
        console.log(`[${this.constructor.name}]`, ...args);
    }

    private async _request<T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: object | FormData,
        type: 'json' | 'buffer' = 'json',
        auth = true
    ): Promise<T> {
        const headers: Record<string, string> = {
            origin: this.origin
        };
        if (auth) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }
        const res = await fetch(`${this.url}/${path}`, {
            method,
            headers,
            body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${await res.text()}`);
        }
        switch (type) {
            case 'buffer': {
                const buf = await res.arrayBuffer();
                this._log(res.status, method, path, buf);
                return buf as T;
            }
            case 'json': {
                const json = await res.json();
                this._log(res.status, method, path, json);
                return json as T;
            }
        }
    }

    async assetCreate(
        projectId: number,
        branchId: string,
        data: {
            type: string;
            name: string;
            preload: boolean;
            parent?: number;
            filename?: string;
            file?: Blob;
        }
    ) {
        const form = new FormData();
        form.append('projectId', `${projectId}`);
        form.append('branchId', branchId);
        form.append('type', data.type);
        form.append('name', data.name);
        form.append('preload', `${data.preload}`);
        if (data.parent) {
            form.append('parent', `${data.parent}`);
        }
        if (data.filename) {
            form.append('filename', data.filename);
        }
        if (data.file && data.file.size) {
            form.append('file', data.file, data.filename || data.name);
        }
        return this._request<Asset>('POST', `assets`, form);
    }

    async assetRename(projectId: number, branchId: string, assetId: number, name: string) {
        const form = new FormData();
        form.append('projectId', `${projectId}`);
        form.append('branchId', branchId);
        form.append('name', name);
        return this._request<Asset>('PUT', `assets/${assetId}`, form);
    }

    async assetFile(assetId: number, branchId: string, filename: string) {
        return this._request<ArrayBuffer>(
            'GET',
            `assets/${assetId}/file/${filename}?branchId=${branchId}`,
            undefined,
            'buffer'
        );
    }

    async branchCheckout(branchId: string) {
        return this._request<Branch>('POST', `branches/${branchId}/checkout`);
    }

    async projectAssets(projectId: number, branchId: string, view = '') {
        return this._request<Asset[]>('GET', `projects/${projectId}/assets?branchId=${branchId}&view=${view}`);
    }

    async projectBranches(projectId: number) {
        const { result } = await this._request<{ result: Branch[] }>('GET', `projects/${projectId}/branches`);
        return result;
    }

    async id() {
        const { id } = await this._request<{ id: number }>('GET', 'id');
        return id;
    }

    async user(userId: number) {
        return await this._request<User>('GET', `users/${userId}`);
    }

    async userThumb(userId: number) {
        return await this._request<ArrayBuffer>('GET', `users/${userId}/thumbnail?size=28`, undefined, 'buffer', false);
    }

    async userProjects(userId: number, view = '') {
        const { result } = await this._request<{ result: Project[] }>('GET', `users/${userId}/projects?view=${view}`);
        return result;
    }
}

export { Rest };
