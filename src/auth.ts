import http from 'http';

import * as vscode from 'vscode';

import { API_URL, COOKIE_NAME, NAME, PUBLISHER, HOME_URL, LOGIN_URL, PLAYCANVAS_VERSION, PORT, WEB } from './config';
import { AUTH_TIMEOUT_MS } from './connections/constants';
import { Rest } from './connections/rest';
import { tryCatch } from './utils/utils';

type Session = {
    accessToken: string;
    userId: number;
};

type EditorConfig = {
    engineVersion: string;
};

const SESSION_ID_KEY = `${NAME}.sessionId`;
const ENGINE_VERSION_KEY = `${NAME}.engineVersion`;
const EDITOR_CONFIG_TTL_MS = 5 * 60 * 1000;

export const parseEditorConfig = (text: string) => {
    const accessToken = /["']accessToken["']\s*:\s*["']([^"']+)["']/.exec(text)?.[1];
    const engineVersion =
        /["']?engineVersions["']?\s*:\s*\{[\s\S]*?["']?current["']?\s*:\s*\{[\s\S]*?["']?version["']?\s*:\s*["']([^"']+)["']/.exec(
            text
        )?.[1];
    return { accessToken, engineVersion };
};

class Auth {
    private _context: vscode.ExtensionContext;

    private _session?: Session;

    private _validating = new Map<string, Promise<Session | undefined>>();

    private _login?: Promise<string>;

    private _reload?: Promise<void>;

    private _config?: { engineVersion: string; ts: number };

    private _configReq?: Promise<EditorConfig>;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    async getStoredAccessToken() {
        return this._context.secrets.get(`${NAME}.accessToken`);
    }

    async clearAccessToken() {
        this._clear();
        await this._context.secrets.delete(`${NAME}.accessToken`);
        await this._context.secrets.delete(SESSION_ID_KEY);
    }

    private _clear() {
        this._session = undefined;
        this._validating.clear();
        this._login = undefined;
        this._reload = undefined;
        this._configReq = undefined;
    }

    private async _cachedEngineVersion() {
        if (this._config) {
            return this._config.engineVersion;
        }
        const version = this._context.globalState?.get<string>(ENGINE_VERSION_KEY);
        return version || PLAYCANVAS_VERSION;
    }

    private async _storeEngineVersion(engineVersion?: string) {
        if (!engineVersion) {
            return;
        }
        this._config = { engineVersion, ts: Date.now() };
        await this._context.globalState?.update(ENGINE_VERSION_KEY, engineVersion);
    }

    private async _fetchEditorConfig(sessionId: string) {
        const current = await this._cachedEngineVersion();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), AUTH_TIMEOUT_MS);
        const [fetchErr, res] = await tryCatch(
            fetch(`${HOME_URL}/editor`, {
                headers: {
                    Cookie: `${COOKIE_NAME}=${sessionId}`
                },
                signal: ctrl.signal
            }) as Promise<Response>
        );
        clearTimeout(timer);
        if (fetchErr || !res.ok) {
            return { engineVersion: current };
        }

        const [textErr, text] = await tryCatch(res.text() as Promise<string>);
        if (textErr) {
            return { engineVersion: current };
        }

        const { engineVersion } = parseEditorConfig(text);
        await this._storeEngineVersion(engineVersion);
        return { engineVersion: engineVersion || current };
    }

    async getEditorConfig() {
        const cached = this._config;
        if (cached && Date.now() - cached.ts < EDITOR_CONFIG_TTL_MS) {
            return { engineVersion: cached.engineVersion };
        }

        const sessionId = await this._context.secrets.get(SESSION_ID_KEY);
        if (!sessionId || WEB) {
            return { engineVersion: await this._cachedEngineVersion() };
        }

        if (this._configReq) {
            return this._configReq;
        }

        const task = this._fetchEditorConfig(sessionId);
        this._configReq = task;
        const [err, config] = await tryCatch(task);
        this._configReq = undefined;
        if (err) {
            return { engineVersion: await this._cachedEngineVersion() };
        }
        return config;
    }

    async getClient(manual = false) {
        let accessToken = await this.getStoredAccessToken();
        while (true) {
            if (!accessToken) {
                if (!manual) {
                    return;
                }
                accessToken = await this.getAccessToken(true, false);
                if (!accessToken) {
                    return;
                }
            }

            const session = await this._validateAccessToken(accessToken, false);
            if (session) {
                return {
                    accessToken: session.accessToken,
                    userId: session.userId,
                    rest: new Rest({
                        url: API_URL,
                        origin: HOME_URL,
                        accessToken: session.accessToken
                    })
                };
            }

            await this.clearAccessToken();
            if (!manual) {
                return;
            }
            accessToken = undefined;
        }
    }

    private async _validate(accessToken: string, notify = true) {
        const rest = new Rest({
            url: API_URL,
            origin: HOME_URL,
            accessToken
        });
        const [err, userId] = await tryCatch(rest.id());
        rest.dispose();
        if (!err) {
            const session = { accessToken, userId };
            this._session = session;
            return session;
        }
        if (/HTTP 4\d{2}/.test(err.message)) {
            if (notify) {
                await vscode.window.showErrorMessage('Invalid PlayCanvas Access Token', { modal: true });
            }
            return;
        }
        throw err;
    }

    private async _validateAccessToken(accessToken?: string, notify = true) {
        if (!accessToken) {
            return;
        }

        if (this._session?.accessToken === accessToken) {
            return this._session;
        }

        const running = this._validating.get(accessToken);
        if (running) {
            return running;
        }

        const task = this._validate(accessToken, notify);
        this._validating.set(accessToken, task);
        const [err, session] = await tryCatch(task);
        this._validating.delete(accessToken);
        if (err) {
            throw err;
        }
        return session;
    }

    private _requestToken() {
        // FIXME: Add web login token flow
        if (WEB) {
            return vscode.window.showInputBox({
                prompt: 'Enter your PlayCanvas Editor Access Token',
                ignoreFocusOut: true,
                password: true
            });
        }

        // FIXME: Improve server side OAuth flow to avoid opening a local server and parsing HTML
        return new Promise<string>((resolve, reject) => {
            const ctrl = new AbortController();
            const timeout = setTimeout(() => {
                ctrl.abort();
                server.close();
                reject(new Error('Authentication timed out. Please try again.'));
            }, AUTH_TIMEOUT_MS);
            const server = http.createServer(async (req, res) => {
                if (req.url?.startsWith('/auth/callback')) {
                    const url = new URL(req.url, `http://localhost:${PORT}`);
                    const query = url.searchParams;
                    const code = query.get('code');

                    // validate code
                    if (!code) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Missing code query parameter.');
                        return;
                    }

                    // exchange code for session id
                    const res2 = await fetch(`${LOGIN_URL}/auth/oauth2`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ code }),
                        signal: ctrl.signal
                    });
                    if (!res2.ok) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Failed to exchange code for session id.');
                        clearTimeout(timeout);
                        ctrl.abort();
                        server.close();
                        reject(new Error('Failed to exchange code for session id.'));
                        return;
                    }
                    const { sessionId } = (await res2.json()) as unknown as { sessionId: string };

                    // build cookie
                    const cookie = `${COOKIE_NAME}=${sessionId}`;

                    // fetch access token
                    const res3 = await fetch(`${HOME_URL}/editor`, {
                        headers: {
                            Cookie: cookie
                        },
                        signal: ctrl.signal
                    });
                    if (!res3.ok) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Failed to fetch access token.');
                        clearTimeout(timeout);
                        ctrl.abort();
                        server.close();
                        reject(new Error('Failed to fetch access token.'));
                        return;
                    }
                    const text = await res3.text();
                    const { accessToken, engineVersion } = parseEditorConfig(text);
                    if (!accessToken) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Failed to parse access token.');
                        clearTimeout(timeout);
                        ctrl.abort();
                        server.close();
                        reject(new Error('Failed to parse access token.'));
                        return;
                    }
                    await this._context.secrets.store(SESSION_ID_KEY, sessionId);
                    await this._storeEngineVersion(engineVersion);

                    // resolve access token
                    clearTimeout(timeout);
                    resolve(accessToken);

                    // redirect to vscode
                    const uri = vscode.Uri.from({
                        scheme: vscode.env.uriScheme,
                        authority: `${PUBLISHER}.${NAME}`
                    });
                    res.writeHead(302, { Location: uri.toString() });
                    res.end();

                    // close server
                    server.close();
                }
            });
            server
                .listen(PORT, () => {
                    const oauthUri = vscode.Uri.parse(LOGIN_URL).with({
                        query: `came_from=http://localhost:${PORT}/auth/callback`
                    });
                    void vscode.env.openExternal(oauthUri);
                })
                .on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
        });
    }

    private async _loginAccessToken(manual: boolean) {
        if (this._login) {
            return this._login;
        }

        const task = this._loginFlow(manual);
        this._login = task;
        const [err, accessToken] = await tryCatch(task);
        this._login = undefined;
        if (err) {
            throw err;
        }
        return accessToken;
    }

    private async _loginFlow(manual: boolean) {
        while (true) {
            // request token
            const accessToken = await this._requestToken();
            if (!accessToken) {
                if (manual) {
                    void vscode.window.showInformationMessage('Aborted updating PlayCanvas Access Token');
                    return '';
                }
                continue;
            }

            // validate token
            const session = await this._validateAccessToken(accessToken);
            if (!session) {
                continue;
            }

            // store token
            await this._context.secrets.store(`${NAME}.accessToken`, accessToken);
            void vscode.window.showInformationMessage('PlayCanvas Access Token validated');
            return accessToken;
        }
    }

    private async _reloadWindow() {
        if (this._reload) {
            return this._reload;
        }

        // reload window to ensure all components use the new token
        const task = Promise.resolve(
            vscode.window.showInformationMessage('Token updated, the window will be reloaded.', {
                modal: true
            })
        ).then(() => {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
        this._reload = task;
        const [err] = await tryCatch(task);
        this._reload = undefined;
        if (err) {
            throw err;
        }
    }

    async getAccessToken(manual = false, reload = manual) {
        let accessToken: string | undefined = undefined;
        if (!manual) {
            // retrieve stored token
            accessToken = await this._context.secrets.get(`${NAME}.accessToken`);

            // validate token
            const session = await this._validateAccessToken(accessToken);
            accessToken = session?.accessToken;
        }

        if (!accessToken) {
            accessToken = await this._loginAccessToken(manual);
        }

        if (accessToken && reload) {
            await this._reloadWindow();
        }

        return accessToken;
    }

    async logout() {
        const confirmed = await vscode.window.showWarningMessage(
            'Are you sure you want to log out?',
            { modal: true },
            'Logout'
        );
        if (confirmed !== 'Logout') {
            return;
        }
        await this.clearAccessToken();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }

    async reset(reason = 'unknown reason') {
        await vscode.window.showErrorMessage(
            [reason, 'Token will be reset and the window will be reloaded.'].join('\n\n'),
            {
                modal: true
            }
        );
        await this.clearAccessToken();
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

export { Auth };
