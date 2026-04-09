import { Log } from '../log';
import type { Asset, Branch, Project, User } from '../typings/models';
import { summarize, tryCatch } from '../utils/utils';

import { FETCH_TIMEOUT_MS } from './constants';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30 * 1000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class Rest {
    private _log = new Log(this.constructor.name);

    private _disposed = false;

    url: string;

    origin: string;

    private _accessToken: string;

    constructor({ url, origin, accessToken }: { url: string; origin: string; accessToken: string }) {
        this.url = url;
        this.origin = origin;
        this._accessToken = accessToken;
    }

    dispose() {
        this._disposed = true;
    }

    private _backoff(attempt: number, retryAfter?: number) {
        if (retryAfter) {
            // respect server's Retry-After header
            return Math.min(retryAfter * 1000, MAX_DELAY_MS);
        }

        // exponential backoff with jitter
        const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
        return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
    }

    private _retryAfter(response: Response) {
        const retryAfter = response.headers.get('Retry-After');
        if (!retryAfter) {
            return undefined;
        }

        // try parsing as number (seconds)
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
            return seconds;
        }

        // try parsing as HTTP date
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            const delayMs = date.getTime() - Date.now();
            return Math.max(0, Math.ceil(delayMs / 1000));
        }

        return undefined;
    }

    private async _request<T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: object | FormData,
        type: 'json' | 'buffer' = 'json',
        auth = true
    ): Promise<T> {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const headers: Record<string, string> = { origin: this.origin };
            if (auth) {
                headers['Authorization'] = `Bearer ${this._accessToken}`;
            }
            if (body && !(body instanceof FormData)) {
                headers['Content-Type'] = 'application/json';
            }

            if (this._disposed) {
                throw new Error('REST client disposed');
            }

            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
            const [fetchErr, res] = await tryCatch(
                fetch(`${this.url}/${path}`, {
                    method,
                    headers,
                    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
                    signal: ctrl.signal
                }) as Promise<Response>
            );
            clearTimeout(timer);

            // network error
            if (fetchErr) {
                lastError = fetchErr;
                if (attempt < MAX_RETRIES) {
                    const delay = this._backoff(attempt);
                    this._log.warn(
                        `Request failed with network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${method} ${path}`
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                throw fetchErr;
            }

            // http error
            if (!res.ok) {
                const errorBody = await res.text();
                const error = new Error(`HTTP ${res.status} ${res.statusText}: ${errorBody}`);
                if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
                    lastError = error;
                    const delay = this._backoff(attempt, this._retryAfter(res));
                    this._log.warn(
                        `Request failed with ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${method} ${path}`
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                throw error;
            }

            // success
            const result = (type === 'buffer' ? await res.arrayBuffer() : await res.json()) as T;
            this._log.debug(res.status, method, path, summarize(result));
            return result;
        }

        throw lastError || new Error(`Request failed after ${MAX_RETRIES} retries`);
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
