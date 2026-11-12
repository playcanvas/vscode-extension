import * as vscode from 'vscode';

import * as buffer from '../utils/buffer';
import { norm } from '../utils/text';
import { hash, tryCatch, tryCatchSync } from '../utils/utils';

type ConflictEntry = { base: string; local: string; remote: string };
export type BaseEntry = {
    text: string;
    hash: string;
    path?: string;
    savedHash?: string;
    conflict?: ConflictEntry;
};
type BaseFile = {
    version?: 1;
    entries?: Record<string, BaseEntry>;

    // local identifies a push awaiting server confirmation
    pending?: { from: string; path: string; local?: number };
};

// persists the merge base (last-pulled text per file, keyed by uniqueId) per
// project+branch, in globalStorage so it never enters the workspace or git.
export class BaseStore {
    private _storageUri: vscode.Uri;

    private _entries = new Map<number, BaseEntry>();

    private _projectId?: number;

    private _branchId?: string;

    private _folderId = 'default';

    private _writing = Promise.resolve();

    pending?: BaseFile['pending'];

    constructor({ storageUri }: { storageUri: vscode.Uri }) {
        this._storageUri = storageUri;
    }

    private _uri(projectId: number, branchId: string) {
        return vscode.Uri.joinPath(this._storageUri, 'base', `${projectId}-${branchId}-${this._folderId}.json`);
    }

    // the folder's last-linked branch, so a switch can tell which files it left clean
    private _branchUri(projectId: number) {
        return vscode.Uri.joinPath(this._storageUri, 'base', `${projectId}-${this._folderId}.branch`);
    }

    private async _read(projectId: number, branchId: string) {
        const [err, data] = await tryCatch(async () => vscode.workspace.fs.readFile(this._uri(projectId, branchId)));
        if (err) {
            return undefined; // no base persisted yet
        }

        const [perr, parsed] = tryCatchSync(
            () => JSON.parse(buffer.toString(data)) as BaseFile | Record<string, BaseEntry>
        );
        if (perr || !parsed) {
            return undefined; // corrupt base file — treat as empty
        }

        const file = parsed as BaseFile;
        return { pending: file.pending, entries: file.entries ? file.entries : (parsed as Record<string, BaseEntry>) };
    }

    async load(projectId: number, branchId: string, folderId = 'default') {
        this._projectId = projectId;
        this._branchId = branchId;
        this._folderId = folderId;
        this._entries.clear();
        this.pending = undefined;

        const file = await this._read(projectId, branchId);
        if (!file) {
            return;
        }
        this.pending = file.pending;
        for (const [id, entry] of Object.entries(file.entries)) {
            this._entries.set(Number(id), entry);
        }
    }

    async lastBranch() {
        if (this._projectId === undefined) {
            return undefined;
        }
        const [err, data] = await tryCatch(async () => vscode.workspace.fs.readFile(this._branchUri(this._projectId!)));
        return err ? undefined : buffer.toString(data) || undefined;
    }

    async setLastBranch() {
        if (this._projectId === undefined || this._branchId === undefined) {
            return;
        }
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this._storageUri, 'base'));
        await vscode.workspace.fs.writeFile(this._branchUri(this._projectId), buffer.from(this._branchId));
    }

    // last-synced hashes per path in another branch's record
    async hashes(branchId: string) {
        const out = new Map<string, Set<string>>();
        if (this._projectId === undefined) {
            return out;
        }
        const file = await this._read(this._projectId, branchId);
        for (const entry of Object.values(file?.entries ?? {})) {
            if (typeof entry?.path !== 'string' || typeof entry.hash !== 'string') {
                continue;
            }
            const set = out.get(entry.path) ?? new Set<string>();
            set.add(entry.hash);
            out.set(entry.path, set);
        }
        return out;
    }

    get(uniqueId: number) {
        return this._entries.get(uniqueId);
    }

    // drop entries for assets the server no longer has (deleted, or keyed by
    // another branch's uniqueId), so stale paths and texts never replay
    prune(live: Set<number>) {
        for (const id of Array.from(this._entries.keys())) {
            if (!live.has(id)) {
                this._entries.delete(id);
            }
        }
    }

    rename(from: string, path: string) {
        for (const entry of this._entries.values()) {
            if (entry.path === from || entry.path?.startsWith(`${from}/`)) {
                entry.path = path + entry.path.slice(from.length);
            }
        }
    }

    set(uniqueId: number, text: string, savedHash?: string) {
        const value = norm(text);
        const existing = this._entries.get(uniqueId);
        this._entries.set(uniqueId, {
            ...existing,
            text: value,
            hash: hash(value),
            savedHash: savedHash ?? existing?.savedHash
        });
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
        const uri = this._uri(this._projectId, this._branchId);
        const temp = uri.with({ path: `${uri.path}.tmp` });
        const content = buffer.from(JSON.stringify({ version: 1, entries: obj, pending: this.pending }));
        this._writing = tryCatch(this._writing).then(async () => {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this._storageUri, 'base'));
            await vscode.workspace.fs.writeFile(temp, content);
            await vscode.workspace.fs.rename(temp, uri, { overwrite: true });
        });
        await this._writing;
    }
}
