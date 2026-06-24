import type { ShareDbTextOp } from './sharedb';

export type EventMap = {
    'asset:create': [number];
    'asset:update': [number, string, unknown, unknown];
    'asset:delete': [number];

    'asset:file:create': [string, 'file' | 'folder', Uint8Array];
    'asset:file:update': [string, ShareDbTextOp, string, string];
    'asset:file:delete': [string];
    'asset:file:rename': [string, string];
    'asset:file:save': [string];
    'asset:file:dirty': [string, boolean];
    'asset:file:failed': [string];
    'asset:file:subscribed': [string, string, boolean];

    'sync:file:create': [string, 'file' | 'folder'];
    'sync:file:update': [string];
    'sync:file:delete': [string, 'file' | 'folder'];
    'sync:file:rename': [string, string, 'file' | 'folder'];
    'sync:file:apply:create': [string, 'file' | 'folder', Uint8Array, (err?: Error) => void];
    'sync:file:apply:update': [string, Uint8Array, (err?: Error) => void];
    'sync:file:apply:delete': [string, (err?: Error) => void];
    'sync:file:apply:rename': [string, string, (err?: Error) => void];

    'asset:doc:open': [string];
    'asset:doc:close': [string];
};
