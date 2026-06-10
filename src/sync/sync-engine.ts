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

    private _merges = new Map<number, { base: string; local: string; remote: string }>();

    // push-promoted stubs awaiting their flush ack before release
    private _promoted = new Set<string>();

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
        if (!file || file.type === 'folder') {
            return undefined;
        }
        return this._base.get(file.uniqueId)?.text;
    }

    // remote content (R) for the incoming diff view: live doc when subscribed;
    // stubs read S3 via REST so a diff click never creates a subscription
    async remoteText(path: string) {
        const pm = this._projectManager;
        const file = pm?.files.get(path);
        if (!pm || !file || file.type === 'folder') {
            return undefined;
        }
        if (file.type === 'file') {
            return norm(file.doc.text);
        }
        const [err, buf] = await tryCatch(async () => pm.fetchContent(file.uniqueId));
        return err ? undefined : norm(buffer.toString(buf));
    }

    // base/local/remote inputs for a conflicted file's 3-way merge editor
    mergeInputs(path: string) {
        const file = this._projectManager?.files.get(path);
        if (!file || file.type !== 'file') {
            return undefined;
        }
        return this._merges.get(file.uniqueId);
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
        if (!file || file.type === 'folder') {
            this._status.delete(path);
            return;
        }

        const working = await this._read(folderUri, path);
        if (working === undefined) {
            return; // not on disk yet
        }

        // stubs have no live doc — the replicated S3 hash stands in for R, so
        // closed files classify without subscribing (projects have >1000s)
        const remote = file.type === 'file' ? hash(norm(file.doc.text)) : pm.fileHash(path);
        if (remote === undefined) {
            return;
        }

        // seed the base on first sight (provisional until pull/push lands):
        // live doc text when subscribed; for stubs use disk when it matches
        // the S3 hash, else fetch S3 so the base can anchor a future merge
        let base = this._base.get(file.uniqueId);
        if (!base) {
            if (file.type === 'file') {
                this._base.set(file.uniqueId, norm(file.doc.text));
            } else if (hash(working) === remote) {
                this._base.set(file.uniqueId, working);
            } else {
                const [err, buf] = await tryCatch(async () => pm.fetchContent(file.uniqueId));
                if (err) {
                    return;
                }
                this._base.set(file.uniqueId, norm(buffer.toString(buf)));
            }
            base = this._base.get(file.uniqueId);
        }
        if (!base) {
            return;
        }

        const state = classify(base.hash, hash(working), remote, working);
        this._status.set(path, state);
        // merge resolved (markers gone) -> drop the stashed merge inputs
        if (state !== 'conflicted') {
            this._merges.delete(file.uniqueId);
        }
    }

    private async _refreshAll() {
        const pm = this._projectManager;
        if (!pm) {
            return;
        }
        for (const [path, file] of pm.files) {
            if (file.type !== 'folder') {
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

    // release an engine-initiated subscription so standing docs stay limited
    // to open editors. skipped if the user opened the file meanwhile
    private async _release(path: string) {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }
        const uri = vscode.Uri.joinPath(folderUri, path);
        const open = vscode.workspace.textDocuments.some((d) => !d.isClosed && d.uri.toString() === uri.toString());
        if (open) {
            return;
        }
        await tryCatch(async () => pm.unsubscribe(path));
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

        const pulled: string[] = [];
        for (const [path, f] of pm.files) {
            if (f.type === 'folder') {
                continue;
            }
            // stubs subscribe on demand — only when there is something to pull
            let file = f;
            if (file.type === 'stub') {
                const state = this._status.get(path);
                if (state !== 'behind' && state !== 'both') {
                    continue;
                }
                const promoted = await pm.subscribe(path);
                if (!promoted) {
                    continue;
                }
                file = promoted;
                pulled.push(path);
            }
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

            // both diverged -> 3-way merge into the working tree. advance base to
            // remote even on conflict: the merge incorporated remote, so the working
            // tree (markers until resolved) is now our local-ahead work. markers keep
            // status 'conflicted' (push-blocked); once resolved it becomes 'modified'
            // and is pushable — otherwise the file is stuck both behind and ahead.
            const result = merge(base.text, working, remote);
            if (result.conflicted) {
                // stash the three sides for the merge editor (base advances below)
                this._merges.set(file.uniqueId, { base: base.text, local: working, remote });
            }
            await this._write(folderUri, path, result.text);
            this._base.set(file.uniqueId, remote);
        }

        // pull never leaves ops pending — release promoted docs right away
        for (const path of pulled) {
            await this._release(path);
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

        for (const [path, f] of pm.files) {
            if (f.type === 'folder' || this._status.get(path) !== 'modified') {
                continue;
            }
            const working = await this._read(folderUri, path);
            if (working === undefined) {
                continue;
            }
            // closed-file local edits live on stubs — subscribe to submit.
            // released on the flush ack (asset:file:save), not here: the doc
            // has pending ops until then and an early close races the save
            let file = f;
            let fresh = false;
            if (file.type === 'stub') {
                const promoted = await pm.subscribe(path);
                if (!promoted) {
                    continue;
                }
                file = promoted;
                this._promoted.add(path);
                fresh = true;
            }
            if (file.type !== 'file') {
                continue;
            }
            const base = this._base.get(file.uniqueId);
            // re-check remote is still unchanged, synchronous with write()'s apply
            // so a remote op can't interleave — went behind mid-push, leave for pull
            if (base && norm(file.doc.text) !== base.text) {
                // nothing saved, so no ack will release a doc promoted just now
                if (fresh) {
                    this._promoted.delete(path);
                    void this._release(path);
                }
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
        // restatus on promote: R upgrades from the S3 hash to the live doc
        const onSubscribed = this._events.on('asset:file:subscribed', recompute);
        const onSave = this._events.on('asset:file:save', (path: string) => {
            void this.refresh(path);
            // flush landed — release a push-promoted doc
            if (this._promoted.delete(path)) {
                void this._release(path);
            }
        });
        this._cleanup.push(async () => {
            this._events.off('asset:file:update', onUpdate);
            this._events.off('asset:file:subscribed', onSubscribed);
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
        this._merges.clear();
        this._promoted.clear();

        this._log.info(`unlinked ${folderUri.toString()}`);
        return { folderUri, projectManager, projectId, branchId };
    }
}

export { NativeSyncEngine };
