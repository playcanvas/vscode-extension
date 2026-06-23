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
type LocalOp =
    | { action: 'added'; path: string; type: 'file' | 'folder' }
    | { action: 'deleted'; path: string; type: 'file' | 'folder' }
    | { action: 'renamed'; from: string; path: string; type: 'file' | 'folder' };
type RemoteOp =
    | { action: 'created'; path: string; type: 'file' | 'folder'; content: Uint8Array; conflicted?: boolean }
    | { action: 'deleted'; path: string; conflicted?: boolean }
    | { action: 'renamed'; from: string; path: string; conflicted?: boolean };

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

    private _local = new Map<string, LocalOp>();

    private _remote = new Map<string, RemoteOp>();

    private _merges = new Map<number, { base: string; local: string; remote: string }>();

    // push-promoted stubs awaiting their flush ack before release
    private _promoted = new Set<string>();

    private _echoes = new Set<string>();

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

    structuralConflict(target: string | vscode.Uri) {
        const path = this._path(target);
        return this._remote.get(path)?.conflicted;
    }

    baseText(path: string) {
        const file = this._projectManager?.files.get(path);
        if (!file || file.type === 'folder') {
            const op = this._local.get(path);
            if (op?.action !== 'renamed') {
                return undefined;
            }
            const from = this._projectManager?.files.get(op.from);
            if (!from || from.type === 'folder') {
                return undefined;
            }
            return this._base.get(from.uniqueId)?.text;
        }
        return this._base.get(file.uniqueId)?.text;
    }

    private _path(target: string | vscode.Uri) {
        if (typeof target === 'string') {
            return target;
        }
        return this._folderUri ? relativePath(target, this._folderUri) : target.path;
    }

    private _setLocal(op: LocalOp) {
        this._local.set(op.path, op);
        this._status.set(op.path, op.action);
        this.changed.set((v) => v + 1);
    }

    private _setRemote(op: RemoteOp, conflicted = false) {
        this._remote.set(op.path, { ...op, conflicted });
        this._status.set(op.path, conflicted ? 'conflicted' : 'behind');
        this.changed.set((v) => v + 1);
    }

    private _touches(a: string, b: string) {
        return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    }

    private _localOpTouches(path: string) {
        for (const op of this._local.values()) {
            if (this._touches(op.path, path) || (op.action === 'renamed' && this._touches(op.from, path))) {
                return true;
            }
        }
        return false;
    }

    private _localTouches(path: string) {
        for (const op of this._local.values()) {
            if (this._touches(op.path, path) || (op.action === 'renamed' && this._touches(op.from, path))) {
                return true;
            }
        }
        for (const [p, state] of this._status) {
            if (this._touches(p, path) && (state === 'modified' || state === 'both' || state === 'conflicted')) {
                return true;
            }
        }
        return false;
    }

    private _dropLocal(...paths: string[]) {
        for (const [path, op] of Array.from(this._local)) {
            const touches = paths.some(
                (p) => this._touches(op.path, p) || (op.action === 'renamed' && this._touches(op.from, p))
            );
            if (!touches) {
                continue;
            }
            this._local.delete(path);
            this._status.delete(path);
            if (op.action === 'renamed') {
                this._status.delete(op.from);
            }
        }
        for (const path of paths) {
            this._status.delete(path);
        }
    }

    private async _exists(path: string) {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return false;
        }
        const [err] = await tryCatch(async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(folderUri, path)));
        return !err;
    }

    private async _type(path: string) {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return undefined;
        }
        const [err, stat] = await tryCatch(async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(folderUri, path)));
        if (err) {
            return undefined;
        }
        return stat.type === vscode.FileType.Directory ? 'folder' : 'file';
    }

    private _localCreate(path: string, type: 'file' | 'folder') {
        this._setLocal({ action: 'added', path, type });
    }

    private _localDelete(path: string, type: 'file' | 'folder') {
        const op = this._local.get(path);
        if (op?.action === 'added') {
            this._local.delete(path);
            this._status.delete(path);
            this.changed.set((v) => v + 1);
            return;
        }
        if (op?.action === 'renamed') {
            this._local.delete(path);
            this._setLocal({ action: 'deleted', path: op.from, type });
            return;
        }
        this._setLocal({ action: 'deleted', path, type });
    }

    private _localRename(from: string, path: string, type: 'file' | 'folder') {
        const op = this._local.get(from);
        if (op?.action === 'added') {
            this._local.delete(from);
            this._status.delete(from);
            this._setLocal({ action: 'added', path, type });
            return;
        }
        if (op?.action === 'renamed') {
            this._local.delete(from);
            this._status.delete(from);
            this._setLocal({ action: 'renamed', from: op.from, path, type });
            return;
        }
        this._setLocal({ action: 'renamed', from, path, type });
    }

    private _echo(key: string) {
        if (!this._echoes.has(key)) {
            return false;
        }
        this._echoes.delete(key);
        return true;
    }

    private async _remoteCreate(path: string, type: 'file' | 'folder', content: Uint8Array) {
        if (this._echo(`create:${type}:${path}`)) {
            return;
        }
        if (this._localTouches(path)) {
            this._setRemote({ action: 'created', path, type, content }, true);
            return;
        }
        const working = type === 'file' ? await this._read(this._folderUri!, path) : undefined;
        const same = type === 'file' && content.length > 0 && working === norm(buffer.toString(content));
        this._setRemote({ action: 'created', path, type, content }, working !== undefined && !same);
    }

    private _remoteDelete(path: string) {
        if (this._echo(`delete:${path}`)) {
            return;
        }
        this._setRemote({ action: 'deleted', path }, this._localTouches(path));
    }

    private async _remoteRename(from: string, path: string) {
        if (this._echo(`rename:${from}:${path}`)) {
            return;
        }
        this._status.delete(from);
        const op = { action: 'renamed' as const, from, path };
        const conflicted = this._localOpTouches(from) || this._localTouches(path);
        this._setRemote(op, conflicted);
        if (!conflicted && (await this._exists(path))) {
            this._setRemote(op, true);
        }
    }

    private async _content(op: RemoteOp & { action: 'created' }) {
        if (op.type !== 'file' || op.content.length > 0) {
            return op.content;
        }
        const text = await this.remoteText(op.path);
        return text === undefined ? op.content : buffer.from(text);
    }

    // remote content for the incoming diff view; stubs are promoted only while read
    async remoteText(path: string) {
        const pm = this._projectManager;
        const file = pm?.files.get(path);
        if (!pm || !file || file.type === 'folder') {
            return undefined;
        }
        if (file.type === 'file') {
            return norm(file.doc.text);
        }
        const [err, promoted] = await tryCatch(async () => pm.subscribe(path));
        if (err || !promoted || promoted.type !== 'file') {
            return undefined;
        }
        const text = norm(promoted.doc.text);
        await this._release(path);
        return text;
    }

    // base/local/remote inputs for a conflicted file's 3-way merge editor
    mergeInputs(path: string) {
        const file = this._projectManager?.files.get(path);
        if (!file || file.type !== 'file') {
            return undefined;
        }
        return this._merges.get(file.uniqueId);
    }

    async acceptIncoming(uri: vscode.Uri) {
        const path = this._path(uri);
        const op = this._remote.get(path);
        if (!op) {
            return;
        }
        this._dropLocal(op.path, op.action === 'renamed' ? op.from : op.path);
        if (op.action === 'created') {
            if (await this._exists(op.path)) {
                await this._applyDelete(op.path);
            }
            await this._applyCreate(op.path, op.type, await this._content(op));
        } else if (op.action === 'deleted') {
            if (await this._exists(op.path)) {
                await this._applyDelete(op.path);
            }
        } else {
            if (await this._exists(op.path)) {
                await this._applyDelete(op.path);
            }
            if (await this._exists(op.from)) {
                await this._applyRename(op.from, op.path);
            }
        }
        this._remote.delete(path);
        await this._refreshAll();
    }

    async keepCurrent(uri: vscode.Uri) {
        const path = this._path(uri);
        const op = this._remote.get(path);
        if (!op) {
            return;
        }
        this._remote.delete(path);
        this._dropLocal(op.path, op.action === 'renamed' ? op.from : op.path);
        if (op.action === 'deleted') {
            const type = await this._type(op.path);
            if (type) {
                this._setLocal({ action: 'added', path: op.path, type });
            }
        } else if (op.action === 'renamed') {
            const type = await this._type(op.from);
            if (type) {
                this._setLocal({ action: 'renamed', from: op.path, path: op.from, type });
            }
        }
        await this._refreshAll();
    }

    async markResolved(uri: vscode.Uri) {
        await this.keepCurrent(uri);
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

    private _applyCreate(path: string, type: 'file' | 'folder', content: Uint8Array) {
        return new Promise<void>((resolve, reject) => {
            const done = (err?: Error) => (err ? reject(err) : resolve());
            if (!this._events.emit('sync:file:apply:create', path, type, content, done)) {
                resolve();
            }
        });
    }

    private _applyDelete(path: string) {
        return new Promise<void>((resolve, reject) => {
            const done = (err?: Error) => (err ? reject(err) : resolve());
            if (!this._events.emit('sync:file:apply:delete', path, done)) {
                resolve();
            }
        });
    }

    private _applyRename(from: string, path: string) {
        return new Promise<void>((resolve, reject) => {
            const done = (err?: Error) => (err ? reject(err) : resolve());
            if (!this._events.emit('sync:file:apply:rename', from, path, done)) {
                resolve();
            }
        });
    }

    private async _refresh(path: string) {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }

        const remoteOp = this._remote.get(path);
        if (remoteOp) {
            this._status.set(path, remoteOp.conflicted ? 'conflicted' : 'behind');
            return;
        }
        const local = this._local.get(path);
        if (local) {
            this._status.set(path, local.action);
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

        if (file.type === 'stub') {
            let base = this._base.get(file.uniqueId);
            if (!base) {
                this._base.set(file.uniqueId, working);
                base = this._base.get(file.uniqueId);
            }
            if (!base) {
                return;
            }
            const state = classify(base.hash, hash(working), base.hash, working);
            this._status.set(path, state);
            if (state !== 'conflicted') {
                this._merges.delete(file.uniqueId);
            }
            return;
        }

        let base = this._base.get(file.uniqueId);
        if (!base) {
            this._base.set(file.uniqueId, norm(file.doc.text));
            base = this._base.get(file.uniqueId);
        }
        if (!base) {
            return;
        }

        const remote = hash(norm(file.doc.text));
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
        this._status.clear();
        for (const op of this._local.values()) {
            this._status.set(op.path, op.action);
        }
        for (const op of this._remote.values()) {
            this._status.set(op.path, op.conflicted ? 'conflicted' : 'behind');
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

        const remoteOps = Array.from(this._remote.values());
        const created = remoteOps
            .filter((op): op is RemoteOp & { action: 'created' } => op.action === 'created')
            .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
        const renamed = remoteOps.filter((op): op is RemoteOp & { action: 'renamed' } => op.action === 'renamed');
        const deleted = remoteOps
            .filter((op): op is RemoteOp & { action: 'deleted' } => op.action === 'deleted')
            .sort((a, b) => b.path.split('/').length - a.path.split('/').length);

        for (const op of renamed) {
            await this._applyRename(op.from, op.path);
            this._remote.delete(op.path);
        }
        for (const op of created) {
            await this._applyCreate(op.path, op.type, await this._content(op));
            this._remote.delete(op.path);
        }
        for (const op of deleted) {
            await this._applyDelete(op.path);
            this._remote.delete(op.path);
        }

        const pulled: string[] = [];
        for (const [path, f] of pm.files) {
            if (f.type === 'folder') {
                continue;
            }
            // pull is an exact remote operation: promote unloaded stubs so R is realtime doc.text
            let file = f;
            if (file.type === 'stub') {
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

        const ops = Array.from(this._local.values());
        const added = ops
            .filter((op): op is LocalOp & { action: 'added' } => op.action === 'added')
            .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
        const renamed = ops.filter((op): op is LocalOp & { action: 'renamed' } => op.action === 'renamed');
        const deleted = ops
            .filter((op): op is LocalOp & { action: 'deleted' } => op.action === 'deleted')
            .sort((a, b) => b.path.split('/').length - a.path.split('/').length);

        for (const op of renamed) {
            const key = `rename:${op.from}:${op.path}`;
            this._echoes.add(key);
            const [err] = await tryCatch(() => pm.rename(op.from, op.path));
            this._echoes.delete(key);
            if (err) {
                throw err;
            }
            this._local.delete(op.path);
        }
        for (const op of added) {
            const content = op.type === 'file' ? buffer.from((await this._read(folderUri, op.path)) ?? '') : undefined;
            const key = `create:${op.type}:${op.path}`;
            this._echoes.add(key);
            const [err] = await tryCatch(() => pm.create(op.path, op.type, content));
            this._echoes.delete(key);
            if (err) {
                throw err;
            }
            this._local.delete(op.path);
        }
        for (const op of deleted) {
            const key = `delete:${op.path}`;
            this._echoes.add(key);
            const [err] = await tryCatch(() => pm.delete(op.path, op.type));
            this._echoes.delete(key);
            if (err) {
                throw err;
            }
            this._local.delete(op.path);
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
                if (fresh) {
                    this._promoted.delete(path);
                    await this._release(path);
                }
                throw fail`remote has changes — pull before pushing`;
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
        const onCreate = this._events.on(
            'asset:file:create',
            (path, type, content) => void this._remoteCreate(path, type, content)
        );
        const onDelete = this._events.on('asset:file:delete', (path) => this._remoteDelete(path));
        const onRename = this._events.on('asset:file:rename', (from, to) => void this._remoteRename(from, to));
        const onLocalCreate = this._events.on('sync:file:create', (path, type) => this._localCreate(path, type));
        const onLocalUpdate = this._events.on('sync:file:update', recompute);
        const onLocalDelete = this._events.on('sync:file:delete', (path, type) => this._localDelete(path, type));
        const onLocalRename = this._events.on('sync:file:rename', (from, to, type) =>
            this._localRename(from, to, type)
        );
        // restatus on promote: remote upgrades from stub base to live doc
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
            this._events.off('asset:file:create', onCreate);
            this._events.off('asset:file:delete', onDelete);
            this._events.off('asset:file:rename', onRename);
            this._events.off('sync:file:create', onLocalCreate);
            this._events.off('sync:file:update', onLocalUpdate);
            this._events.off('sync:file:delete', onLocalDelete);
            this._events.off('sync:file:rename', onLocalRename);
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
        this._local.clear();
        this._remote.clear();
        this._merges.clear();
        this._promoted.clear();
        this._echoes.clear();

        this._log.info(`unlinked ${folderUri.toString()}`);
        return { folderUri, projectManager, projectId, branchId };
    }
}

export { NativeSyncEngine };
