import WebSocket, { type Data } from 'isomorphic-ws';
import { type } from 'ot-text';
import * as sharedb from 'sharedb/lib/client/index.js';
import type { Socket } from 'sharedb/lib/sharedb.js';

import { WEB } from '../config';
import { Log } from '../log';
import { Deferred } from '../utils/deferred';
import { EventEmitter } from '../utils/event-emitter';
import { signal } from '../utils/signal';

// register text type
sharedb.types.register(type);

type Connection = sharedb.Connection & {
    bindToSocket: (socket: Socket) => void;
    startBulk: () => void;
    endBulk: () => void;
};

type EventMap = {
    'doc:save': ['success' | 'error', number];
};

class ShareDb extends EventEmitter<EventMap> {
    static readonly SOURCE = 'vscode';

    private _log = new Log(this.constructor.name);

    private _active = new Deferred<[Connection, WebSocket]>();

    private _socket: WebSocket | null = null;

    private _connection: Connection | null = null;

    private _alive: ReturnType<typeof setInterval> | null = null;

    url: string;

    origin: string;

    subscriptions = new Map<string, sharedb.Doc>();

    connected = signal<boolean>(false);

    error = signal<Error | undefined>(undefined);

    constructor({ url, origin }: { url: string; origin: string }) {
        super();

        this.url = url;
        this.origin = origin;
    }

    private _connect(accessToken: string) {
        const options = WEB
            ? undefined
            : {
                  headers: {
                      origin: this.origin
                  }
              };
        const socket = new WebSocket(this.url, options);

        // send request for auth
        socket.addEventListener('open', () => {
            this._log.debug('socket.open');
            socket.send(`auth${JSON.stringify({ accessToken })}`);
        });

        // wait for auth response
        const onmessage = async ({ data }: { data: Data }) => {
            if (data.toString().startsWith('auth')) {
                socket.removeEventListener('message', onmessage);

                // check if auth was successful
                const json = JSON.parse(data.toString().slice(4));
                if (!json.id) {
                    const reason = `[${this.constructor.name}] invalid access token`;
                    socket.close(3000, reason);
                    throw this.error.set(() => new Error(reason));
                }
                this._log.debug('socket.auth', json);

                // authenticated
                await this._onauth(socket);
            }
        };
        socket.addEventListener('message', onmessage);

        // error event
        socket.addEventListener('error', ({ error }: { error: Error }) => {
            this._log.debug('socket.error', error);
        });

        // close event
        // ! use addEventListener as sharedb overrides onclose
        socket.addEventListener('close', ({ code, reason }: { code: number; reason: string }) => {
            this._log.debug('socket.close', code, reason.toString());

            // reset connected
            this._active = new Deferred();
            this.connected.set(() => false);

            // clear keep alive
            if (this._alive) {
                clearInterval(this._alive);
                this._alive = null;
            }

            // pause all docs
            for (const [key, doc] of this.subscriptions) {
                doc.pause();
                this._log.debug('paused', key);
            }

            // if not unauthorized error,try to reconnect
            if (code !== 3000) {
                setTimeout(() => {
                    this._socket = this._connect(accessToken);
                }, 1000);
            }
        });

        return socket;
    }

    private async _onauth(socket: WebSocket) {
        if (this._connection) {
            this._connection.bindToSocket(socket as Socket);
        } else {
            this._connection = new sharedb.Connection(socket as Socket) as Connection;
            this._connection.on('error', (err) => {
                this._log.debug(err);
            });
        }

        // reset keep alive
        if (this._alive) {
            clearInterval(this._alive);
        }
        this._alive = setInterval(() => {
            this._connection?.ping();
        }, 1000);

        // intercept for custom messages
        const onmessage = socket.onmessage?.bind(socket);
        socket.onmessage = (msg) => {
            // intercept custom messages
            const str = msg.data.toString();
            if (/^(\w+):/.test(str)) {
                this._log.debug(str);

                // handle doc:save
                if (str.startsWith('doc:save:')) {
                    const [, , state, uniqueId] = str.split(':');
                    this.emit('doc:save', state as 'success' | 'error', parseInt(uniqueId, 10));
                }
                return;
            }

            // resume normal processing
            onmessage?.(msg);
        };

        // intercept send to queue and forward to open socket
        const send = socket.send.bind(socket);
        socket.send = (data: Data) => {
            if (socket.readyState !== WebSocket.OPEN) {
                this.sendRaw(data);
                return;
            }
            send(data);
        };

        // resubscribe to existing docs
        for (const [key] of this.subscriptions) {
            const doc = this.subscriptions.get(key);
            if (!doc) {
                continue;
            }
            if (!doc.subscribed) {
                doc.subscribe();
            }
            doc.resume();
            this._log.debug('resumed', key);
        }

        // resolve active
        this._active.resolve([this._connection, socket]);
        this.connected.set(() => true);

        this._log.info('socket.connected');
    }

    async subscribe(type: string, key: string) {
        // check if already subscribed
        if (this.subscriptions.has(`${type}:${key}`)) {
            this._log.debug('skipped as already subscribed to', type, key);
            return this.subscriptions.get(`${type}:${key}`);
        }

        // subscribe to doc
        const [connection] = await this._active.promise;
        return new Promise<sharedb.Doc | undefined>((resolve) => {
            const doc = connection.get(type, key);
            doc.on('load', () => {
                this._log.debug('doc.load', type, key);
                resolve(doc);
            });
            doc.on('error', (err) => {
                this._log.debug('doc.error', err);
                resolve(undefined);
            });
            doc.on('destroy', () => {
                this._log.debug('doc.destroy', type, key);
            });
            doc.subscribe();
            this._log.debug('doc.subscribe', type, key);

            // track subscription
            this.subscriptions.set(`${type}:${key}`, doc);
        });
    }

    async bulkSubscribe(subscriptions: [string, string][]) {
        const [connection] = await this._active.promise;
        return new Promise<(sharedb.Doc | undefined)[]>((resolve) => {
            connection.startBulk();
            const docs = Promise.all(subscriptions.map(([type, key]) => this.subscribe(type, key)));
            connection.endBulk();
            docs.then(resolve);
        });
    }

    async unsubscribe(type: string, key: string) {
        // check if subscribed
        const doc = this.subscriptions.get(`${type}:${key}`);
        if (!doc) {
            this._log.debug('skipped as not subscribed to', type, key);
            return;
        }

        // unsubscribe from doc
        await this._active.promise;
        doc.destroy();

        // remove subscription
        this.subscriptions.delete(`${type}:${key}`);
    }

    async bulkUnsubscribe(subscriptions: [string, string][]) {
        const [connection] = await this._active.promise;
        return new Promise<void>((resolve) => {
            connection.startBulk();
            const unsubs = Promise.all(subscriptions.map(([type, key]) => this.unsubscribe(type, key)));
            connection.endBulk();
            unsubs.then(() => resolve());
        });
    }

    async sendRaw(data: Parameters<WebSocket['send']>[0]) {
        const [, socket] = await this._active.promise;
        socket.send(data);
    }

    async connect(accessToken: string) {
        this._socket = this._connect(accessToken);
        await this._active.promise;
    }

    disconnect() {
        // close all docs
        for (const [_key, doc] of this.subscriptions) {
            doc.destroy();
        }
        this.subscriptions.clear();

        // close connection
        this._connection?.close();

        // close socket
        this._socket?.close();

        this._log.info('disconnected');
    }
}

export { ShareDb };
