import WebSocket, { type Data } from 'isomorphic-ws';

import { WEB } from '../config';
import { Log } from '../log';
import { Deferred } from '../utils/deferred';
import { EventEmitter } from '../utils/event-emitter';
import { signal } from '../utils/signal';
import { withTimeout } from '../utils/utils';

import {
    AUTH_CLOSE_CODE,
    CONNECT_TIMEOUT_MS,
    PING_INTERVAL_MS,
    PONG_TIMEOUT_MS,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS
} from './constants';
import { latency } from './latency';

type EventMap = {
    'room:join': [{ name: string; userId: number; users?: number[] }];
    'room:leave': [{ name: string; userId: number }];
};

class Relay extends EventEmitter<EventMap> {
    private _log = new Log(this.constructor.name);

    private _active = new Deferred<WebSocket>();

    private _socket: WebSocket | null = null;

    private _alive: ReturnType<typeof setInterval> | null = null;

    private _authTimeout: ReturnType<typeof setTimeout> | null = null;

    private _reconnectAttempt = 0;

    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private _disconnecting = false;

    private _getToken: (() => string) | null = null;

    private _lastPong = 0;

    private _pings: number[] = [];

    url: string;

    origin: string;

    rooms = new Map<number, Set<string>>();

    connected = signal<boolean>(false);

    ping = signal<number>(0);

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
                      origin: this.origin,
                      authorization: `Bearer ${accessToken}`,
                      cookie: 't=0'
                  }
              };
        const socket = latency(new WebSocket(this.url, options));

        // send request for auth
        // ! Invalid access tokens will hang here
        this._authTimeout = setTimeout(() => {
            this._authTimeout = null;
            const reason = `[${this.constructor.name}] invalid access token`;
            // TODO: figure out why this triggers 1006 not 3000
            socket.close(3000, reason);
            this.error.set(() => new Error(reason));
        }, 5000);
        socket.addEventListener('open', () => {
            this._log.debug('socket.open');
            if (this._authTimeout) {
                clearTimeout(this._authTimeout);
                this._authTimeout = null;
            }

            this._onauth(socket);
        });

        // error event
        socket.addEventListener('error', ({ error }: { error: Error }) => {
            this._log.debug('socket.error', error);
        });

        // close event
        socket.addEventListener('close', ({ code, reason }: { code: number; reason: string }) => {
            this._log.debug('socket.close', code, reason.toString());

            // clear auth timeout if still pending
            if (this._authTimeout) {
                clearTimeout(this._authTimeout);
                this._authTimeout = null;
            }

            // reject pending callers then reset
            this._active.reject(new Error('connection reset'));
            this._active = new Deferred();
            this.connected.set(() => false);

            // clear keep alive
            if (this._alive) {
                clearInterval(this._alive);
                this._alive = null;
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

    private _onauth(socket: WebSocket) {
        // reset backoff on successful auth
        this._reconnectAttempt = 0;
        this._lastPong = Date.now();

        // reset keep alive
        if (this._alive) {
            clearInterval(this._alive);
        }
        this._alive = setInterval(() => {
            // check for pong timeout
            if (Date.now() - this._lastPong > PONG_TIMEOUT_MS) {
                this._log.warn('pong timeout, closing socket');
                socket.close(4001, 'pong timeout');
                return;
            }
            // app-level ping — server responds with bare "pong" (not JSON-encoded)
            this._pings.push(Date.now());
            socket.send(JSON.stringify('ping'));
        }, PING_INTERVAL_MS);

        // on message handler
        socket.addEventListener('message', ({ data: raw }: { data: Data }) => {
            if (raw.toString() === 'pong') {
                this._lastPong = Date.now();
                const sent = this._pings.shift();
                if (sent) {
                    this.ping.set(() => this._lastPong - sent);
                }
                return;
            }
            try {
                const { t, error, ...rest } = JSON.parse(raw.toString());
                if (error) {
                    this._log.warn('relay.error', error);
                    return;
                }

                this._log.debug('socket.message', t, rest);
                this.emit(t, rest);
            } catch (e) {
                this._log.debug('socket.message', e);
            }
        });

        // re-join all tracked rooms
        for (const [projectId, roomNames] of this.rooms) {
            for (const name of roomNames) {
                if (socket.readyState !== WebSocket.OPEN) {
                    break;
                }
                socket.send(
                    JSON.stringify({
                        t: 'room:join',
                        name,
                        authentication: {
                            type: 'project',
                            id: projectId
                        }
                    })
                );
                this._log.debug(`re-joining room ${name}`);
            }
        }

        // resolve active
        this._active.resolve(socket);
        this.connected.set(() => true);

        this._log.info('socket.connected');
    }

    join(name: string, projectId: number) {
        // check if already joined
        if (this.rooms.get(projectId)?.has(name)) {
            this._log.debug(`skipped joining room ${name} as already joined`);
            return;
        }

        // join room
        void this.send({
            t: 'room:join',
            name: name,
            authentication: {
                type: 'project',
                id: projectId
            }
        })
            .then(() => {
                this._log.debug(`joined room ${name}`);
            })
            .catch((err) => {
                this._log.warn('failed to send room message', err);
            });

        // track joined rooms
        if (!this.rooms.has(projectId)) {
            this.rooms.set(projectId, new Set());
        }
        this.rooms.get(projectId)?.add(name);
    }

    leave(name: string, projectId: number) {
        // check if joined
        if (!this.rooms.get(projectId)?.has(name)) {
            this._log.debug(`skipped leaving room ${name} as not joined`);
            return;
        }

        // leave room
        void this.send({
            t: 'room:leave',
            name: name
        })
            .then(() => {
                this._log.debug(`left room ${name}`);
            })
            .catch((err) => {
                this._log.warn('failed to send room message', err);
            });

        // track left rooms
        this.rooms.get(projectId)?.delete(name);
    }

    message(name: string, msg: object, userId?: number) {
        void this.send({
            t: 'room:msg',
            msg: msg,
            name: name,
            to: userId
        })
            .then(() => {
                this._log.debug(`sent message to room ${name}`, msg);
            })
            .catch((err) => {
                this._log.warn('failed to send room message', err);
            });
    }

    async send(data: object) {
        const socket = await this._active.promise;
        socket.send(JSON.stringify(data));
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
        await withTimeout(this._active.promise, CONNECT_TIMEOUT_MS, 'Relay connection timed out');
    }

    disconnect() {
        // mark as intentional disconnect
        this._disconnecting = true;
        this._cancelReconnect();

        // reject pending callers
        this._active.reject(new Error('disconnected'));
        this._active = new Deferred();

        // clear auth timeout
        if (this._authTimeout) {
            clearTimeout(this._authTimeout);
            this._authTimeout = null;
        }

        // clear keep alive
        if (this._alive) {
            clearInterval(this._alive);
            this._alive = null;
        }

        // close socket
        this._socket?.close();

        this._log.info('disconnected');
    }
}

export { Relay };
