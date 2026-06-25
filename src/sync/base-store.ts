import { randomUUID } from 'crypto';

import * as vscode from 'vscode';

import type { SyncItem, SyncPullResponse } from '../connections/rest';
import * as buffer from '../utils/buffer';
import { norm } from '../utils/text';
import { hash, tryCatch, tryCatchSync } from '../utils/utils';

type ConflictEntry = { base: string; local: string; remote: string };
type ItemType = 'file' | 'folder';
export type BaseEntry = {
    id?: number;
    path?: string;
    type?: ItemType;
    text: string;
    hash: string;
    conflict?: ConflictEntry;
};
type BaseFile = {
    version?: 1;
    clientId?: string;
    seq?: number;
    base?: string;
    entries?: Record<string, BaseEntry>;
};

// persists the merge base (server snapshot at last pull) per project+branch,
// in globalStorage so it never enters the user's workspace or git.
export class BaseStore {
    private _storageUri: vscode.Uri;

    private _entries = new Map<number, BaseEntry>();

    private _pathIds = new Map<string, number>();

    private _clientId: string = randomUUID();

    private _seq = 0;

    private _base = '';

    private _projectId?: number;

    private _branchId?: string;

    private _folderId = 'default';

    constructor({ storageUri }: { storageUri: vscode.Uri }) {
        this._storageUri = storageUri;
    }

    private _uri(projectId: number, branchId: string) {
        return vscode.Uri.joinPath(this._storageUri, 'base', `${projectId}-${branchId}-${this._folderId}.json`);
    }

    async load(projectId: number, branchId: string, folderId = 'default') {
        this._projectId = projectId;
        this._branchId = branchId;
        this._folderId = folderId;
        this._entries.clear();
        this._pathIds.clear();
        this._clientId = randomUUID();
        this._seq = 0;
        this._base = '';

        const [err, data] = await tryCatch(async () => vscode.workspace.fs.readFile(this._uri(projectId, branchId)));
        if (err) {
            return; // no base persisted yet
        }

        const [perr, parsed] = tryCatchSync(
            () => JSON.parse(buffer.toString(data)) as BaseFile | Record<string, BaseEntry>
        );
        if (perr || !parsed) {
            return; // corrupt base file — treat as empty
        }

        const file = parsed as BaseFile;
        const entries = file.entries ? file.entries : (parsed as Record<string, BaseEntry>);
        if (typeof file.clientId === 'string') {
            this._clientId = file.clientId;
        }
        if (typeof file.seq === 'number' && Number.isSafeInteger(file.seq)) {
            this._seq = file.seq;
        }
        if (typeof file.base === 'string') {
            this._base = file.base;
        }

        for (const [id, entry] of Object.entries(entries)) {
            const key = Number(id);
            this._entries.set(key, entry);
            if (entry.path !== undefined) {
                this._pathIds.set(entry.path, key);
            }
        }
    }

    get(uniqueId: number) {
        return this._entries.get(uniqueId);
    }

    get base() {
        return this._base;
    }

    get clientId() {
        return this._clientId;
    }

    get seq() {
        return this._seq;
    }

    setBase(base: string) {
        this._base = base;
    }

    setSeq(seq: number) {
        this._seq = seq;
    }

    byPath(path: string) {
        const id = this._pathIds.get(path);
        return id === undefined ? undefined : this._entries.get(id);
    }

    items() {
        return Array.from(this._entries.values());
    }

    private _entry(item: SyncItem) {
        const text = norm(item.type === 'file' ? (item.text ?? '') : '');
        return {
            ...this._entries.get(item.id),
            id: item.id,
            path: item.path,
            type: item.type,
            text,
            hash: hash(text)
        };
    }

    setItem(item: SyncItem) {
        const current = this._entries.get(item.id);
        if (current?.path !== undefined) {
            this._pathIds.delete(current.path);
        }
        const entry = this._entry(item);
        this._entries.set(item.id, entry);
        this._pathIds.set(item.path, item.id);
    }

    deleteItem(id: number) {
        const entry = this._entries.get(id);
        if (entry?.path !== undefined) {
            this._pathIds.delete(entry.path);
        }
        this._entries.delete(id);
    }

    setSnapshot(snapshot: SyncPullResponse) {
        const entries = new Map<number, BaseEntry>();
        const paths = new Map<string, number>();
        for (const item of snapshot.items) {
            const entry = this._entry(item);
            entries.set(item.id, entry);
            paths.set(item.path, item.id);
        }
        this._entries = entries;
        this._pathIds = paths;
        this._base = snapshot.base;
    }

    set(uniqueId: number, text: string) {
        const value = norm(text);
        this._entries.set(uniqueId, { ...this._entries.get(uniqueId), text: value, hash: hash(value) });
    }

    conflict(uniqueId: number) {
        return this._entries.get(uniqueId)?.conflict;
    }

    setConflict(uniqueId: number, conflict: ConflictEntry) {
        const entry = this._entries.get(uniqueId);
        if (entry) {
            entry.conflict = conflict;
        }
    }

    deleteConflict(uniqueId: number) {
        const entry = this._entries.get(uniqueId);
        if (entry) {
            delete entry.conflict;
        }
    }

    async flush() {
        if (this._projectId === undefined || this._branchId === undefined) {
            return;
        }
        const obj: Record<string, BaseEntry> = {};
        for (const [id, entry] of this._entries) {
            obj[id] = entry;
        }
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this._storageUri, 'base'));
        await vscode.workspace.fs.writeFile(
            this._uri(this._projectId, this._branchId),
            buffer.from(
                JSON.stringify({
                    version: 1,
                    clientId: this._clientId,
                    seq: this._seq,
                    base: this._base,
                    entries: obj
                })
            )
        );
    }
}
