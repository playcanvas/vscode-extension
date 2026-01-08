import type { ShareDbTextOp } from './sharedb';

export type EventMap = {
    'asset:create': [number];
    'asset:update': [number, string, unknown, unknown];
    'asset:delete': [number];

    'asset:file:create': [string, 'file' | 'folder', Uint8Array];
    'asset:file:update': [string, ShareDbTextOp, Uint8Array];
    'asset:file:delete': [string];
    'asset:file:rename': [string, string];
    'asset:file:save': [string];

    'asset:doc:open': [string];
    'asset:doc:close': [string];
};
