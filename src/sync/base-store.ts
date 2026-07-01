import * as vscode from 'vscode';

import * as buffer from '../utils/buffer';
import { norm } from '../utils/text';
import { hash, tryCatch, tryCatchSync } from '../utils/utils';

type ConflictEntry = { base: string; local: string; remote: string };
export type BaseEntry = {
    text: string;
    hash: string;
    conflict?: ConflictEntry;
};
type BaseFile = {
    version?: 1;
    entries?: Record<string, BaseEntry>;
};

// persists the merge base (last-pulled text per file, keyed by uniqueId) per
// project+branch, in globalStorage so it never enters the workspace or git.
export class BaseStore {
    private _storageUri: vscode.Uri;

    private _entries = new Map<number, BaseEntry>();

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
        for (const [id, entry] of Object.entries(entries)) {
            this._entries.set(Number(id), entry);
        }
    }

    get(uniqueId: number) {
        return this._entries.get(uniqueId);
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
            buffer.from(JSON.stringify({ version: 1, entries: obj }))
        );
    }
}
