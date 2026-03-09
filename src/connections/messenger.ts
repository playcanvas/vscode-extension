import WebSocket, { type Data } from 'isomorphic-ws';

import { WEB } from '../config';
import { Log } from '../log';
import { Deferred } from '../utils/deferred';
import { EventEmitter } from '../utils/event-emitter';
import { signal } from '../utils/signal';
import { withTimeout } from '../utils/utils';

import {
    CONNECT_TIMEOUT_MS,
    PING_INTERVAL_MS,
    PONG_TIMEOUT_MS,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS
} from './constants';
import { latency } from './latency';

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
        }
    ];
    'assets.delete': [
        {
            data: {
                assets: string[];
            };
        }
    ];
    'branch.switch': [
        {
            data: {
                project_id: number;
                branch_id: string;
                name: string;
            };
        }
    ];
    'branch.close': [
        {
            data: {
                project_id: number;
                branch_id: string;
                status: 'success' | 'error';
            };
        }
    ];
    'checkpoint.revertEnded': [
        {
            data: {
                project_id: number;
                branch_id: string;
                checkpoint_id: string;
                status: 'success' | 'error';
            };
        }
    ];
    'checkpoint.hardResetEnded': [
        {
            data: {
                project_id: number;
                branch_id: string;
                checkpoint_id: string;
                status: 'success' | 'error';
            };
        }
    ];
};

class Messenger extends EventEmitter<EventMap> {
    private _log = new Log(this.constructor.name);

    private _active = new Deferred<WebSocket>();

    private _socket: WebSocket | null = null;

    private _alive: ReturnType<typeof setInterval> | null = null;

    private _reconnectAttempt = 0;

    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private _disconnecting = false;

    private _getToken: (() => string) | null = null;

    private _lastPong = 0;

    private _pings: number[] = [];

    url: string;

    origin: string;

    watchers = new Set<number>();

    connected = signal<boolean>(false);

    ping = signal<number>(0);

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

            socket.send(
                JSON.stringify({
                    name: 'authenticate',
                    token: accessToken,
                    type: 'designer'
                })
            );
        });

        // wait for auth response
        const onmessage = ({ data }: { data: Data }) => {
            try {
                const json = JSON.parse(data.toString());
                if (json.name === 'welcome') {
                    socket.removeEventListener('message', onmessage);

                    // authenticated
                    this._onauth(socket);
                }
            } catch (e) {
                this._log.debug('messenger.message', e);
            }
        };
        socket.addEventListener('message', onmessage);

        // error event
        socket.addEventListener('error', ({ error }: { error: Error }) => {
            this._log.debug('socket.error', error);
        });

        // close event
        socket.addEventListener('close', ({ code, reason }: { code: number; reason: string }) => {
            this._log.debug('socket.close', code, reason.toString());

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
                const { name, ...rest } = JSON.parse(raw.toString());
                this._log.debug('socket.message', name, rest);
                this.emit(name, rest);
            } catch (e) {
                this._log.debug('socket.message', e);
            }
        });

        // re-watch all tracked projects
        for (const projectId of this.watchers) {
            if (socket.readyState !== WebSocket.OPEN) {
                break;
            }
            socket.send(
                JSON.stringify({
                    name: 'project.watch',
                    target: { type: 'general' },
                    env: ['*'],
                    data: { id: projectId }
                })
            );
            this._log.debug(`re-watching project ${projectId}`);
        }

        // resolve active
        this._active.resolve(socket);
        this.connected.set(() => true);

        this._log.info('socket.connected');
    }

    watch(projectId: number) {
        // check if already watching
        if (this.watchers.has(projectId)) {
            this._log.debug(`skipped as already watching project ${projectId}`);
            return;
        }

        // send watch request
        this.send({
            name: 'project.watch',
            target: { type: 'general' },
            env: ['*'],
            data: { id: projectId }
        })
            .then(() => {
                this._log.info(`watching project ${projectId}`);
            })
            .catch((err) => {
                this._log.warn('failed to send watch request', err);
            });

        // track watchers
        this.watchers.add(projectId);
    }

    unwatch(projectId: number) {
        // check if watching
        if (!this.watchers.has(projectId)) {
            this._log.debug(`skipped unwatching project ${projectId} as not watching`);
            return;
        }

        // send unwatch request
        this.send({
            name: 'project.unwatch',
            target: { type: 'general' },
            env: ['*'],
            data: { id: projectId }
        })
            .then(() => {
                this._log.info(`unwatched project ${projectId}`);
            })
            .catch((err) => {
                this._log.warn('failed to send watch request', err);
            });

        // remove from watchers
        this.watchers.delete(projectId);
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
        await withTimeout(this._active.promise, CONNECT_TIMEOUT_MS, 'Messenger connection timed out');
    }

    disconnect() {
        // mark as intentional disconnect
        this._disconnecting = true;
        this._cancelReconnect();

        // reject pending callers
        this._active.reject(new Error('disconnected'));
        this._active = new Deferred();

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

export { Messenger };
