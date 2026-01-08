import { EventEmitter } from 'events';

import type * as sharedb from 'sharedb/lib/client/index.js';
import type { Snapshot, Callback, ShareDBSourceOptions, DocEventMap, Error } from 'sharedb/lib/sharedb.js';
import type sinon from 'sinon';

import { ShareDb } from '../../connections/sharedb';

import type { MockMessenger } from './messenger';
import { projectSettings, assets, documents } from './models';

class Doc implements sharedb.Doc {
    id = '';

    type = null;

    data: unknown = null;

    subscribed = true;

    connection: sharedb.Connection = {} as sharedb.Connection;

    collection = '';

    version: number | null = null;

    preventCompose = false;

    paused = false;

    submitSource = false;

    on(_type: string, _listener: (...args: unknown[]) => void): this {
        return this;
    }

    off(_type: string, _listener: (...args: unknown[]) => void): this {
        return this;
    }

    destroy(_callback?: Callback): void {
        return undefined;
    }

    pause(): void {
        return undefined;
    }

    resume(): void {
        return undefined;
    }

    submitOp(_data: unknown, _options?: { source: string }, _callback?: Callback): void {
        return undefined;
    }

    fetch(_callback?: (err: Error) => void): void {
        return undefined;
    }

    subscribe(_callback?: (err: Error) => void): void {
        return undefined;
    }

    unsubscribe(_callback?: (err: Error) => void): void {
        return undefined;
    }

    ingestSnapshot(_snapshot: Pick<Snapshot<unknown>, 'type' | 'data' | 'v'>, _callback?: Callback): void {
        return undefined;
    }

    create(_data: unknown, _type?: unknown, _options?: unknown, _callback?: unknown): void {
        return undefined;
    }

    del(_options: ShareDBSourceOptions, _callback?: (err: Error) => void): void {
        return undefined;
    }

    whenNothingPending(_callback: () => void): void {
        return undefined;
    }

    hasPending(): boolean {
        return false;
    }

    hasWritePending(): boolean {
        return false;
    }

    flush(): void {
        return undefined;
    }

    addListener<U extends keyof DocEventMap<unknown>>(_event: U, _listener: DocEventMap<unknown>[U]): this {
        return this;
    }

    prependListener<U extends keyof DocEventMap<unknown>>(_event: U, _listener: DocEventMap<unknown>[U]): this {
        return this;
    }

    prependOnceListener<U extends keyof DocEventMap<unknown>>(_event: U, _listener: DocEventMap<unknown>[U]): this {
        return this;
    }

    removeListener<U extends keyof DocEventMap<unknown>>(_event: U, _listener: DocEventMap<unknown>[U]): this {
        return this;
    }

    removeAllListeners(_event?: keyof DocEventMap<unknown> | undefined): this {
        return this;
    }

    once<U extends keyof DocEventMap<unknown>>(_event: U, _listener: DocEventMap<unknown>[U]): this {
        return this;
    }

    emit<U extends keyof DocEventMap<unknown>>(_event: U, ..._args: Parameters<DocEventMap<unknown>[U]>): boolean {
        return false;
    }

    eventNames(): (keyof DocEventMap<unknown>)[] {
        return [];
    }

    listenerCount(_type: keyof DocEventMap<unknown>): number {
        return 0;
    }

    listeners<U extends keyof DocEventMap<unknown>>(_type: U): DocEventMap<unknown>[U][] {
        return [];
    }

    rawListeners<U extends keyof DocEventMap<unknown>>(_type: U): DocEventMap<unknown>[U][] {
        return [];
    }

    getMaxListeners(): number {
        return 10;
    }

    setMaxListeners(_n: number): this {
        return this;
    }
}

class MockDoc extends Doc {
    on: sinon.SinonSpy<[type: string, listener: (...args: unknown[]) => void], this>;

    off: sinon.SinonSpy<[type: string, listener: (...args: unknown[]) => void], this>;

    destroy: sinon.SinonSpy<[], void>;

    pause: sinon.SinonSpy<[], void>;

    resume: sinon.SinonSpy<[], void>;

    submitOp: sinon.SinonSpy<[op: unknown, options?: { source: string }], void>;

    constructor(sandbox: sinon.SinonSandbox, type: string, key: string) {
        super();
        switch (type) {
            case 'assets': {
                this.data = assets.get(parseInt(key, 10));
                break;
            }
            case 'documents': {
                this.data = documents.get(parseInt(key, 10));
                break;
            }
            case 'settings': {
                this.data = projectSettings;
                break;
            }
        }

        const events = new EventEmitter();
        this.on = sandbox.spy((type: string, listener: (...args: unknown[]) => void) => {
            events.on(type, listener);
            return this;
        });
        this.off = sandbox.spy((type: string, listener: (...args: unknown[]) => void) => {
            events.off(type, listener);
            return this;
        });
        this.destroy = sandbox.spy(() => {
            return;
        });
        this.pause = sandbox.spy(() => {
            return;
        });
        this.resume = sandbox.spy(() => {
            return;
        });
        this.submitOp = sandbox.spy((op: unknown, options?: { source: string }) => {
            // apply the op to the data
            // FIXME: standardize op format and reuse in extension code
            if (Array.isArray(op) && type === 'documents' && typeof this.data === 'string') {
                switch (op.length) {
                    case 1: {
                        const [arg] = op;
                        switch (typeof arg) {
                            case 'string': {
                                // insert at start
                                this.data = `${arg}${this.data}`;
                                break;
                            }
                            case 'object': {
                                if ('d' in arg) {
                                    // delete from start
                                    this.data = this.data.slice(arg.d);
                                }
                                break;
                            }
                        }
                        break;
                    }
                    case 2: {
                        const [index, arg] = op;
                        switch (typeof arg) {
                            case 'string': {
                                // insert at index
                                this.data = this.data.slice(0, index) + arg + this.data.slice(index);
                                break;
                            }
                            case 'object': {
                                if ('d' in arg) {
                                    // delete from index
                                    this.data = this.data.slice(0, index) + this.data.slice(index + arg.d);
                                }
                                break;
                            }
                        }
                        break;
                    }
                    case 3: {
                        const [index, arg1, arg2] = op;
                        if ('d' in arg2) {
                            // delete and insert at index
                            this.data = this.data.slice(0, index) + arg1 + this.data.slice(index + arg2.d);
                        }
                        break;
                    }
                }
            }

            events.emit('op', op as unknown[], options?.source || '');
        });
    }
}

class MockShareDb extends ShareDb {
    subscriptions = new Map<string, MockDoc>();

    connect: sinon.SinonSpy<[string], Promise<void>>;

    disconnect: sinon.SinonSpy<[], void>;

    subscribe: sinon.SinonSpy<[string, string], Promise<MockDoc>>;

    bulkSubscribe: sinon.SinonSpy<[[string, string][]], Promise<MockDoc[]>>;

    unsubscribe: sinon.SinonSpy<[string, string], Promise<void>>;

    bulkUnsubscribe: sinon.SinonSpy<[[string, string][]], Promise<void>>;

    sendRaw: sinon.SinonSpy<[Parameters<WebSocket['send']>[0]], Promise<void>>;

    constructor(sandbox: sinon.SinonSandbox, messenger: MockMessenger) {
        super({ url: '', origin: '' });

        this.connect = sandbox.spy(async (_accessToken: string) => {
            this.connected.set(() => true);
        });
        this.disconnect = sandbox.spy(() => {
            this.connected.set(() => false);
        });
        this.subscribe = sandbox.spy(async (type: string, key: string) => {
            const doc = new MockDoc(sandbox, type, key);
            this.subscriptions.set(`${type}:${key}`, doc);
            return doc;
        });
        this.bulkSubscribe = sandbox.spy(async (subscriptions: [string, string][]) => {
            return Promise.all(subscriptions.map(([type, key]) => this.subscribe(type, key)));
        });
        this.unsubscribe = sandbox.spy(async (type: string, key: string) => {
            this.subscriptions.delete(`${type}:${key}`);
        });
        this.bulkUnsubscribe = sandbox.spy(async (subscriptions: [string, string][]) => {
            await Promise.all(subscriptions.map(([type, key]) => this.unsubscribe(type, key)));
        });
        this.sendRaw = sandbox.spy(async (data: Parameters<WebSocket['send']>[0]) => {
            // check for fs operations
            if (`${data}`.startsWith('fs')) {
                const raw = data.toString().slice(2);
                const json = JSON.parse(raw) as
                    | { op: 'delete'; ids: number[] }
                    | { op: 'move'; ids: number[]; to: number };

                // handle delete operation
                if (json.op === 'delete') {
                    for (const id of json.ids) {
                        assets.delete(id);
                        documents.delete(id);
                    }
                    messenger.emit('assets.delete', {
                        data: {
                            assets: json.ids.map((id) => id.toString())
                        }
                    });
                    return;
                }

                // handle move operation
                if (json.op === 'move') {
                    for (const id of json.ids) {
                        const asset = assets.get(id);
                        if (asset) {
                            const path = asset.path.slice();
                            asset.path = json.to === 0 ? [] : [json.to];
                            const doc = this.subscriptions.get(`assets:${id}`);
                            if (doc) {
                                if (path.length === 0 && asset.path.length === 1) {
                                    // moved into folder
                                    doc.submitOp([{ p: ['path'], li: asset.path[0] }], { source: 'remote' });
                                } else if (path.length === 1 && asset.path.length === 0) {
                                    // moved out of folder
                                    doc.submitOp([{ p: ['path'], ld: path[0] }], { source: 'remote' });
                                } else if (path.length === 1 && asset.path.length === 1) {
                                    // moved between folders
                                    doc.submitOp([{ p: ['path'], ld: path[0], li: asset.path[0] }], {
                                        source: 'remote'
                                    });
                                }
                            }
                        }
                    }
                    return;
                }

                return;
            }

            if (`${data}`.startsWith('doc:save')) {
                const raw = data.toString().slice(8);
                const id = parseInt(raw, 10);
                this.emit('doc:save', 'success', id);
                return;
            }
            return;
        });
    }
}

export { MockShareDb };
