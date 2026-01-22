import WebSocket, { type Data } from 'isomorphic-ws';

import { WEB } from '../config';
import { Log } from '../log';
import { Deferred } from '../utils/deferred';
import { EventEmitter } from '../utils/event-emitter';
import { signal } from '../utils/signal';

type EventMap = {
    'room:join': [{ name: string; userId: number; users?: number[] }];
    'room:leave': [{ name: string; userId: number }];
};

class Relay extends EventEmitter<EventMap> {
    private _log = new Log(this.constructor.name);

    private _active = new Deferred<WebSocket>();

    private _socket: WebSocket | null = null;

    private _alive: ReturnType<typeof setInterval> | null = null;

    url: string;

    origin: string;

    rooms = new Map<number, Set<string>>();

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
                      origin: this.origin,
                      authorization: `Bearer ${accessToken}`,
                      cookie: 't=0'
                  }
              };
        const socket = new WebSocket(this.url, options);

        // send request for auth
        // ! Invalid access tokens will hang here
        const timeout = setTimeout(() => {
            const reason = `[${this.constructor.name}] invalid access token`;
            // TODO: figure out why this triggers 1006 not 3000
            socket.close(3000, reason);
            throw this.error.set(() => new Error(reason));
        }, 5000);
        socket.addEventListener('open', () => {
            this._log.debug('socket.open');
            clearTimeout(timeout);

            this._onauth(socket);
        });

        // error event
        socket.addEventListener('error', ({ error }: { error: Error }) => {
            this._log.debug('socket.error', error);
        });

        // close event
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

            // if closed abnormally, try to reconnect
            setTimeout(() => {
                this._socket = this._connect(accessToken);
            }, 1000);
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
        this.send({
            t: 'room:join',
            name: name,
            authentication: {
                type: 'project',
                id: projectId
            }
        }).then(() => {
            this._log.debug(`joined room ${name}`);
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
        this.send({
            t: 'room:leave',
            name: name
        }).then(() => {
            this._log.debug(`left room ${name}`);
        });

        // track left rooms
        this.rooms.get(projectId)?.delete(name);
    }

    message(name: string, msg: object, userId?: number) {
        this.send({
            t: 'room:msg',
            msg: msg,
            name: name,
            to: userId
        }).then(() => {
            this._log.debug(`sent message to room ${name}`, msg);
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

        this._log.info('disconnected');
    }
}

export { Relay };
