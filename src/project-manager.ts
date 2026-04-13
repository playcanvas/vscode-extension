import type { Doc } from 'sharedb';

import { CollisionManager } from './collision-manager';
import { EVENT_TIMEOUT_MS } from './connections/constants';
import type { Messenger } from './connections/messenger';
import type { Relay } from './connections/relay';
import type { Rest } from './connections/rest';
import { ShareDb } from './connections/sharedb';
import { progressNotification } from './notification';
import type { EventMap } from './typings/event-map';
import type { Asset } from './typings/models';
import type { ShareDbOp, ShareDbTextOp } from './typings/sharedb';
import { Bimap } from './utils/bimap';
import * as buffer from './utils/buffer';
import { Deferred } from './utils/deferred';
import { fail } from './utils/error';
import type { EventEmitter } from './utils/event-emitter';
import { Linker } from './utils/linker';
import { OTDocument } from './utils/ot-document';
import { effect, signal } from './utils/signal';
import { delta, norm } from './utils/text';
import { hash, parsePath, guard, withTimeout, tryCatch, sanitizeName } from './utils/utils';

const BATCH_SIZE = 256;
const FILE_TYPES = ['css', 'folder', 'html', 'json', 'script', 'shader', 'text'];
const EXT_TO_ASSET = new Map<string, { assetType: string; blobType: string }>([
    ['css', { assetType: 'css', blobType: 'text/css' }],
    ['html', { assetType: 'html', blobType: 'text/html' }],
    ['json', { assetType: 'json', blobType: 'application/json' }],
    ['js', { assetType: 'script', blobType: 'text/plain' }],
    ['mjs', { assetType: 'script', blobType: 'text/plain' }],
    ['txt', { assetType: 'text', blobType: 'text/plain' }],
    ['glsl', { assetType: 'shader', blobType: 'text/x-glsl' }]
]);

type VirtualFile = {
    uniqueId: number;
} & (
    | {
          type: 'folder';
      }
    | {
          type: 'file';
          doc: OTDocument;
          dirty: boolean; // true if hash(doc.data) != asset.file.hash
      }
    | {
          type: 'stub';
          dirty: boolean; // true dirty state discovered on subscribe
      }
);

class ProjectManager extends Linker<{ projectId: number; branchId: string }> {
    private static readonly SAVE_MAX_RETRIES = 5;

    private static readonly SAVE_RETRY_DELAY_MS = 2 * 1000;

    private static readonly FLUSH_TIMEOUT_MS = 5 * 1000;

    private _saveRetries = new Map<number, { timeout?: NodeJS.Timeout; attempt: number }>();

    private _events: EventEmitter<EventMap>;

    private _sharedb: ShareDb;

    private _messenger: Messenger;

    private _relay: Relay;

    private _rest: Rest;

    private _projectId?: number;

    private _branchId?: string;

    private _assets: Map<number, Asset> = new Map<number, Asset>();

    private _files: Map<string, VirtualFile> = new Map<string, VirtualFile>();

    private _idUniqueId: Bimap<number, number> = new Bimap<number, number>();

    private _subscribing = new Map<string, Promise<(VirtualFile & { type: 'file' }) | undefined>>();

    private _queued = new Set<string>();

    collisions: CollisionManager;

    error = signal<Error | undefined>(undefined);

    constructor({
        events,
        sharedb,
        messenger,
        relay,
        rest
    }: {
        events: EventEmitter<EventMap>;
        sharedb: ShareDb;
        messenger: Messenger;
        relay: Relay;
        rest: Rest;
    }) {
        super();

        this._events = events;
        this._sharedb = sharedb;
        this._messenger = messenger;
        this._relay = relay;
        this._rest = rest;

        this.collisions = new CollisionManager({
            files: this._files,
            assetPath: this._assetPath.bind(this),
            assetId: (uniqueId) => this._idUniqueId.getR(uniqueId),
            log: this._log
        });
    }

    get files() {
        return this._files;
    }

    private _assetPath(uniqueId: number, override: { path?: number[]; name?: string } = {}) {
        const asset = this._assets.get(uniqueId);
        if (!asset) {
            throw this.error.set(() => fail`missing child asset ${uniqueId}`);
        }

        const path = override.path ?? asset.path;
        const name = sanitizeName(override.name ?? asset.name);

        // build full path by recursively following parent chain
        const segments: string[] = [name];
        let parent = path[path.length - 1];
        while (parent) {
            const parentUniqueId = this._idUniqueId.getL(parent);
            if (!parentUniqueId) {
                throw this.error.set(() => fail`missing id mapping for parent asset ${parent}`);
            }
            const parentAsset = this._assets.get(parentUniqueId);
            if (!parentAsset) {
                throw this.error.set(() => fail`missing parent asset ${parentUniqueId}`);
            }
            segments.unshift(sanitizeName(parentAsset.name));

            const parentPath = parentAsset.path ?? [];
            parent = parentPath[parentPath.length - 1];
        }
        return segments.join('/');
    }

    private _addAsset(uniqueId: number, doc: Doc) {
        if (this._assets.has(uniqueId)) {
            this._log.debug(`asset ${uniqueId} already added, skipping`);
            return;
        }

        const snapshot = structuredClone(doc.data);

        // store asset metadata
        this._assets.set(uniqueId, snapshot);

        // store id to uniqueId mapping
        const id = parseInt(snapshot.item_id, 10);
        this._idUniqueId.set(id, uniqueId);

        // subscribe to asset document
        doc.on('op', (op: ShareDbOp[], source: string) => {
            if (source === ShareDb.SOURCE) {
                return;
            }
            for (const o of op) {
                let object = snapshot;
                let skip = false;
                for (let i = 0; i < o.p.length - 1; i++) {
                    const p = o.p[i];
                    if (object[p] === undefined || object[p] === null) {
                        object[p] = {};
                    } else if (typeof object[p] !== 'object') {
                        // Cannot traverse into a primitive value - skip this op
                        this._log.warn(`skipping op that traverses into non-object property: ${o.p.join('.')}`);
                        skip = true;
                        break;
                    }
                    object = object[p];
                }
                if (skip) {
                    continue;
                }
                const key = o.p[o.p.length - 1];
                if (o.oi !== undefined) {
                    // object insert
                    const before = object[key];
                    object[key] = o.oi;
                    this._events.emit('asset:update', uniqueId, key, before, o.oi);
                } else if (o.od !== undefined) {
                    // object delete
                    const before = object[key];
                    delete object[key];
                    this._events.emit('asset:update', uniqueId, key, before, undefined);
                } else if (o.li !== undefined && o.ld !== undefined && Array.isArray(object[key])) {
                    // list set
                    const before = object[key].slice();
                    object[key][parseInt(o.p[o.p.length - 1], 10)] = o.li;
                    this._events.emit('asset:update', uniqueId, key, before, object[key]);
                } else if (o.li !== undefined && Array.isArray(object[key])) {
                    // list insert
                    const before = object[key].slice();
                    object[key].splice(parseInt(o.p[o.p.length - 1], 10), 0, o.li);
                    this._events.emit('asset:update', uniqueId, key, before, object[key]);
                } else if (o.ld !== undefined && Array.isArray(object[key])) {
                    // list delete
                    const before = object[key].slice();
                    object[key].splice(parseInt(o.p[o.p.length - 1], 10), 1);
                    this._events.emit('asset:update', uniqueId, key, before, object[key]);
                }
            }
        });
    }

    private _addFile(uniqueId: number, doc: Doc) {
        const path = this._assetPath(uniqueId);

        // check for file path collision
        const check = this.collisions.check(uniqueId);
        if (check.skip) {
            return check;
        }

        // after hard reset, collab server nullifies inactive doc data — skip until reload
        if (doc.data === null) {
            this._log.debug(`skipped file ${path} (null data, pending reload)`);
            return { skip: true, changed: false };
        }

        // wrap raw doc in OTDocument (canonical state owner)
        const otdoc = new OTDocument(doc);

        const asset = this._assets.get(uniqueId);
        if (!asset?.file) {
            throw this.error.set(() => fail`missing file data for asset ${uniqueId}`);
        }
        const docHash = hash(otdoc.text);
        const s3Hash = asset.file.hash;
        const dirty = docHash !== s3Hash;

        const file: VirtualFile = {
            type: 'file',
            uniqueId,
            doc: otdoc,
            dirty
        };
        this._files.set(path, file);

        // shareDB -> vscode (source filtering is internal to OTDocument)
        otdoc.on('op', (op, prev) => {
            const path = this._assetPath(uniqueId);

            // compute dirty: does doc content still differ from last S3 save?
            // if asset metadata is missing, defaults to dirty (undefined !== hash)
            const asset = this._assets.get(uniqueId);
            const dirty = asset?.file?.hash !== hash(otdoc.text);
            file.dirty = dirty;

            // update must run before save so buffer is written before indicator clears
            this._events.emit('asset:file:update', path, op as ShareDbTextOp, otdoc.text, prev);
            if (!dirty) {
                this._events.emit('asset:file:save', path);
            }
        });

        // emit file created event with OTDocument content for disk
        this._events.emit('asset:file:create', path, 'file', buffer.from(otdoc.text));

        this._log.debug(`added file ${path} (${dirty ? 'dirty' : 'clean'})`);

        return { skip: false, changed: false };
    }

    private _addFolder(uniqueId: number) {
        const path = this._assetPath(uniqueId);

        // already registered with same uniqueId (from create's optimistic add)
        // NOTE: skip asset:file:create — folder was created locally, disk doesn't need notification
        const existing = this._files.get(path);
        if (existing?.uniqueId === uniqueId) {
            return { skip: false, changed: false };
        }

        // check for file path collision
        const check = this.collisions.check(uniqueId);
        if (check.skip) {
            return check;
        }

        // add folder
        const file: VirtualFile = {
            type: 'folder',
            uniqueId
        };
        this._files.set(path, file);

        // emit folder created event
        this._events.emit('asset:file:create', path, 'folder', new Uint8Array());

        this._log.debug(`added folder ${path}`);

        return { skip: false, changed: false };
    }

    private _addStub(uniqueId: number) {
        const path = this._assetPath(uniqueId);

        const check = this.collisions.check(uniqueId);
        if (check.skip) {
            return check;
        }

        const asset = this._assets.get(uniqueId);
        if (!asset?.file) {
            throw this.error.set(() => fail`missing file data for asset ${uniqueId}`);
        }

        this._files.set(path, { type: 'stub', uniqueId, dirty: false });
        this._events.emit('asset:file:create', path, 'file', new Uint8Array());

        this._log.debug(`added stub ${path}`);
        return { skip: false, changed: false };
    }

    private _verifySave(state: 'success' | 'error', uniqueId: number) {
        if (state === 'success') {
            const entry = this._saveRetries.get(uniqueId);
            clearTimeout(entry?.timeout);
            this._saveRetries.delete(uniqueId);
            return true;
        }

        this._log.warn(`failed to save document ${uniqueId}: ${state}`);

        // skip if already retrying this doc
        const entry = this._saveRetries.get(uniqueId);
        if (entry?.timeout) {
            return false;
        }

        // enforce retry limit
        const attempt = (entry?.attempt ?? 0) + 1;
        if (attempt > ProjectManager.SAVE_MAX_RETRIES) {
            this._log.error(`giving up saving document ${uniqueId} after ${ProjectManager.SAVE_MAX_RETRIES} retries`);
            this._saveRetries.delete(uniqueId);
            return false;
        }

        // schedule retry
        const timeout = setTimeout(async () => {
            const e = this._saveRetries.get(uniqueId);
            if (e) {
                e.timeout = undefined;
            }

            // bail out if project was unlinked while waiting
            if (this._projectId === undefined) {
                return;
            }

            // re-open the document on the server via doc:reconnect
            await this._sharedb.sendRaw(`doc:reconnect:${uniqueId}`);

            // re-check after await — unlink may have happened during sendRaw
            if (this._projectId === undefined) {
                return;
            }

            this._sharedb.sendRaw(`doc:save:${uniqueId}`);
            this._log.debug(`retried save for document ${uniqueId} (attempt ${attempt})`);
        }, ProjectManager.SAVE_RETRY_DELAY_MS);

        this._saveRetries.set(uniqueId, { timeout, attempt });
        return false;
    }

    private _watchSharedb() {
        const docSaveHandle = this._sharedb.on('doc:save', (state, uniqueId) => {
            if (!this._assets.has(uniqueId)) {
                return;
            }

            if (!this._verifySave(state, uniqueId)) {
                return;
            }

            const path = this._assetPath(uniqueId);
            const file = this._files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // mark as clean (sharedb content now synced with S3)
            file.dirty = false;
            this._events.emit('asset:file:save', path);
        });
        return () => {
            this._sharedb.off('doc:save', docSaveHandle);
        };
    }

    private _watchMessenger(branchId: string) {
        const assetNewHandle = this._messenger.on('asset.new', async (e) => {
            const asset = e.data.asset;

            // validate branch
            if (asset.branchId !== branchId) {
                return;
            }

            // validate asset id
            const uniqueId = parseInt(asset.id, 10);
            if (isNaN(uniqueId)) {
                return;
            }

            // check if supported file type
            if (!FILE_TYPES.includes(asset.type)) {
                return;
            }

            // subscribe to asset document
            const doc1 = await this._sharedb.subscribe('assets', `${uniqueId}`);
            if (!doc1) {
                this.error.set(() => fail`failed to subscribe to new asset ${uniqueId}`);
                return;
            }

            this._cleanup.push(async () => {
                await this._sharedb.unsubscribe('assets', `${uniqueId}`);
            });

            // add asset
            this._addAsset(uniqueId, doc1);

            let skipsDirty = false;

            // handle folders
            if (asset.type === 'folder') {
                // add folder to file system
                if (this._addFolder(uniqueId).changed) {
                    skipsDirty = true;
                }
            } else {
                // wait for text based documents to be created (with timeout)
                const filename = new Promise<void>((resolve) => {
                    if (doc1.data.file?.filename) {
                        resolve();
                        return;
                    }
                    const load = () => {
                        if (doc1.data.file?.filename) {
                            doc1.off('op', load);
                            resolve();
                        }
                    };
                    doc1.on('op', load);
                });
                const [fnErr] = await tryCatch(
                    withTimeout(filename, EVENT_TIMEOUT_MS, `filename timed out for asset ${uniqueId}`)
                );
                if (fnErr) {
                    this._log.warn(fnErr.message);
                    return;
                }

                // check if asset was deleted during filename wait
                if (!this._assets.has(uniqueId)) {
                    this._log.debug(`asset ${uniqueId} deleted during creation, aborting`);
                    return;
                }

                // subscribe to asset document
                const doc2 = await this._sharedb.subscribe('documents', `${uniqueId}`);
                if (!doc2) {
                    this._log.error(`failed to subscribe to new document ${uniqueId}`);
                    return;
                }

                // check if asset was deleted during doc subscribe
                if (!this._assets.has(uniqueId)) {
                    this._log.debug(`asset ${uniqueId} deleted during creation, aborting`);
                    return;
                }

                this._cleanup.push(async () => {
                    await this._sharedb.unsubscribe('documents', `${uniqueId}`);
                });

                // add file to file system
                if (this._addFile(uniqueId, doc2).changed) {
                    skipsDirty = true;
                }
            }

            // emit asset created event
            this._events.emit('asset:create', uniqueId);

            // show any path collisions if found
            if (skipsDirty) {
                this.collisions.refresh();
            }
        });
        const assetDeleteHandle = this._messenger.on('assets.delete', async ({ data: { assets } }) => {
            // filter assets to only include valid ones
            const valid: [number, string, Asset][] = assets.reduce(
                (paths, raw) => {
                    // check for valid number
                    const uniqueId = parseInt(raw, 10);
                    if (isNaN(uniqueId)) {
                        return paths;
                    }

                    // check stored asset
                    const asset = this._assets.get(uniqueId);
                    if (!asset) {
                        return paths;
                    }

                    // check if asset is a supported type
                    if (!FILE_TYPES.includes(asset.type)) {
                        return paths;
                    }

                    // get path
                    const path = this._assetPath(uniqueId);
                    paths.push([uniqueId, path, asset]);
                    return paths;
                },
                [] as [number, string, Asset][]
            );

            let skipsDirty = false;

            // prepare subscriptions
            const subscriptions: [string, string][] = [];
            for (const [uniqueId, path, asset] of valid) {
                const file = this._files.get(path);
                if (file?.uniqueId === uniqueId) {
                    this._files.delete(path);
                }

                // check if collisions updated
                if (this.collisions.remove(uniqueId)) {
                    skipsDirty = true;
                }

                // emit a change event to update on disk
                this._events.emit('asset:file:delete', path);

                // remove from stored assets
                this._assets.delete(uniqueId);

                // remove from id mapping
                const id = parseInt(asset.item_id, 10);
                this._idUniqueId.delete(id, uniqueId);

                // prepare asset unsubscribe
                subscriptions.push(['assets', `${uniqueId}`]);

                // prepare document unsubscribe (only if actively subscribed)
                if (asset.type !== 'folder' && file?.type === 'file') {
                    subscriptions.push(['documents', `${uniqueId}`]);
                }

                // emit delete event
                this._events.emit('asset:delete', uniqueId);
            }

            // unsubscribe from ShareDB documents in bulk
            await this._sharedb.bulkUnsubscribe(subscriptions);

            // update collisions if any were modified
            if (skipsDirty) {
                this.collisions.refresh();
            }
        });
        return () => {
            this._messenger.off('asset.new', assetNewHandle);
            this._messenger.off('assets.delete', assetDeleteHandle);
        };
    }

    private _watchReconnect(projectId: number) {
        return effect(() => {
            if (!this._sharedb.connected.get()) {
                return;
            }

            const paths = Array.from(this._queued);
            this._queued.clear();

            for (const path of paths) {
                void this.subscribe(path)
                    .then((f) => {
                        if (f && f.type === 'file') {
                            this._relay.join(`document-${f.uniqueId}`, projectId);
                            this._cleanup.push(async () => {
                                this._relay.leave(`document-${f.uniqueId}`, projectId);
                            });
                        }
                    })
                    .catch((err: Error) => {
                        this._queued.add(path);
                        this._log.warn(`reconnect subscribe failed for ${path}: ${err.message}`);
                    });
            }
        });
    }

    private _watchEvents(projectId: number) {
        const assetUpdateHandle = this._events.on('asset:update', async (uniqueId, key, before, after) => {
            switch (true) {
                // handle rename or move
                case key === 'name' || key === 'path': {
                    // skip if types are invalid
                    if (key === 'name' && (typeof before !== 'string' || typeof after !== 'string')) {
                        this._log.warn(`skipping invalid name update: before=${typeof before}, after=${typeof after}`);
                        break;
                    }
                    if (key === 'path' && (!Array.isArray(before) || !Array.isArray(after))) {
                        this._log.warn(`skipping invalid path update: before=${typeof before}, after=${typeof after}`);
                        break;
                    }
                    const from = this._assetPath(uniqueId, { [key]: before });
                    const to = this._assetPath(uniqueId, { [key]: after });

                    let skipsDirty = false;

                    // check if new path will be a collision
                    if (this.collisions.check(uniqueId, { [key]: after }).skip) {
                        skipsDirty = true;

                        // collect paths to remove (don't modify map during iteration)
                        // NOTE: children are not added to collisions - they are implicitly
                        // NOTE: inaccessible because their parent is colliding. when the parent
                        // NOTE: collision resolves, children will be reloaded via project reload.
                        const remove: string[] = [];
                        for (const [path] of this._files) {
                            if (path === from || path.startsWith(from + '/')) {
                                remove.push(path);
                            }
                        }
                        for (const path of remove) {
                            this._files.delete(path);
                            this._events.emit('asset:file:delete', path);
                        }

                        this.collisions.refresh();
                        break;
                    }

                    // find all files that need updating
                    const update: [string, VirtualFile][] = [];
                    for (const [path, file] of this._files) {
                        if (path === from || path.startsWith(from + '/')) {
                            update.push([path, file]);
                        }
                    }

                    // update all files in memory
                    for (const [path, file] of update) {
                        const oldPath = path;
                        const newPath = to + path.slice(from.length);
                        this._files.delete(oldPath);
                        this._files.set(newPath, file);

                        // check if collisions updated
                        if (this.collisions.remove(file.uniqueId)) {
                            skipsDirty = true;
                        }
                    }

                    // check if collisions updated
                    if (this.collisions.remove(uniqueId)) {
                        skipsDirty = true;
                    }

                    // emit rename event
                    // NOTE: this will be the parent folder so do not emit for child files
                    this._events.emit('asset:file:rename', from, to);

                    // show collisions if dirty
                    if (skipsDirty) {
                        this.collisions.refresh();
                    }
                    break;
                }

                // handle remote save
                case key === 'file': {
                    const fileFrom = before as Asset['file'] | undefined;
                    const fileTo = after as Asset['file'] | undefined;

                    // skip if no change to file content
                    if (fileFrom?.hash === fileTo?.hash) {
                        break;
                    }

                    // find file by uniqueId
                    const path = this._assetPath(uniqueId);

                    // check if file exists
                    const file = this._files.get(path);
                    if (!file || file.type === 'folder') {
                        return;
                    }

                    if (file.type === 'file') {
                        // NOTE: only mark clean if local content matches the saved hash,
                        // NOTE: otherwise local unsaved changes would be silently discarded
                        const localHash = hash(file.doc.text);
                        if (fileTo?.hash === localHash) {
                            file.dirty = false;
                        }
                    } else {
                        // stub: no doc to compare, mark clean on remote save
                        file.dirty = false;
                    }

                    // add events for VS Code to clear dirty indicator
                    this._events.emit('asset:file:save', this._assetPath(uniqueId));
                    break;
                }
            }
        });

        const docOpenHandle = this._events.on('asset:doc:open', (path: string) => {
            const file = this._files.get(path);
            if (!file) {
                return;
            }

            const p =
                file.type === 'stub'
                    ? this.subscribe(path)
                    : file.type === 'file'
                      ? Promise.resolve(file)
                      : Promise.resolve(undefined);

            void p
                .then((f) => {
                    if (f && f.type === 'file') {
                        this._relay.join(`document-${f.uniqueId}`, projectId);
                        this._cleanup.push(async () => {
                            this._relay.leave(`document-${f.uniqueId}`, projectId);
                        });
                    }
                })
                .catch((err: Error) => {
                    this._queued.add(path);
                    this._log.warn(`subscribe failed for ${path}, queued: ${err.message}`);
                });
        });
        const docCloseHandle = this._events.on('asset:doc:close', (path: string) => {
            const file = this._files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            this._relay.leave(`document-${file.uniqueId}`, projectId);
            void this.unsubscribe(path).catch((err: Error) => {
                this._log.warn(`unsubscribe failed for ${path}: ${err.message}`);
            });
        });

        return () => {
            this._events.off('asset:update', assetUpdateHandle);

            this._events.off('asset:doc:open', docOpenHandle);
            this._events.off('asset:doc:close', docCloseHandle);
        };
    }

    private async _flush() {
        const pending = Array.from(this._files.values()).filter(
            (f): f is VirtualFile & { type: 'file' } => f.type === 'file' && f.doc.pending
        );
        if (!pending.length) {
            return;
        }

        this._log.info(`flushing ${pending.length} pending ops before unlink`);
        const waits = pending.map((f) => new Promise<void>((resolve) => f.doc.whenNothingPending(resolve)));
        const [err] = await tryCatch(
            withTimeout(Promise.all(waits), ProjectManager.FLUSH_TIMEOUT_MS, 'flush pending ops timed out')
        );
        if (err) {
            this._log.warn(err.message);
        }
    }

    async create(path: string, type: 'folder' | 'file', content?: Uint8Array) {
        if (!this._projectId || !this._branchId) {
            throw this.error.set(() => fail`project not loaded`);
        }

        const [parentPath, name] = parsePath(path);

        // validate name
        if (!name) {
            throw this.error.set(() => fail`missing name for ${path}`);
        }

        // check if file already exists
        if (this._files.get(path)?.type === type) {
            this._log.warn(`skipping create of ${type} ${path} as it already exists`);
            return;
        }

        // validate parent
        let parent: number | undefined = undefined;
        if (parentPath !== '') {
            const file = this._files.get(parentPath);
            if (!file || file.type !== 'folder') {
                throw this.error.set(() => fail`missing parent folder ${parentPath} of ${path}`);
            }
            parent = file.uniqueId;
        }

        // create rest promise first to use in load promise
        const rest = new Deferred<Asset>();

        // wait for messenger to notify of asset load
        let oncreate: ((uniqueId: number) => void) | undefined;
        const created = new Promise<void>((resolve) => {
            oncreate = async (uniqueId: number) => {
                const asset = await rest.promise;
                if (uniqueId === asset.uniqueId) {
                    this._events.off('asset:create', oncreate!);
                    resolve();
                }
            };
            this._events.on('asset:create', oncreate);
        });

        // create asset
        let data: {
            type: string;
            name: string;
            parent?: number;
            preload: boolean;
            filename?: string;
            file?: Blob;
        };
        if (type === 'folder') {
            data = {
                type: 'folder',
                name,
                parent,
                preload: false
            };
        } else {
            let ext = name.split('.').pop()?.toLowerCase() ?? '';
            const { assetType, blobType } = EXT_TO_ASSET.get(ext) ?? {
                assetType: 'text',
                blobType: 'text/plain'
            };
            const src = content?.length ? buffer.toString(content) : '\n';
            ext = EXT_TO_ASSET.has(ext) ? ext : 'txt';
            data = {
                type: assetType,
                name,
                parent,
                preload: true,
                filename: `${name}.${ext}`,
                file: new Blob([src], { type: blobType })
            };
        }

        // create asset
        const asset = await guard(this._rest.assetCreate(this._projectId, this._branchId, data), this.error);

        // register folder optimistically — don't depend on messenger round-trip
        // NOTE: only _files is populated; _assets/_idUniqueId require ShareDB doc
        // NOTE: shape (item_id, path[]) which differs from REST response (id, parent)
        if (type === 'folder') {
            this._files.set(path, { type: 'folder', uniqueId: asset.uniqueId });
        }

        // resolve rest promise
        rest.resolve(asset);

        // wait for asset to be created
        const [err] = await tryCatch(withTimeout(created, EVENT_TIMEOUT_MS, `create timed out for ${path}`));
        if (err) {
            if (oncreate) {
                this._events.off('asset:create', oncreate);
            }
            this._log.warn(err.message);
        }
    }

    async delete(path: string, type: 'file' | 'folder') {
        // check if file exists
        const file = this._files.get(path);
        if (!file || (file.type === 'stub' ? 'file' : file.type) !== type) {
            this._log.warn(`skipping delete of ${path} as it does not exist`);
            return;
        }

        // create delete promise listening on asset:delete event
        const fileUniqueId = file.uniqueId;
        let ondelete: ((uniqueId: number) => void) | undefined;
        const delete_ = new Promise<void>((resolve) => {
            ondelete = (uniqueId: number) => {
                if (uniqueId === fileUniqueId) {
                    this._events.off('asset:delete', ondelete!);
                    resolve();
                }
            };
            this._events.on('asset:delete', ondelete);
        });

        // notify ShareDB to delete asset
        this._sharedb.sendRaw(
            `fs${JSON.stringify({
                op: 'delete',
                ids: [file.uniqueId]
            })}`
        );

        // wait for delete promise to resolve
        const [err] = await tryCatch(withTimeout(delete_, EVENT_TIMEOUT_MS, `delete timed out for ${path}`));
        if (err) {
            if (ondelete) {
                this._events.off('asset:delete', ondelete);
            }
            this._log.warn(err.message);
        }

        this._log.debug(`deleted ${path}`);
    }

    async rename(oldPath: string, newPath: string) {
        if (!this._projectId || !this._branchId) {
            throw this.error.set(() => fail`project not loaded`);
        }

        // skip if paths are identical
        if (oldPath === newPath) {
            return;
        }

        // check if moving root
        if (oldPath === '') {
            throw this.error.set(() => fail`cannot move root folder`);
        }

        // check if src file exists
        if (!this._files.has(oldPath)) {
            throw this.error.set(() => fail`file not found ${oldPath}`);
        }

        // check if dest file already exists
        if (this._files.has(newPath)) {
            throw this.error.set(() => fail`file already exists ${newPath}`);
        }

        // parse old file path
        const [oldParent] = parsePath(oldPath);
        const [newParent, newName] = parsePath(newPath);

        // check if we are doing a rename
        if (oldParent === newParent) {
            // find file to rename
            const file = this._files.get(oldPath);
            if (!file) {
                throw this.error.set(() => fail`file not found ${oldPath}`);
            }

            // file update
            let onupdate: ((uniqueId: number, key: string) => void) | undefined;
            const updated = new Promise<void>((resolve) => {
                onupdate = (uniqueId: number, key: string) => {
                    if (uniqueId === file.uniqueId && key === 'name') {
                        this._events.off('asset:update', onupdate!);
                        resolve();
                    }
                };
                this._events.on('asset:update', onupdate);
            });

            // rename asset
            const renamed = guard(
                this._rest.assetRename(this._projectId, this._branchId, file.uniqueId, newName),
                this.error
            );

            // wait for rename and file update to complete
            const [err] = await tryCatch(
                withTimeout(Promise.all([renamed, updated]), EVENT_TIMEOUT_MS, `rename timed out for ${oldPath}`)
            );
            if (err) {
                if (onupdate) {
                    this._events.off('asset:update', onupdate);
                }
                this._log.warn(err.message);
            }

            this._log.debug(`renamed ${oldPath} to ${newPath}`);
            return;
        }

        // find src file
        const srcFile = this._files.get(oldPath);
        if (!srcFile) {
            throw this.error.set(() => fail`file not found ${oldPath}`);
        }

        // find dest folder
        const destFile = this._files.get(newParent);
        if (!destFile || destFile.type !== 'folder') {
            throw this.error.set(() => fail`destination folder not found ${newParent}`);
        }

        // file updated
        let onupdate: ((uniqueId: number, key: string) => void) | undefined;
        const updated = new Promise<void>((resolve) => {
            onupdate = (uniqueId: number, key: string) => {
                if (uniqueId === srcFile.uniqueId && key === 'path') {
                    this._events.off('asset:update', onupdate!);
                    resolve();
                }
            };
            this._events.on('asset:update', onupdate);
        });

        // move asset
        this._sharedb.sendRaw(
            `fs${JSON.stringify({
                op: 'move',
                ids: [srcFile.uniqueId],
                to: destFile.uniqueId
            })}`
        );

        // wait for file update to complete
        const [err] = await tryCatch(withTimeout(updated, EVENT_TIMEOUT_MS, `move timed out for ${oldPath}`));
        if (err) {
            if (onupdate) {
                this._events.off('asset:update', onupdate);
            }
            this._log.warn(err.message);
        }

        this._log.debug(`moved ${oldPath} to ${newPath}`);
    }

    async write(path: string, content: Uint8Array) {
        let file = this._files.get(path);
        if (!file || file.type === 'folder') {
            return;
        }

        // subscribe stub before writing
        if (file.type === 'stub') {
            const promoted = await this.subscribe(path);
            if (!promoted) {
                return;
            }
            file = promoted;
        }

        if (file.type !== 'file') {
            return;
        }

        // compute minimal diff and submit as single atomic op
        // NOTE: avoids two-step delete+insert which can lose concurrent remote edits
        const op = delta(file.doc.text, norm(buffer.toString(content)));
        if (!op) {
            return;
        }

        file.doc.apply(op);

        // mark as dirty (ops submitted that aren't saved yet)
        const prev = file.dirty;
        file.dirty = true;
        if (!prev) {
            this._events.emit('asset:file:dirty', path, true);
        }

        this._log.debug(`wrote file ${path}`);
    }

    save(path: string) {
        // check if file is in memory
        const file = this._files.get(path);
        if (!file || file.type !== 'file') {
            return;
        }

        // check if already saved (no pending changes)
        if (!file.dirty) {
            return;
        }

        // wait for pending ops to be acknowledged before saving,
        // matching the Code Editor's behavior (save.ts:144-150).
        // prevents saving stale content while ops are in-flight.
        file.doc.whenNothingPending(() => {
            this._sharedb.sendRaw(`doc:save:${file.uniqueId}`);
            this._log.debug(`saved file ${path}`);
        });
    }

    path(assetId: number) {
        const uniqueId = this._idUniqueId.getL(assetId);
        if (!uniqueId) {
            return undefined;
        }
        return this._assetPath(uniqueId);
    }

    loaded(assetId: number) {
        const uniqueId = this._idUniqueId.getL(assetId);
        if (!uniqueId) {
            return false;
        }
        const path = this._assetPath(uniqueId);
        const file = this._files.get(path);
        return file?.uniqueId === uniqueId;
    }

    async subscribe(path: string) {
        const file = this._files.get(path);
        if (!file) {
            return undefined;
        }

        // already subscribed
        if (file.type === 'file') {
            return file;
        }

        if (file.type !== 'stub') {
            return undefined;
        }

        // coalesce concurrent subscribe calls for the same path
        const inflight = this._subscribing.get(path);
        if (inflight) {
            return inflight;
        }

        const pending = this._doSubscribe(path, file.uniqueId);
        this._subscribing.set(path, pending);
        const result = await pending;
        this._subscribing.delete(path);
        return result;
    }

    private async _doSubscribe(path: string, uniqueId: number) {
        const doc = await this._sharedb.subscribe('documents', `${uniqueId}`);
        if (!doc) {
            this._log.error(`failed to subscribe to document ${uniqueId}`);
            return undefined;
        }

        // null data after hard reset — clean up and skip until reload
        if (doc.data === null) {
            await this._sharedb.unsubscribe('documents', `${uniqueId}`);
            this._log.debug(`subscribe skipped ${path} (null data, pending reload)`);
            return undefined;
        }

        this._cleanup.push(async () => {
            await this._sharedb.unsubscribe('documents', `${uniqueId}`);
        });

        const otdoc = new OTDocument(doc);
        const asset = this._assets.get(uniqueId);
        if (!asset?.file) {
            throw this.error.set(() => fail`missing file data for asset ${uniqueId}`);
        }
        const dirty = hash(otdoc.text) !== asset.file.hash;

        const promoted: VirtualFile & { type: 'file' } = {
            type: 'file',
            uniqueId,
            doc: otdoc,
            dirty
        };
        this._files.set(path, promoted);

        // wire op handler (same as _addFile)
        otdoc.on('op', (op, prev) => {
            const p = this._assetPath(uniqueId);
            const a = this._assets.get(uniqueId);
            const d = a?.file?.hash !== hash(otdoc.text);
            promoted.dirty = d;
            this._events.emit('asset:file:update', p, op as ShareDbTextOp, otdoc.text, prev);
            if (!d) {
                this._events.emit('asset:file:save', p);
            }
        });

        this._events.emit('asset:file:subscribed', path, otdoc.text, dirty);
        this._log.debug(`subscribed ${path} (${dirty ? 'dirty' : 'clean'})`);
        return promoted;
    }

    async unsubscribe(path: string) {
        this._queued.delete(path);

        const file = this._files.get(path);
        if (!file || file.type !== 'file') {
            return;
        }

        if (file.doc.pending) {
            this._log.debug(`skipping unsubscribe of ${path} (pending ops)`);
            return;
        }

        const uniqueId = file.uniqueId;
        await this._sharedb.unsubscribe('documents', `${uniqueId}`);
        this._sharedb.sendRaw(`close:document:${uniqueId}`);
        this._files.set(path, { type: 'stub', uniqueId, dirty: file.dirty });
        this._log.debug(`unsubscribed ${path}`);
    }

    async fetchContent(uniqueId: number) {
        const asset = this._assets.get(uniqueId);
        if (!asset?.file?.filename || !this._branchId) {
            return new Uint8Array();
        }
        const id = this._idUniqueId.getR(uniqueId);
        if (!id) {
            return new Uint8Array();
        }
        const buf = await this._rest.assetFile(id, this._branchId, asset.file.filename);
        return new Uint8Array(buf);
    }

    async link({ projectId, branchId }: { projectId: number; branchId: string }) {
        if (this._projectId !== undefined) {
            throw this.error.set(() => fail`project already linked`);
        }

        // drain stale cleanup from a previously failed link
        await super.unlink();

        // fetch project asset metadata
        const assets = await guard(this._rest.projectAssets(projectId, branchId, 'codeeditor'), this.error);

        // validate token scope by checking for uniqueId presence
        if (!Array.isArray(assets) || (assets.length > 0 && !('uniqueId' in assets[0]))) {
            throw this.error.set(() => fail`invalid access token scope`);
        }

        // add root folder
        this._files.set('', {
            type: 'folder',
            uniqueId: 0
        });

        const loadAssetNext = await progressNotification('Loading Assets', assets.length);

        // subscribe to all assets in batches
        const ordered: { uniqueId: number; data: Record<string, unknown> }[] = [];
        for (let i = 0; i < assets.length; i += BATCH_SIZE) {
            const batch = assets.slice(i, i + BATCH_SIZE);
            const subscriptions: [string, string][] = batch.map((asset) => ['assets', `${asset.uniqueId}`]);
            const docs = await this._sharedb.bulkSubscribe(subscriptions);
            this._cleanup.push(async () => {
                await this._sharedb.bulkUnsubscribe(subscriptions);
            });
            for (let j = 0; j < docs.length; j++) {
                const doc = docs[j];
                const uniqueId = batch[j].uniqueId;
                if (!doc) {
                    this._log.error(`failed to subscribe to asset ${uniqueId}`);
                    loadAssetNext();
                    continue;
                }

                // add asset
                this._addAsset(uniqueId, doc);

                // store in list for ordered processing
                ordered.push({ uniqueId, data: doc.data });

                loadAssetNext();
            }
        }

        // split folder and files
        const { folders: folders0, files: files0 } = ordered.reduce(
            (acc, asset) => {
                // check if supported file type
                const type = asset.data.type as string;
                if (!FILE_TYPES.includes(type)) {
                    return acc;
                }

                if (type === 'folder') {
                    acc.folders.push(asset);
                } else {
                    acc.files.push(asset);
                }
                return acc;
            },
            {
                folders: [] as typeof ordered,
                files: [] as typeof ordered
            }
        );

        // sort folders and files by path depth (parents before children)
        // this ensures parent collisions are detected before processing children
        // NOTE: walk parent chain directly to get depth; missing parents sort to end
        const depthCache = new Map<number, number>();
        const getDepth = (uniqueId: number): number => {
            if (depthCache.has(uniqueId)) {
                return depthCache.get(uniqueId)!;
            }
            let depth = 0;
            const asset = this._assets.get(uniqueId);
            if (!asset) {
                depthCache.set(uniqueId, Infinity);
                return Infinity;
            }
            let parent = (asset.path ?? [])[asset.path?.length - 1];
            while (parent) {
                const parentUniqueId = this._idUniqueId.getL(parent);
                if (!parentUniqueId) {
                    depthCache.set(uniqueId, Infinity);
                    return Infinity;
                }
                const parentAsset = this._assets.get(parentUniqueId);
                if (!parentAsset) {
                    depthCache.set(uniqueId, Infinity);
                    return Infinity;
                }
                depth++;
                const parentPath = parentAsset.path ?? [];
                parent = parentPath[parentPath.length - 1];
            }
            depthCache.set(uniqueId, depth);
            return depth;
        };
        const sortByPathDepth = (a: (typeof ordered)[0], b: (typeof ordered)[0]) => {
            return getDepth(a.uniqueId) - getDepth(b.uniqueId);
        };
        folders0.sort(sortByPathDepth);
        files0.sort(sortByPathDepth);

        // drop assets whose parent chain is broken
        const reachable = (a: (typeof ordered)[0]) => {
            const depth = getDepth(a.uniqueId);
            if (depth === Infinity) {
                this._log.warn(`skipping asset ${a.uniqueId} — missing parent in chain`);
                return false;
            }
            return true;
        };
        const folders = folders0.filter(reachable);
        const files = files0.filter(reachable);

        const loadFileNext = await progressNotification('Loading Files', folders.length + files.length);
        let skipsDirty = false;

        // add all folders first
        for (const asset of folders) {
            if (this._addFolder(asset.uniqueId).changed) {
                skipsDirty = true;
            }
            loadFileNext();
        }

        // add file stubs (lazy — document subscribed on open)
        for (const asset of files) {
            if (this._addStub(asset.uniqueId).changed) {
                skipsDirty = true;
            }
            loadFileNext();
        }

        // show collisions if dirty
        if (skipsDirty) {
            this.collisions.refresh();
        }

        // watchers
        const unwatchEvents = this._watchEvents(projectId);
        const unwatchSharedb = this._watchSharedb();
        const unwatchMessenger = this._watchMessenger(branchId);
        const unwatchReconnect = this._watchReconnect(projectId);

        // register cleanup
        this._cleanup.push(async () => {
            unwatchEvents();
            unwatchSharedb();
            unwatchMessenger();
            unwatchReconnect();

            this._saveRetries.forEach(({ timeout }) => clearTimeout(timeout));
            this._saveRetries.clear();

            this._files.clear();
            this._assets.clear();
            this._idUniqueId.clear();
            this._subscribing.clear();
            this._queued.clear();

            this.collisions.clear();
        });

        this._projectId = projectId;
        this._branchId = branchId;

        this._log.info(`project ${projectId} (branch ${branchId}) loaded`);
    }

    async unlink() {
        const projectId = this._projectId;
        const branchId = this._branchId;
        if (projectId === undefined || branchId === undefined) {
            throw this.error.set(() => fail`unlink called before link`);
        }
        await this._flush();
        await super.unlink();
        this._projectId = undefined;
        this._branchId = undefined;
        this._log.info(`project ${projectId} (branch ${branchId}) unloaded`);
        return { projectId, branchId };
    }
}

export { ProjectManager };
