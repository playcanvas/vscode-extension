import * as vscode from 'vscode';

import type { Rest, SyncItem, SyncPullResponse, SyncPushOp } from '../connections/rest';
import { Disk } from '../disk';
import type { ProjectManager } from '../project-manager';
import type { EventMap } from '../typings/event-map';
import * as buffer from '../utils/buffer';
import { Debouncer } from '../utils/debouncer';
import { fail } from '../utils/error';
import type { EventEmitter } from '../utils/event-emitter';
import { Linker } from '../utils/linker';
import { Mutex } from '../utils/mutex';
import { signal } from '../utils/signal';
import { norm } from '../utils/text';
import { hash, relativePath, tryCatch, withTimeout } from '../utils/utils';

import { BaseStore } from './base-store';
import { hasConflictMarkers } from './markers';
import { merge } from './merge';
import { classify } from './status';
import type { SyncState } from './status';

const SAVE_TIMEOUT_MS = 30_000;
const REMOTE_REFRESH_DELAY = 500;

type LinkParams = {
    folderUri: vscode.Uri;
    projectManager: ProjectManager;
    projectId: number;
    branchId: string;
    rest?: Rest;
};
type LocalOp =
    | { action: 'added'; path: string; type: 'file' | 'folder'; hash?: string }
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

    private _rest?: Rest;

    private _remoteSnapshot?: SyncPullResponse;

    private _refreshRemoteDebouncer = new Debouncer<void>(REMOTE_REFRESH_DELAY);

    private _status = new Map<string, SyncState>();

    private _local = new Map<string, LocalOp>();

    private _remote = new Map<string, RemoteOp>();

    // push-promoted stubs awaiting their flush ack before release
    private _promoted = new Set<string>();

    private _echoes = new Set<string>();

    // serializes push/pull so concurrent runs never race on seq/base
    private _mutex = new Mutex<[Error, null] | [null, void]>();

    private _ignoring = (_uri: vscode.Uri) => false;

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

    decorationStatus(path: string) {
        const op = this._remote.get(path);
        if (!op || op.conflicted) {
            return this.status(path);
        }
        if (op.action === 'created') {
            return 'added';
        }
        if (op.action === 'deleted') {
            return 'deleted';
        }
        return 'renamed';
    }

    statuses() {
        return new Map(this._status);
    }

    structuralConflict(target: string | vscode.Uri) {
        const path = this._path(target);
        return this._remote.get(path)?.conflicted;
    }

    baseText(path: string) {
        if (this._restMode()) {
            return this._base.byPath(path)?.text;
        }
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

    private _restMode() {
        return !!this._rest && this._projectId !== undefined && this._branchId !== undefined;
    }

    private _remoteItem(path: string) {
        return this._remoteSnapshot?.items.find((item) => item.path === path);
    }

    private _remoteItemById(id: number) {
        return this._remoteSnapshot?.items.find((item) => item.id === id);
    }

    private _remoteText(item: SyncItem) {
        return norm(item.type === 'file' ? (item.text ?? '') : '');
    }

    private _allRestPaths() {
        const paths = new Set<string>();
        for (const item of this._remoteSnapshot?.items ?? []) {
            paths.add(item.path);
        }
        for (const item of this._base.items()) {
            if (item.path) {
                paths.add(item.path);
                const remote = item.id === undefined ? undefined : this._remoteItemById(item.id);
                if (remote) {
                    paths.add(remote.path);
                }
            }
        }
        for (const op of this._local.values()) {
            paths.add(op.path);
            if (op.action === 'renamed') {
                paths.add(op.from);
            }
        }
        return paths;
    }

    private async _fetchRemote() {
        const rest = this._rest;
        const projectId = this._projectId;
        const branchId = this._branchId;
        if (!rest || projectId === undefined || branchId === undefined) {
            return;
        }
        this._remoteSnapshot = await rest.syncPull(projectId, branchId);
    }

    private async _queueRemoteRefresh() {
        if (!this._restMode()) {
            return;
        }
        // serialize with pull/push so a concurrent fetch+refresh can't swap
        // _remoteSnapshot mid-pull and advance the base past disk
        await tryCatch(
            this._refreshRemoteDebouncer.debounce('remote', async () => {
                const [err] =
                    (await this._mutex.atomic(['sync'], () =>
                        tryCatch(async () => {
                            await this._fetchRemote();
                            await this._refreshAll();
                        })
                    )) ?? [];
                if (err) {
                    this.error.set(() => err);
                }
            })
        );
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

    private _remoteChanged(path: string) {
        const pm = this._projectManager;
        if (!pm) {
            return false;
        }
        for (const [p, file] of pm.files) {
            if (!this._touches(p, path) || file.type !== 'file') {
                continue;
            }
            const base = this._base.get(file.uniqueId);
            if (base && norm(file.doc.text) !== base.text) {
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
        const local = this._local.get(path);
        if (local?.action === 'added' && local.type === type) {
            const same = type === 'folder' || local.hash === hash(norm(buffer.toString(content)));
            if (same) {
                this._local.delete(path);
                this._status.delete(path);
                this._setRemote({ action: 'created', path, type, content });
                return;
            }
            this._setRemote({ action: 'created', path, type, content }, true);
            return;
        }
        if (this._localTouches(path)) {
            this._setRemote({ action: 'created', path, type, content }, true);
            return;
        }
        const working = type === 'file' ? await this._readDisk(this._folderUri!, path) : undefined;
        const same = type === 'file' && working === norm(buffer.toString(content));
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
        if (this._restMode()) {
            const item = this._remoteItem(path);
            return item?.type === 'file' ? this._remoteText(item) : undefined;
        }
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
        if (this._restMode()) {
            const item = this._base.byPath(path);
            return item?.id === undefined ? undefined : this._base.conflict(item.id);
        }
        const file = this._projectManager?.files.get(path);
        if (!file || file.type === 'folder') {
            return undefined;
        }
        return this._base.conflict(file.uniqueId);
    }

    async acceptIncoming(uri: vscode.Uri) {
        const [err] = (await this._mutex.atomic(['sync'], () => tryCatch(() => this._acceptIncoming(uri)))) ?? [];
        if (err) {
            throw err;
        }
    }

    private async _acceptIncoming(uri: vscode.Uri) {
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
        const [err] = (await this._mutex.atomic(['sync'], () => tryCatch(() => this._keepCurrent(uri)))) ?? [];
        if (err) {
            throw err;
        }
    }

    private async _keepCurrent(uri: vscode.Uri) {
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

    private async _readDisk(folderUri: vscode.Uri, path: string) {
        const [err, data] = await tryCatch(async () =>
            vscode.workspace.fs.readFile(vscode.Uri.joinPath(folderUri, path))
        );
        return err ? undefined : norm(buffer.toString(data));
    }

    private async _ignoreText(folderUri: vscode.Uri) {
        const file = this._projectManager?.files.get(Disk.IGNORE_FILE);
        if (file?.type === 'file') {
            return file.doc.text;
        }
        if (file?.type === 'stub') {
            return (await this._readDisk(folderUri, Disk.IGNORE_FILE)) ?? '';
        }
        return '';
    }

    private async _refreshLocalOnly(folderUri: vscode.Uri, base = '') {
        const pm = this._projectManager;
        if (!pm) {
            return;
        }
        const dir = base ? vscode.Uri.joinPath(folderUri, base) : folderUri;
        const [, entries] = await tryCatch(async () => vscode.workspace.fs.readDirectory(dir));
        for (const [name, type] of entries ?? []) {
            const path = base ? `${base}/${name}` : name;
            const uri = vscode.Uri.joinPath(folderUri, path);
            if (this._ignoring(uri) || path === Disk.TYPE_DIR || path.startsWith(`${Disk.TYPE_DIR}/`)) {
                continue;
            }
            const kind = type === vscode.FileType.Directory ? 'folder' : type === vscode.FileType.File ? 'file' : '';
            if (!kind) {
                continue;
            }
            const text = kind === 'file' ? await this._readDisk(folderUri, path) : undefined;
            const tracked = this._restMode() ? this._base.byPath(path) || this._remoteItem(path) : pm.files.has(path);
            if (!tracked && !this._remote.has(path) && !this._local.has(path)) {
                this._setLocal({
                    action: 'added',
                    path,
                    type: kind,
                    hash: text === undefined ? undefined : hash(text)
                });
            }
            if (kind === 'folder') {
                await this._refreshLocalOnly(folderUri, path);
            }
        }
    }

    private _applyCreate(path: string, type: 'file' | 'folder', content: Uint8Array) {
        return new Promise<void>((resolve, reject) => {
            const done = (err?: Error) => (err ? reject(err) : resolve());
            if (!this._events.emit('sync:file:apply:create', path, type, content, done)) {
                resolve();
            }
        });
    }

    private _applyUpdate(path: string, text: string) {
        return new Promise<void>((resolve, reject) => {
            const done = (err?: Error) => (err ? reject(err) : resolve());
            if (!this._events.emit('sync:file:apply:update', path, buffer.from(text), done)) {
                reject(fail`disk apply update handler missing`);
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

    private async _save(path: string) {
        const pm = this._projectManager;
        if (!pm) {
            return;
        }
        let listener: ((p: string) => void) | undefined;
        const saved = new Promise<void>((resolve) => {
            listener = this._events.on('asset:file:save', (p) => {
                if (p !== path || !listener) {
                    return;
                }
                this._events.off('asset:file:save', listener);
                listener = undefined;
                resolve();
            });
        });
        const [err] = await tryCatch(async () => {
            pm.save(path);
            await withTimeout(saved, SAVE_TIMEOUT_MS, `save timed out for ${path}`);
        });
        if (listener) {
            this._events.off('asset:file:save', listener);
        }
        if (err) {
            throw err;
        }
    }

    private async _pushContent(path: string) {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        const f = pm?.files.get(path);
        if (!folderUri || !pm || !f || f.type === 'folder') {
            return;
        }
        const working = await this._readDisk(folderUri, path);
        if (working === undefined) {
            return;
        }
        // closed-file local edits live on stubs — subscribe to submit.
        // released on the flush ack (asset:file:save), not here: the doc
        // has pending ops until then and an early close races the save
        let file = f;
        let fresh = false;
        if (file.type === 'stub') {
            const promoted = await pm.subscribe(path);
            if (!promoted) {
                return;
            }
            file = promoted;
            this._promoted.add(path);
            fresh = true;
        }
        if (file.type !== 'file') {
            return;
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
        if (norm(file.doc.text) === working) {
            this._base.set(file.uniqueId, working);
            return;
        }
        // write() diffs against the live doc and marks dirty so save() flushes
        await pm.write(path, buffer.from(working));
        await this._save(path);
        this._base.set(file.uniqueId, working);
    }

    private async _refreshRest(path: string) {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return;
        }

        const local = this._local.get(path);
        const base = this._base.byPath(path);
        const remote = this._remoteItem(path);
        const moved = base?.id === undefined ? undefined : this._remoteItemById(base.id);
        const remoteBase = remote ? this._base.get(remote.id) : undefined;

        if (remoteBase?.path && remoteBase.path !== remote?.path) {
            return;
        }

        if (moved && base?.path && moved.path !== base.path) {
            this._status.delete(base.path);
            const from = await this._readDisk(folderUri, base.path);
            const to = await this._readDisk(folderUri, moved.path);
            const conflicted =
                this._localOpTouches(base.path) ||
                this._localTouches(moved.path) ||
                from !== base.text ||
                to !== undefined;
            this._setRemote({ action: 'renamed', from: base.path, path: moved.path }, conflicted);
            return;
        }

        if (local) {
            if (local.action === 'deleted' && remote && base && this._remoteText(remote) !== base.text) {
                // server edited a file you deleted: the edit wins as an incoming restore —
                // pull brings it back (visible); re-delete + push if you still want it gone
                const content = remote.type === 'file' ? buffer.from(this._remoteText(remote)) : new Uint8Array();
                this._setRemote({ action: 'created', path, type: remote.type, content });
                return;
            }
            this._status.set(path, local.action);
            return;
        }

        const working = await this._readDisk(folderUri, path);
        if (!base && !remote) {
            this._status.delete(path);
            return;
        }

        if (remote && !base) {
            if (remote.type === 'folder') {
                if (await this._exists(path)) {
                    this._base.setItem(remote);
                    this._status.delete(path);
                } else {
                    this._setRemote({ action: 'created', path, type: 'folder', content: new Uint8Array() });
                }
                return;
            }
            const text = this._remoteText(remote);
            if (working === undefined) {
                this._setRemote({ action: 'created', path, type: 'file', content: buffer.from(text) });
                return;
            }
            this._base.setItem(remote);
            this._status.set(path, working === text ? 'clean' : 'modified');
            return;
        }

        if (base && !remote) {
            if (working !== undefined && working !== base.text) {
                this._status.set(path, 'conflicted');
            } else {
                this._setRemote({ action: 'deleted', path });
            }
            return;
        }

        if (!base || !remote || remote.type === 'folder') {
            this._status.delete(path);
            return;
        }

        if (working === undefined) {
            if (this._remoteText(remote) !== base.text) {
                // server edited a file that's gone locally — restore it on pull, not a blind conflict
                this._setRemote({
                    action: 'created',
                    path,
                    type: 'file',
                    content: buffer.from(this._remoteText(remote))
                });
                return;
            }
            this._setLocal({ action: 'deleted', path, type: 'file' });
            return;
        }

        const conflict = base.id === undefined ? undefined : this._base.conflict(base.id);
        if (conflict) {
            if (hasConflictMarkers(working)) {
                this._status.set(path, 'conflicted');
                return;
            }
            if (base.id !== undefined) {
                this._base.deleteConflict(base.id);
            }
        }

        const remoteText = this._remoteText(remote);
        const state = classify(base.hash, hash(working), hash(remoteText), working);
        this._status.set(path, state);
    }

    private async _refresh(path: string) {
        if (this._restMode()) {
            await this._refreshRest(path);
            return;
        }

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
            if (local.action === 'deleted' && this._remoteChanged(path)) {
                this._status.set(path, 'conflicted');
                return;
            }
            this._status.set(path, local.action);
            return;
        }
        const file = pm.files.get(path);
        if (!file || file.type === 'folder') {
            this._status.delete(path);
            return;
        }

        const working = await this._readDisk(folderUri, path);
        if (working === undefined) {
            if (this._localOpTouches(path)) {
                return;
            }
            if (this._base.get(file.uniqueId)) {
                this._setLocal({ action: 'deleted', path, type: 'file' });
            } else {
                this._setRemote({ action: 'created', path, type: 'file', content: new Uint8Array() });
            }
            return;
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
            const conflict = this._base.conflict(file.uniqueId);
            if (conflict) {
                if (hasConflictMarkers(working)) {
                    this._status.set(path, 'conflicted');
                    return;
                }
                this._base.deleteConflict(file.uniqueId);
            }
            const state = classify(base.hash, hash(working), base.hash, working);
            this._status.set(path, state);
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

        const conflict = this._base.conflict(file.uniqueId);
        if (conflict) {
            if (hasConflictMarkers(working)) {
                this._status.set(path, 'conflicted');
                return;
            }
            this._base.deleteConflict(file.uniqueId);
        }
        const remote = hash(norm(file.doc.text));
        const state = classify(base.hash, hash(working), remote, working);
        this._status.set(path, state);
    }

    private async _refreshAll() {
        const pm = this._projectManager;
        const folderUri = this._folderUri;
        if (!pm || !folderUri) {
            return;
        }
        if (this._restMode()) {
            this._status.clear();
            this._remote.clear();
            for (const path of this._allRestPaths()) {
                await this._refreshRest(path);
            }
            await this._refreshLocalOnly(folderUri);
            this.changed.set((v) => v + 1);
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
        await this._refreshLocalOnly(folderUri);
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
    private async _pullRest() {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return;
        }

        await this._fetchRemote();
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
            // a restore over a path you deleted locally supersedes that delete
            this._local.delete(op.path);
        }
        for (const op of deleted) {
            await this._applyDelete(op.path);
            this._remote.delete(op.path);
        }

        const conflicts: [number, { base: string; local: string; remote: string }][] = [];
        for (const item of this._remoteSnapshot?.items ?? []) {
            if (item.type !== 'file') {
                continue;
            }
            const remote = this._remoteText(item);
            const working = await this._readDisk(folderUri, item.path);
            const base = this._base.byPath(item.path);
            if (working === undefined) {
                continue;
            }
            if (!base || working === base.text) {
                if (remote !== working) {
                    await this._applyUpdate(item.path, remote);
                }
                continue;
            }
            if (remote === base.text) {
                continue;
            }

            const result = merge(base.text, working, remote);
            if (result.conflicted) {
                conflicts.push([item.id, { base: base.text, local: working, remote }]);
            }
            await this._applyUpdate(item.path, result.text);
        }

        if (this._remoteSnapshot) {
            this._base.setSnapshot(this._remoteSnapshot);
            for (const [id, conflict] of conflicts) {
                this._base.setConflict(id, conflict);
            }
        }
        await this._base.flush();
        await this._refreshAll();
    }

    async pull() {
        const [err] =
            (await this._mutex.atomic(['sync'], () =>
                tryCatch(() => (this._restMode() ? this._pullRest() : this._pullLive()))
            )) ?? [];
        if (err) {
            throw err;
        }
    }

    private async _pullLive() {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }

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
            const working = await this._readDisk(folderUri, path);
            if (working === undefined) {
                continue;
            }
            const remote = norm(file.doc.text);
            const base = this._base.get(file.uniqueId);

            // unseen, or no local divergence -> fast-forward to remote
            if (!base || working === base.text) {
                if (remote !== working) {
                    await this._applyUpdate(path, remote);
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
                this._base.setConflict(file.uniqueId, { base: base.text, local: working, remote });
            }
            await this._applyUpdate(path, result.text);
            this._base.set(file.uniqueId, remote);
        }

        // pull never leaves ops pending — release promoted docs right away
        for (const path of pulled) {
            await this._release(path);
        }

        await this._base.flush();
        await this._refreshAll();
    }

    private async _sendRestOp(op: SyncPushOp) {
        const rest = this._rest;
        const projectId = this._projectId;
        const branchId = this._branchId;
        if (!rest || projectId === undefined || branchId === undefined) {
            return;
        }
        const seq = this._base.seq + 1;
        const snapshot = await rest.syncPush(projectId, branchId, {
            clientId: this._base.clientId,
            seq,
            base: this._base.base,
            ops: [op]
        });
        this._base.setSeq(seq);
        this._base.setSnapshot(snapshot);
        this._remoteSnapshot = snapshot;
        // persist seq+base per op so a crash mid-batch resumes instead of
        // deadlocking on a stale seq the server already consumed
        await this._base.flush();
    }

    private async _pushRest() {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return;
        }

        await this._fetchRemote();
        if (!this._base.base && this._remoteSnapshot) {
            this._base.setBase(this._remoteSnapshot.base);
        }
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
            const item = this._base.byPath(op.from);
            if (item?.id === undefined) {
                throw fail`missing base item for ${op.from}`;
            }
            await this._sendRestOp({ type: 'rename', id: item.id, path: op.path });
            this._local.delete(op.path);
            await this._refreshAll();
        }
        for (const op of added) {
            if (op.type === 'folder') {
                await this._sendRestOp({ type: 'create_folder', path: op.path });
            } else {
                await this._sendRestOp({
                    type: 'create_file',
                    path: op.path,
                    text: (await this._readDisk(folderUri, op.path)) ?? ''
                });
            }
            this._local.delete(op.path);
            await this._refreshAll();
        }
        for (const op of deleted) {
            const item = this._base.byPath(op.path);
            if (item?.id === undefined) {
                throw fail`missing base item for ${op.path}`;
            }
            await this._sendRestOp({ type: 'delete', id: item.id });
            this._local.delete(op.path);
            await this._refreshAll();
        }

        for (const [path, state] of Array.from(this._status)) {
            if (state !== 'modified') {
                continue;
            }
            const item = this._base.byPath(path);
            const text = await this._readDisk(folderUri, path);
            if (item?.id === undefined || item.type !== 'file' || text === undefined) {
                continue;
            }
            await this._sendRestOp({ type: 'update_text', id: item.id, text });
            await this._refreshAll();
        }

        await this._base.flush();
        await this._refreshAll();
    }

    // push: submit local edits as OT ops + flush to S3. fast-forward only —
    // rejected if any file is behind/conflicted (no force push; pull first).
    async push() {
        const [err] =
            (await this._mutex.atomic(['sync'], () =>
                tryCatch(() => (this._restMode() ? this._pushRest() : this._pushLive()))
            )) ?? [];
        if (err) {
            throw err;
        }
    }

    private async _pushLive() {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }

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
            if (this._remoteChanged(op.from)) {
                throw fail`remote has changes — pull before pushing`;
            }
            const key = `rename:${op.from}:${op.path}`;
            this._echoes.add(key);
            const [err] = await tryCatch(() => pm.rename(op.from, op.path));
            this._echoes.delete(key);
            if (err) {
                throw err;
            }
            this._local.delete(op.path);
            this._status.delete(op.path);
            if (op.type === 'file') {
                await this.refresh(op.path);
                await this._pushContent(op.path);
            }
        }
        for (const op of added) {
            const content =
                op.type === 'file' ? buffer.from((await this._readDisk(folderUri, op.path)) ?? '') : undefined;
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
            if (this._remoteChanged(op.path)) {
                throw fail`remote has changes — pull before pushing`;
            }
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
            await this._pushContent(path);
        }

        await this._base.flush();
        await this._refreshAll();
    }

    // revert a file's working copy to the base (git restore). destructive.
    async discard(uri: vscode.Uri) {
        const [err] = (await this._mutex.atomic(['sync'], () => tryCatch(() => this._discard(uri)))) ?? [];
        if (err) {
            throw err;
        }
    }

    private async _discard(uri: vscode.Uri) {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return;
        }
        const path = relativePath(uri, folderUri);
        const op = this._local.get(path);
        const base = this.baseText(path);

        if (op?.action === 'added') {
            await this._applyDelete(path);
            this._local.delete(path);
            this._status.delete(path);
            await this._refreshAll();
            return;
        }

        if (op?.action === 'deleted') {
            if (op.type === 'folder') {
                await this._applyCreate(path, 'folder', new Uint8Array());
            } else if (base !== undefined) {
                await this._applyCreate(path, 'file', buffer.from(base));
            }
            this._local.delete(path);
            this._status.delete(path);
            await this._refreshAll();
            return;
        }

        if (op?.action === 'renamed') {
            await this._applyRename(op.path, op.from);
            this._local.delete(path);
            this._status.delete(path);
            this._status.delete(op.from);
            if (op.type === 'file' && base !== undefined) {
                await this._applyUpdate(op.from, base);
            }
            await this._refreshAll();
            return;
        }

        if (base === undefined) {
            return;
        }
        await this._applyUpdate(path, base);
        await this._refreshAll();
    }

    async link({ folderUri, projectManager, projectId, branchId, rest }: LinkParams) {
        if (this._folderUri !== undefined) {
            throw this.error.set(() => fail`already linked`);
        }
        await super.unlink();

        await this._base.load(projectId, branchId, hash(folderUri.toString()));

        this._folderUri = folderUri;
        this._projectManager = projectManager;
        this._projectId = projectId;
        this._branchId = branchId;
        this._rest = rest;
        this._ignoring = Disk.ignoreMatcher(await this._ignoreText(folderUri), folderUri);
        if (rest) {
            await this._fetchRemote();
            if (!this._base.base && this._remoteSnapshot) {
                this._base.setBase(this._remoteSnapshot.base);
            }
        }

        await this._refreshAll();

        const recompute = (path: string) => void this.refresh(path);
        const refreshRemote = () => void this._queueRemoteRefresh();
        const onUpdate = this._events.on('asset:file:update', rest ? refreshRemote : recompute);
        const onCreate = this._events.on(
            'asset:file:create',
            rest ? refreshRemote : (path, type, content) => void this._remoteCreate(path, type, content)
        );
        const onDelete = this._events.on(
            'asset:file:delete',
            rest ? refreshRemote : (path) => this._remoteDelete(path)
        );
        const onRename = this._events.on(
            'asset:file:rename',
            rest ? refreshRemote : (from, to) => void this._remoteRename(from, to)
        );
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
        const rest = this._rest;
        if (!folderUri || !projectManager || projectId === undefined || branchId === undefined) {
            throw this.error.set(() => fail`unlink called before link`);
        }

        await this._base.flush();
        await super.unlink();

        this._folderUri = undefined;
        this._projectManager = undefined;
        this._projectId = undefined;
        this._branchId = undefined;
        this._rest = undefined;
        this._remoteSnapshot = undefined;
        this._status.clear();
        this._local.clear();
        this._remote.clear();
        this._promoted.clear();
        this._echoes.clear();
        this._ignoring = (_uri: vscode.Uri) => false;
        this._refreshRemoteDebouncer.clear();

        this._log.info(`unlinked ${folderUri.toString()}`);
        return { folderUri, projectManager, projectId, branchId, rest };
    }
}

export { NativeSyncEngine };
