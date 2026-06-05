import * as vscode from 'vscode';

import type { ProjectManager } from '../project-manager';
import type { EventMap } from '../typings/event-map';
import * as buffer from '../utils/buffer';
import { fail } from '../utils/error';
import type { EventEmitter } from '../utils/event-emitter';
import { Linker } from '../utils/linker';
import { signal } from '../utils/signal';
import { norm } from '../utils/text';
import { hash, relativePath, tryCatch } from '../utils/utils';

import { BaseStore } from './base-store';
import { merge } from './merge';
import { classify } from './status';
import type { SyncState } from './status';

type LinkParams = {
    folderUri: vscode.Uri;
    projectManager: ProjectManager;
    projectId: number;
    branchId: string;
};

// native git-style sync: observes per-file state (base vs working vs remote)
// without touching the live realtime path. pull/push land in later parts.
class NativeSyncEngine extends Linker<LinkParams> {
    private _events: EventEmitter<EventMap>;

    private _base: BaseStore;

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _projectId?: number;

    private _branchId?: string;

    private _status = new Map<string, SyncState>();

    error = signal<Error | undefined>(undefined);

    changed = signal(0);

    constructor({ events, storageUri }: { events: EventEmitter<EventMap>; storageUri: vscode.Uri }) {
        super();
        this._events = events;
        this._base = new BaseStore({ storageUri });
    }

    status(path: string) {
        return this._status.get(path) ?? 'clean';
    }

    statuses() {
        return new Map(this._status);
    }

    baseText(path: string) {
        const file = this._projectManager?.files.get(path);
        if (!file || file.type !== 'file') {
            return undefined;
        }
        return this._base.get(file.uniqueId)?.text;
    }

    // live remote content (R) for the incoming diff view
    remoteText(path: string) {
        const file = this._projectManager?.files.get(path);
        if (!file || file.type !== 'file') {
            return undefined;
        }
        return norm(file.doc.text);
    }

    private async _read(folderUri: vscode.Uri, path: string) {
        const uri = vscode.Uri.joinPath(folderUri, path);
        // prefer the open buffer so status reflects unsaved edits (live)
        const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (open && !open.isClosed) {
            return norm(open.getText());
        }
        const [err, data] = await tryCatch(async () => vscode.workspace.fs.readFile(uri));
        return err ? undefined : norm(buffer.toString(data));
    }

    private async _write(folderUri: vscode.Uri, path: string, text: string) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folderUri, path), buffer.from(text));
    }

    private async _refresh(path: string) {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }

        const file = pm.files.get(path);
        if (!file || file.type !== 'file') {
            this._status.delete(path);
            return;
        }

        const working = await this._read(folderUri, path);
        if (working === undefined) {
            return; // not on disk yet
        }
        const remote = norm(file.doc.text);

        // seed the base on first sight: treat the current server state as the
        // last-pulled ancestor. provisional until pull/push lands.
        let base = this._base.get(file.uniqueId);
        if (!base) {
            this._base.set(file.uniqueId, remote);
            base = this._base.get(file.uniqueId);
        }
        if (!base) {
            return;
        }

        this._status.set(path, classify(base.hash, hash(working), hash(remote), working));
    }

    private async _refreshAll() {
        const pm = this._projectManager;
        if (!pm) {
            return;
        }
        for (const [path, file] of pm.files) {
            if (file.type === 'file') {
                await this._refresh(path);
            }
        }
        this.changed.set((v) => v + 1);
    }

    // recompute status — a single file (cheap, for live edits) or all
    async refresh(path?: string) {
        if (path === undefined) {
            await this._refreshAll();
            return;
        }
        await this._refresh(path);
        this.changed.set((v) => v + 1);
    }

    // fetch + 3-way merge: bring remote changes into the working tree.
    // refuses while a previous merge is unresolved (git-like).
    async pull() {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }

        // flush open buffers so merges write to disk and reload cleanly
        await vscode.workspace.saveAll(false);
        await this._refreshAll();
        for (const state of this._status.values()) {
            if (state === 'conflicted') {
                throw fail`resolve conflicts before pulling`;
            }
        }

        for (const [path, file] of pm.files) {
            if (file.type !== 'file') {
                continue;
            }
            const working = await this._read(folderUri, path);
            if (working === undefined) {
                continue;
            }
            const remote = norm(file.doc.text);
            const base = this._base.get(file.uniqueId);

            // unseen, or no local divergence -> fast-forward to remote
            if (!base || working === base.text) {
                if (remote !== working) {
                    await this._write(folderUri, path, remote);
                }
                this._base.set(file.uniqueId, remote);
                continue;
            }

            // remote unchanged since base -> nothing to pull
            if (remote === base.text) {
                continue;
            }

            // both diverged -> 3-way merge into the working tree
            const result = merge(base.text, working, remote);
            await this._write(folderUri, path, result.text);
            if (!result.conflicted) {
                this._base.set(file.uniqueId, remote);
            }
        }

        await this._base.flush();
        await this._refreshAll();
    }

    // push: submit local edits as OT ops + flush to S3. fast-forward only —
    // rejected if any file is behind/conflicted (no force push; pull first).
    async push() {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }

        // flush open buffers so the pushed content matches the editor
        await vscode.workspace.saveAll(false);
        await this._refreshAll();
        for (const state of this._status.values()) {
            if (state === 'behind' || state === 'both' || state === 'conflicted') {
                throw fail`remote has changes — pull before pushing`;
            }
        }

        for (const [path, file] of pm.files) {
            if (file.type !== 'file' || this._status.get(path) !== 'modified') {
                continue;
            }
            const working = await this._read(folderUri, path);
            if (working === undefined) {
                continue;
            }
            const base = this._base.get(file.uniqueId);
            // re-check remote is still unchanged, synchronous with write()'s apply
            // so a remote op can't interleave — went behind mid-push, leave for pull
            if (base && norm(file.doc.text) !== base.text) {
                continue;
            }
            // write() diffs against the live doc and marks dirty so save() flushes
            await pm.write(path, buffer.from(working));
            pm.save(path);
            this._base.set(file.uniqueId, working);
        }

        await this._base.flush();
        await this._refreshAll();
    }

    // revert a file's working copy to the base (git restore). destructive.
    async discard(uri: vscode.Uri) {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return;
        }
        const path = relativePath(uri, folderUri);
        const base = this.baseText(path);
        if (base === undefined) {
            return;
        }
        await this._write(folderUri, path, base);
        await this._refreshAll();
    }

    async link({ folderUri, projectManager, projectId, branchId }: LinkParams) {
        if (this._folderUri !== undefined) {
            throw this.error.set(() => fail`already linked`);
        }
        await super.unlink();

        await this._base.load(projectId, branchId);

        this._folderUri = folderUri;
        this._projectManager = projectManager;
        this._projectId = projectId;
        this._branchId = branchId;

        await this._refreshAll();

        const recompute = (path: string) => void this.refresh(path);
        const onUpdate = this._events.on('asset:file:update', recompute);
        const onSave = this._events.on('asset:file:save', recompute);
        this._cleanup.push(async () => {
            this._events.off('asset:file:update', onUpdate);
            this._events.off('asset:file:save', onSave);
        });

        await this._base.flush();

        this._log.info(`linked ${folderUri.toString()} (${this._status.size} files tracked)`);
    }

    async unlink() {
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;
        const projectId = this._projectId;
        const branchId = this._branchId;
        if (!folderUri || !projectManager || projectId === undefined || branchId === undefined) {
            throw this.error.set(() => fail`unlink called before link`);
        }

        await this._base.flush();
        await super.unlink();

        this._folderUri = undefined;
        this._projectManager = undefined;
        this._projectId = undefined;
        this._branchId = undefined;
        this._status.clear();

        this._log.info(`unlinked ${folderUri.toString()}`);
        return { folderUri, projectManager, projectId, branchId };
    }
}

export { NativeSyncEngine };
