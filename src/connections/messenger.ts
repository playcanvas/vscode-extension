import WebSocket, { type Data } from 'isomorphic-ws';

import { WEB } from '../config';
import { Deferred } from '../utils/deferred';
import { EventEmitter } from '../utils/event-emitter';
import { signal } from '../utils/signal';

type EventMap = {
    'asset.new': [
        {
            data: {
                asset: {
                    id: string;
                    name: string;
                    type: string;
                    branchId: string;
                };
            };
        },
    ];
    'assets.delete': [
        {
            data: {
                assets: string[];
            };
        },
    ];
    'branch.switch': [
        {
            data: {
                project_id: number;
                branch_id: string;
                name: string;
            };
        },
    ];
    'branch.close': [
        {
            data: {
                project_id: number;
                branch_id: string;
                status: 'success' | 'error';
            };
        },
    ];
    'checkpoint.revertEnded': [
        {
            data: {
                project_id: number;
                branch_id: string;
                checkpoint_id: string;
                status: 'success' | 'error';
            };
        },
    ];
    'checkpoint.hardResetEnded': [
        {
            data: {
                project_id: number;
                branch_id: string;
                checkpoint_id: string;
                status: 'success' | 'error';
            };
        },
    ];
};

class Messenger extends EventEmitter<EventMap> {
    private _debug: boolean;

    private _active = new Deferred<WebSocket>();

    private _socket: WebSocket | null = null;

    private _alive: ReturnType<typeof setInterval> | null = null;

    url: string;

    origin: string;

    connected = signal<boolean>(false);

    constructor({ debug = false, url, origin }: { debug?: boolean; url: string; origin: string }) {
        super();
        this._debug = debug;

        this.url = url;
        this.origin = origin;
    }

    private _log(...args: unknown[]) {
        if (!this._debug) {
            return;
        }
        console.log(`[${this.constructor.name}]`, ...args);
    }

    private _connect(accessToken: string) {
        const options = WEB
            ? undefined
            : {
                  headers: {
                      origin: this.origin,
                  },
              };
        const socket = new WebSocket(this.url, options);

        // send request for auth
        socket.addEventListener('open', () => {
            this._log('socket.open');

            socket.send(
                JSON.stringify({
                    name: 'authenticate',
                    token: accessToken,
                    type: 'designer',
                }),
            );
        });

        // wait for auth response
        const onmessage = async ({ data }: { data: Data }) => {
            try {
                const json = JSON.parse(data.toString());
                if (json.name === 'welcome') {
                    socket.removeEventListener('message', onmessage);

                    // authenticated
                    await this._onauth(socket);
                }
            } catch (e) {
                this._log('messenger.message', e);
            }
        };
        socket.addEventListener('message', onmessage);

        // error event
        socket.addEventListener('error', ({ error }: { error: Error }) => {
            this._log('socket.error', error);
        });

        // close event
        socket.addEventListener('close', ({ code, reason }: { code: number; reason: string }) => {
            this._log('socket.close', code, reason.toString());

            // reset connected
            this._active = new Deferred();
            this.connected.set(() => false);

            // clear keep alive
            if (this._alive) {
                clearInterval(this._alive);
                this._alive = null;
            }

            // if not internal error,try to reconnect
            if (code !== 1011) {
                setTimeout(() => {
                    this._socket = this._connect(accessToken);
                }, 1000);
            }
        });

        return socket;
    }

    private _onauth(socket: WebSocket) {
        // reset keep alive
        if (this._alive) {
            clearInterval(this._alive);
        }
        this._alive = setInterval(() => {
            socket.send(JSON.stringify('ping'));
        }, 1000);

        // on message handler
        socket.addEventListener('message', ({ data: raw }: { data: Data }) => {
            if (raw.toString() === 'pong') {
                return;
            }
            try {
                const { name, ...rest } = JSON.parse(raw.toString());
                this._log('socket.message', name, rest);
                this.emit(name, rest);
            } catch (e) {
                this._log('socket.message', e);
            }
        });

        // resolve active
        this._active.resolve(socket);
        this.connected.set(() => true);

        this._log('socket.connected');
    }

    watch(projectId: number) {
        this.send({
            name: 'project.watch',
            target: { type: 'general' },
            env: ['*'],
            data: { id: projectId },
        }).then(() => {
            this._log(`watching project ${projectId}`);
        });
    }

    unwatch(projectId: number) {
        this.send({
            name: 'project.unwatch',
            target: { type: 'general' },
            env: ['*'],
            data: { id: projectId },
        }).then(() => {
            this._log(`unwatched project ${projectId}`);
        });
    }

    async send(data: object) {
        const socket = await this._active.promise;
        socket.send(JSON.stringify(data));
    }

    async connect(accessToken: string) {
        this._socket = this._connect(accessToken);
        await this._active.promise;
    }

    disconnect() {
        // close socket
        this._socket?.close();

        this._log('disconnected');
    }
}

export { Messenger };
