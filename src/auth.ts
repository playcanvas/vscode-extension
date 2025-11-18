import http from 'http';

import * as vscode from 'vscode';

import { API_URL, COOKIE_NAME, DEBUG, HOME_URL, LOGIN_URL, PORT, WEB } from './config';
import { Rest } from './connections/rest';
import { catchError } from './utils/utils';

class Auth {
    private _context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    private async _validateAccessToken(accessToken?: string) {
        if (!accessToken) {
            return;
        }
        const rest = new Rest({
            debug: DEBUG,
            url: API_URL,
            origin: HOME_URL,
            accessToken
        });
        const [error] = await catchError(() => rest.id());
        if (error && /HTTP 4\d{2}/.test(error.message)) {
            await vscode.window.showErrorMessage('Invalid PlayCanvas Access Token', { modal: true });
            return;
        }
        return accessToken;
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
                        body: JSON.stringify({ code })
                    });
                    if (!res2.ok) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Failed to exchange code for session id.');
                        return;
                    }
                    const { sessionId } = (await res2.json()) as unknown as { sessionId: string };

                    // build cookie
                    const cookie = `${COOKIE_NAME}=${sessionId}`;

                    // fetch access token
                    const res3 = await fetch(`${HOME_URL}/editor`, {
                        headers: {
                            Cookie: cookie
                        }
                    });
                    if (!res3.ok) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Failed to fetch access token.');
                        return;
                    }
                    const text = await res3.text();
                    const matches = /"accessToken":\s*"(\w+)"/.exec(text);
                    const accessToken = matches?.[1];
                    if (!accessToken) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Failed to parse access token.');
                        return;
                    }

                    // resolve access token
                    resolve(accessToken);

                    // respond to the browser
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('You can now close this window and return to VS Code.');

                    // close server
                    server.close();
                }
            });
            server
                .listen(PORT, () => {
                    const oauthUri = vscode.Uri.parse(LOGIN_URL).with({
                        query: `came_from=http://localhost:${PORT}/auth/callback`
                    });
                    vscode.env.openExternal(oauthUri);
                })
                .on('error', reject);
        });
    }

    async getAccessToken(cancellable = false) {
        let accessToken: string | undefined = undefined;
        if (!cancellable) {
            // retrieve stored token
            accessToken = await this._context.secrets.get('playcanvas.accessToken');

            // validate token
            accessToken = await this._validateAccessToken(accessToken);
        }
        while (!accessToken) {
            // request token
            accessToken = await this._requestToken();
            if (!accessToken) {
                if (cancellable) {
                    vscode.window.showInformationMessage('Aborted updating PlayCanvas Access Token');
                    return '';
                }
                continue;
            }

            // validate token
            accessToken = await this._validateAccessToken(accessToken);
            if (!accessToken) {
                continue;
            }

            // store token
            await this._context.secrets.store('playcanvas.accessToken', accessToken);
            vscode.window.showInformationMessage('PlayCanvas Access Token validated');
        }

        return accessToken;
    }

    async reset(reason = 'unknown reason') {
        await vscode.window.showErrorMessage(
            [reason, 'Token will be reset and the window will be reloaded.'].join('\n\n'),
            {
                modal: true
            }
        );
        await this._context.secrets.delete('playcanvas.accessToken');
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

export { Auth };
