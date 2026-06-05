import * as vscode from 'vscode';

import * as buffer from '../utils/buffer';
import { norm } from '../utils/text';
import { hash, tryCatch, tryCatchSync } from '../utils/utils';

type BaseEntry = { text: string; hash: string };

// persists the merge base (server snapshot at last pull) per project+branch,
// in globalStorage so it never enters the user's workspace or git.
export class BaseStore {
    private _storageUri: vscode.Uri;

    private _entries = new Map<number, BaseEntry>();

    private _projectId?: number;

    private _branchId?: string;

    constructor({ storageUri }: { storageUri: vscode.Uri }) {
        this._storageUri = storageUri;
    }

    private _uri(projectId: number, branchId: string) {
        return vscode.Uri.joinPath(this._storageUri, 'base', `${projectId}-${branchId}.json`);
    }

    async load(projectId: number, branchId: string) {
        this._projectId = projectId;
        this._branchId = branchId;
        this._entries.clear();

        const [err, data] = await tryCatch(async () => vscode.workspace.fs.readFile(this._uri(projectId, branchId)));
        if (err) {
            return; // no base persisted yet
        }

        const [perr, parsed] = tryCatchSync(() => JSON.parse(buffer.toString(data)) as Record<string, BaseEntry>);
        if (perr || !parsed) {
            return; // corrupt base file — treat as empty
        }

        for (const [id, entry] of Object.entries(parsed)) {
            this._entries.set(Number(id), entry);
        }
    }

    get(uniqueId: number) {
        return this._entries.get(uniqueId);
    }

    set(uniqueId: number, text: string) {
        const value = norm(text);
        this._entries.set(uniqueId, { text: value, hash: hash(value) });
    }

    delete(uniqueId: number) {
        this._entries.delete(uniqueId);
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
            buffer.from(JSON.stringify(obj))
        );
    }
}
