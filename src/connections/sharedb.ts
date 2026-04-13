import WebSocket, { type Data } from 'isomorphic-ws';
import { type } from 'ot-text';
import * as sharedb from 'sharedb/lib/client/index.js';
import type { Socket } from 'sharedb/lib/sharedb.js';

import { WEB } from '../config';
import { Log } from '../log';
import { Deferred } from '../utils/deferred';
import { fail } from '../utils/error';
import { EventEmitter } from '../utils/event-emitter';
import { signal } from '../utils/signal';
import { tryCatch, withTimeout } from '../utils/utils';

import {
    AUTH_CLOSE_CODE,
    CONNECT_TIMEOUT_MS,
    PING_INTERVAL_MS,
    PONG_TIMEOUT_MS,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
    SUBSCRIBE_TIMEOUT_MS
} from './constants';
import { delay, latency } from './latency';

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

    private _reconnectAttempt = 0;

    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private _disconnecting = false;

    private _getToken: (() => string) | null = null;

    private _lastPong = 0;

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

    private _connect() {
        this._disconnecting = false;

        const accessToken = this._getToken!();
        const options = WEB
            ? undefined
            : {
                  headers: {
                      origin: this.origin
                  }
              };
        const socket = latency(new WebSocket(this.url, options));

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
                    this.error.set(() => fail`${reason}`);
                    return;
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

            // reject pending callers then reset
            this._active.reject(fail`connection reset`);
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

            // skip reconnect if intentionally disconnected
            if (this._disconnecting) {
                return;
            }

            // skip reconnect on auth failure — retrying with same token won't help
            if (code === AUTH_CLOSE_CODE) {
                return;
            }

            // schedule reconnection with backoff
            this._scheduleReconnect();
        });

        return socket;
    }

    private async _onauth(socket: WebSocket) {
        // reset backoff on successful auth
        this._reconnectAttempt = 0;
        this._lastPong = Date.now();

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
            // check for pong timeout — server pings every 1s so we should always receive data
            if (Date.now() - this._lastPong > PONG_TIMEOUT_MS) {
                this._log.warn('pong timeout, closing socket');
                socket.close(4001, 'pong timeout');
                return;
            }
            this._connection?.ping();
        }, PING_INTERVAL_MS);

        // intercept for custom messages
        const onmessage = socket.onmessage?.bind(socket);
        socket.onmessage = (msg) => {
            // update last pong on any incoming message
            this._lastPong = Date.now();

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

            // resume normal processing (delay for latency simulation)
            const d = delay();
            if (d > 0) {
                setTimeout(() => onmessage?.(msg), d);
            } else {
                onmessage?.(msg);
            }
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
        const doc = connection.get(type, key);
        const onload = () => {
            this._log.debug('doc.load', type, key);
            this.subscriptions.set(`${type}:${key}`, doc);
        };
        const pending = new Promise<sharedb.Doc | undefined>((resolve) => {
            doc.on('load', () => {
                onload();
                resolve(doc);
            });
            doc.on('error', (err) => {
                this._log.debug('doc.error', err);
                this.subscriptions.delete(`${type}:${key}`);
                doc.destroy();
                resolve(undefined);
            });
            doc.on('destroy', () => {
                this._log.debug('doc.destroy', type, key);
                this.subscriptions.delete(`${type}:${key}`);
            });
            doc.subscribe();
            this._log.debug('doc.subscribe', type, key);
        });
        const [err, value] = await tryCatch(
            withTimeout(pending, SUBSCRIBE_TIMEOUT_MS, `subscribe timed out for ${type}:${key}`)
        );
        if (err) {
            this._log.warn(err.message);
            doc.removeAllListeners('load');
            doc.removeAllListeners('error');
            this.subscriptions.delete(`${type}:${key}`);
            doc.destroy();
            return undefined;
        }
        return value;
    }

    async bulkSubscribe(subscriptions: [string, string][]) {
        const [connection] = await this._active.promise;
        connection.startBulk();
        const docs = Promise.all(subscriptions.map(([type, key]) => this.subscribe(type, key)));
        connection.endBulk();
        return docs;
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
        connection.startBulk();
        const unsubs = Promise.all(subscriptions.map(([type, key]) => this.unsubscribe(type, key)));
        connection.endBulk();
        await unsubs;
    }

    async sendRaw(data: Parameters<WebSocket['send']>[0]) {
        const [, socket] = await this._active.promise;
        socket.send(data);
    }

    private _scheduleReconnect() {
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt), RECONNECT_MAX_MS);
        this._log.info(`reconnecting in ${delay}ms (attempt ${this._reconnectAttempt + 1})`);
        this._reconnectAttempt++;
        this._reconnectTimer = setTimeout(() => {
            if (this._disconnecting) {
                return;
            }
            this._socket = this._connect();
        }, delay);
    }

    private _cancelReconnect() {
        this._reconnectAttempt = 0;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    async connect(getToken: () => string) {
        this._getToken = getToken;
        this._socket = this._connect();
        await withTimeout(this._active.promise, CONNECT_TIMEOUT_MS, 'ShareDB connection timed out');
    }

    disconnect() {
        // mark as intentional disconnect
        this._disconnecting = true;
        this._cancelReconnect();

        // reject pending callers
        this._active.reject(fail`disconnected`);
        this._active = new Deferred();

        // clear keep alive
        if (this._alive) {
            clearInterval(this._alive);
            this._alive = null;
        }

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
