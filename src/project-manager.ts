import type { Doc } from 'sharedb';
import * as vscode from 'vscode';

import { NAME } from './config';
import type { Messenger } from './connections/messenger';
import type { Relay } from './connections/relay';
import type { Rest } from './connections/rest';
import { ShareDb } from './connections/sharedb';
import { progressNotification } from './notification';
import type { EventMap } from './typings/event-map';
import type { Asset } from './typings/models';
import type { ShareDbOp, ShareDbTextOp } from './typings/sharedb';
import * as buffer from './utils/buffer';
import { Deferred } from './utils/deferred';
import type { EventEmitter } from './utils/event-emitter';
import { Linker } from './utils/linker';
import { signal } from './utils/signal';
import { hash, parsePath, guard } from './utils/utils';

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
          doc: Doc;
          dirty: boolean; // true if hash(doc.data) != asset.file.hash
      }
);

class ProjectManager extends Linker<{ projectId: number; branchId: string }> {
    private _events: EventEmitter<EventMap>;

    private _sharedb: ShareDb;

    private _messenger: Messenger;

    private _relay: Relay;

    private _rest: Rest;

    private _projectId?: number;

    private _branchId?: string;

    private _assets: Map<number, Asset> = new Map<number, Asset>();

    private _files: Map<string, VirtualFile> = new Map<string, VirtualFile>();

    private _idToUniqueId: Map<number, number> = new Map<number, number>();

    private _collisions: Set<number> = new Set<number>();

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
    }

    get files() {
        return this._files;
    }

    get collisions() {
        const list: { path: string; id: number }[] = [];
        if (this._collisions.size === 0) {
            return list;
        }
        for (const uniqueId of this._collisions) {
            const asset = this._assets.get(uniqueId);
            if (!asset) {
                continue;
            }
            const path = this._assetPath(uniqueId);
            const id = parseInt(asset.item_id, 10);
            list.push({ path, id });
        }
        return list;
    }

    private _assetPath(uniqueId: number, override: { path?: number[]; name?: string } = {}) {
        const asset = this._assets.get(uniqueId);
        if (!asset) {
            throw this.error.set(() => new Error(`missing child asset ${uniqueId}`));
        }

        const path = override.path ?? asset.path;
        const name = override.name ?? asset.name;

        // NOTE: path can contain duplicate asset ids, so we need to filter them out
        return Array.from(new Set(path))
            .map((id) => {
                const uniqueId = this._idToUniqueId.get(id);
                if (!uniqueId) {
                    throw this.error.set(() => new Error(`missing asset id mapping for ${id}`));
                }
                const asset = this._assets.get(uniqueId);
                if (!asset) {
                    throw this.error.set(() => new Error(`missing asset ${uniqueId}`));
                }
                return asset.name;
            })
            .concat(name)
            .join('/');
    }

    private _checkCollision(uniqueId: number, override: { path?: number[]; name?: string } = {}) {
        // check if file path already exists
        const filePath = this._assetPath(uniqueId, override);
        if (this._files.has(filePath)) {
            this._log.warn(`skipping loading asset ${uniqueId} as path already exists: ${filePath}`);
            this._collisions.add(uniqueId);
            return true;
        }

        // check if ancesetor of asset has a collision (not shown in file system)
        const asset = this._assets.get(uniqueId);
        if (!asset) {
            throw this.error.set(() => new Error(`missing child asset ${uniqueId}`));
        }
        const path = override.path ?? asset.path;
        if (!path) {
            throw this.error.set(() => new Error(`missing asset path for ${uniqueId}`));
        }
        for (const id of path) {
            const parentUniqueId = this._idToUniqueId.get(id);
            if (!parentUniqueId) {
                throw this.error.set(() => new Error(`missing asset id mapping for ${id}`));
            }
            if (this._collisions.has(parentUniqueId)) {
                this._log.warn(
                    `skipping loading of asset ${uniqueId} as ancestor asset ${parentUniqueId} has a path collision`
                );
                this._collisions.add(uniqueId);
                return true;
            }
        }

        return false;
    }

    private _alertCollisions() {
        if (this._collisions.size === 0) {
            return;
        }
        const count = this._collisions.size;
        const options = [`Show Asset${count !== 1 ? 's' : ''}`, 'Reload project'];
        vscode.window
            .showWarningMessage(
                [
                    `Skipped loading ${count} asset${count !== 1 ? 's' : ''} due to path collisions.`,
                    'Rename or move the conflicted files in the Editor to resolve.'
                ].join('\n'),
                ...options
            )
            .then((option) => {
                switch (option) {
                    case options[0]: {
                        vscode.commands.executeCommand(`${NAME}.showSkippedAssets`);
                        break;
                    }
                    case options[1]: {
                        vscode.commands.executeCommand(`${NAME}.reloadProject`);
                        break;
                    }
                }
            });
    }

    private _addAsset(uniqueId: number, doc: Doc) {
        if (this._assets.has(uniqueId)) {
            throw this.error.set(() => new Error('asset already added'));
        }

        const snapshot = structuredClone(doc.data);

        // store asset metadata
        this._assets.set(uniqueId, snapshot);

        // store id to uniqueId mapping
        const id = parseInt(snapshot.item_id, 10);
        this._idToUniqueId.set(id, uniqueId);

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
        if (this._checkCollision(uniqueId)) {
            return false;
        }

        // compute dirty state by comparing hash of doc content vs S3 hash
        const asset = this._assets.get(uniqueId);
        if (!asset?.file) {
            throw this.error.set(() => new Error(`missing file data for asset ${uniqueId}`));
        }
        const docHash = hash(doc.data);
        const s3Hash = asset.file.hash;
        const dirty = docHash !== s3Hash;

        const file: VirtualFile = {
            type: 'file',
            uniqueId,
            doc,
            dirty
        };
        this._files.set(path, file);

        // shareDB -> vscode
        doc.on('op', (op: unknown, source) => {
            // avoid echo
            if (source === ShareDb.SOURCE) {
                return;
            }

            const path = this._assetPath(uniqueId);

            // mark as dirty (ops received that aren't saved yet)
            file.dirty = true;

            // emit a change event to update editor and disk
            this._events.emit('asset:file:update', path, op as ShareDbTextOp, buffer.from(doc.data));
        });

        // emit file created event with ShareDB content for disk
        this._events.emit('asset:file:create', path, 'file', buffer.from(doc.data));

        this._log.debug(`added file ${path} (${dirty ? 'dirty' : 'clean'})`);

        return true;
    }

    private _addFolder(uniqueId: number) {
        const path = this._assetPath(uniqueId);

        // check for file path collision
        if (this._checkCollision(uniqueId)) {
            return false;
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

        return true;
    }

    private _watchSharedb() {
        const docSaveHandle = this._sharedb.on('doc:save', (state, uniqueId) => {
            if (state !== 'success') {
                this._log.warn(`failed to save document ${uniqueId}: ${state}`);
                return;
            }

            // find file by uniqueId
            const path = this._assetPath(uniqueId);

            // check if file exists
            const file = this._files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // mark as clean (sharedb content now synced with S3)
            file.dirty = false;
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
                this.error.set(() => new Error(`failed to subscribe to new asset ${uniqueId}`));
                return;
            }
            this._cleanup.push(async () => {
                await this._sharedb.unsubscribe('assets', `${uniqueId}`);
            });

            // add asset
            this._addAsset(uniqueId, doc1);

            let collisionsFound = false;

            // handle folders
            if (asset.type === 'folder') {
                // add folder to file system
                if (!this._addFolder(uniqueId)) {
                    collisionsFound = true;
                }
            } else {
                // wait for text based documents to be created
                await new Promise<void>((resolve) => {
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

                // subscribe to asset document
                const doc2 = await this._sharedb.subscribe('documents', `${uniqueId}`);
                if (!doc2) {
                    this.error.set(() => new Error(`failed to subscribe to new document ${uniqueId}`));
                    return;
                }
                this._cleanup.push(async () => {
                    await this._sharedb.unsubscribe('documents', `${uniqueId}`);
                });

                // add file to file system
                if (!this._addFile(uniqueId, doc2)) {
                    collisionsFound = true;
                }
            }

            // emit asset created event
            this._events.emit('asset:create', uniqueId);

            // show any path collisions if found
            if (collisionsFound) {
                this._alertCollisions();
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

            let collisionsDirty = false;

            // prepare subscriptions
            const subscriptions: [string, string][] = [];
            for (const [uniqueId, path, asset] of valid) {
                const file = this._files.get(path);
                if (file?.uniqueId === uniqueId) {
                    this._files.delete(path);
                } else {
                    this._collisions.delete(uniqueId);
                    collisionsDirty = true;
                }

                // emit a change event to update on disk
                this._events.emit('asset:file:delete', path);

                // remove from stored assets
                this._assets.delete(uniqueId);

                // remove from id mapping
                const id = parseInt(asset.item_id, 10);
                this._idToUniqueId.delete(id);

                // prepare asset unsubscribe
                subscriptions.push(['assets', `${uniqueId}`]);

                // prepare document unsubscribe
                if (asset.type !== 'folder') {
                    subscriptions.push(['documents', `${uniqueId}`]);
                }

                // emit delete event
                this._events.emit('asset:delete', uniqueId);
            }

            // unsubscribe from ShareDB documents in bulk
            await this._sharedb.bulkUnsubscribe(subscriptions);

            // show collisions if dirty
            if (collisionsDirty) {
                this._alertCollisions();
            }
        });
        return () => {
            this._messenger.off('asset.new', assetNewHandle);
            this._messenger.off('assets.delete', assetDeleteHandle);
        };
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

                    let collisionsDirty = false;

                    // check if old path is a collision
                    if (this._checkCollision(uniqueId, { [key]: before })) {
                        collisionsDirty = true;
                    }

                    // check if new path is a collision
                    if (this._checkCollision(uniqueId, { [key]: after })) {
                        collisionsDirty = true;

                        // remove old file/folder from memory
                        this._files.delete(from);

                        // emit delete event for old path
                        this._events.emit('asset:file:delete', from);

                        // show collisions if dirty
                        if (collisionsDirty) {
                            this._alertCollisions();
                        }
                        break;
                    }

                    // find all files that need updating
                    const update: [string, VirtualFile][] = [];
                    for (const [path, file] of this._files) {
                        if (path.startsWith(from)) {
                            update.push([path, file]);
                        }
                    }

                    // update all files in memory
                    for (const [path, file] of update) {
                        const oldPath = path;
                        const newPath = path.replace(from, to);
                        this._files.delete(oldPath);
                        this._files.set(newPath, file);
                    }

                    // emit rename event
                    // NOTE: this will be the parent folder so do not emit for child files
                    this._events.emit('asset:file:rename', from, to);

                    // show collisions if dirty
                    if (collisionsDirty) {
                        this._alertCollisions();
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
                    if (!file || file.type !== 'file') {
                        return;
                    }

                    // mark as clean (sharedb content now synced with S3)
                    file.dirty = false;

                    // add events for VS Code to clear dirty indicator
                    this._events.emit('asset:file:save', this._assetPath(uniqueId));
                    break;
                }
            }
        });

        const docOpenHandle = this._events.on('asset:doc:open', (path: string) => {
            // wait for file to be available
            this.waitForFile(path, 'file').then((file) => {
                // join relay room
                this._relay.join(`document-${file.uniqueId}`, projectId);
                this._cleanup.push(async () => {
                    this._relay.leave(`document-${file.uniqueId}`, projectId);
                });
            });
        });
        const docCloseHandle = this._events.on('asset:doc:close', (path: string) => {
            // check if in project
            const file = this._files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // leave relay room
            this._relay.leave(`document-${file.uniqueId}`, projectId);
        });

        return () => {
            this._events.off('asset:update', assetUpdateHandle);

            this._events.off('asset:doc:open', docOpenHandle);
            this._events.off('asset:doc:close', docCloseHandle);
        };
    }

    async waitForFile(path: string, type: 'file' | 'folder') {
        // check if file already exists
        const file = this._files.get(path);
        if (file && file.type === type) {
            return file;
        }

        // creation promise
        return new Promise<VirtualFile>((resolve) => {
            const oncreate = (uniqueId: number) => {
                const assetPath = this._assetPath(uniqueId);
                if (assetPath === path) {
                    const file = this._files.get(path);
                    if (!file || file.type !== type) {
                        return;
                    }
                    this._events.off('asset:create', oncreate);
                    resolve(file);
                }
            };
            this._events.on('asset:create', oncreate);
        });
    }

    async create(path: string, type: 'folder' | 'file', content?: Uint8Array) {
        if (!this._projectId || !this._branchId) {
            throw this.error.set(() => new Error('project not loaded'));
        }

        const [parentPath, name] = parsePath(path);

        // validate name
        if (!name) {
            throw this.error.set(() => new Error(`missing name for ${path}`));
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
                throw this.error.set(() => new Error(`missing parent folder ${parentPath} of ${path}`));
            }
            parent = file.uniqueId;
        }

        // create rest promise first to use in load promise
        const rest = new Deferred<Asset>();

        // wait for messenger to notify of asset load
        const created = new Promise<void>((resolve) => {
            const oncreate = async (uniqueId: number) => {
                const asset = await rest.promise;
                if (uniqueId === asset.uniqueId) {
                    this._events.off('asset:create', oncreate);
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

        // resolve rest promise
        rest.resolve(asset);

        // wait for asset to be created
        await created;
    }

    async delete(path: string, type: 'file' | 'folder') {
        // check if file exists
        const file = this._files.get(path);
        if (!file || file.type !== type) {
            this._log.warn(`skipping delete of ${path} as it does not exist`);
            return;
        }

        // create delete promise listening on asset:delete event
        const fileUniqueId = file.uniqueId;
        const delete_ = new Promise<void>((resolve) => {
            const ondelete = (uniqueId: number) => {
                if (uniqueId === fileUniqueId) {
                    this._events.off('asset:delete', ondelete);
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
        await delete_;

        this._log.debug(`deleted ${path}`);
    }

    async rename(oldPath: string, newPath: string) {
        if (!this._projectId || !this._branchId) {
            throw this.error.set(() => new Error('project not loaded'));
        }

        // skip if paths are identical
        if (oldPath === newPath) {
            return;
        }

        // check if moving root
        if (oldPath === '') {
            throw this.error.set(() => new Error('cannot move root folder'));
        }

        // check if src file exists
        if (!this._files.has(oldPath)) {
            throw this.error.set(() => new Error(`file not found ${oldPath}`));
        }

        // check if dest file already exists
        if (this._files.has(newPath)) {
            throw this.error.set(() => new Error(`file already exists ${newPath}`));
        }

        // parse old file path
        const [oldParent] = parsePath(oldPath);
        const [newParent, newName] = parsePath(newPath);

        // check if we are doing a rename
        if (oldParent === newParent) {
            // find file to rename
            const file = this._files.get(oldPath);
            if (!file) {
                throw this.error.set(() => new Error(`file not found ${oldPath}`));
            }

            // file update
            const updated = new Promise<void>((resolve) => {
                const onupdate = (uniqueId: number, key: string) => {
                    if (uniqueId === file.uniqueId && key === 'name') {
                        this._events.off('asset:update', onupdate);
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
            await Promise.all([renamed, updated]);

            this._log.debug(`renamed ${oldPath} to ${newPath}`);
            return;
        }

        // find src file
        const srcFile = this._files.get(oldPath);
        if (!srcFile) {
            throw this.error.set(() => new Error(`file not found ${oldPath}`));
        }

        // find dest folder
        const destFile = this._files.get(newParent);
        if (!destFile || destFile.type !== 'folder') {
            throw this.error.set(() => new Error(`destination folder not found ${newParent}`));
        }

        // file updated
        const updated = new Promise<void>((resolve) => {
            const onupdate = (uniqueId: number, key: string) => {
                if (uniqueId === srcFile.uniqueId && key === 'path') {
                    this._events.off('asset:update', onupdate);
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
        await updated;

        this._log.debug(`moved ${oldPath} to ${newPath}`);
    }

    write(path: string, content: Uint8Array) {
        // check if file is in memory
        const file = this._files.get(path);
        if (!file || file.type !== 'file') {
            return;
        }

        // overwrite entire document content
        // vscode -> shareDB
        // FIXME: optimize to use ops instead of full replace
        file.doc.submitOp([0, { d: file.doc.data.length }], {
            source: ShareDb.SOURCE
        });
        file.doc.submitOp([0, buffer.toString(content)], {
            source: ShareDb.SOURCE
        });

        // mark as dirty (ops submitted that aren't saved yet)
        file.dirty = true;

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

        // notify ShareDB to save the document
        this._sharedb.sendRaw(`doc:save:${file.uniqueId}`);

        this._log.debug(`saved file ${path}`);
    }

    path(assetId: number) {
        const uniqueId = this._idToUniqueId.get(assetId);
        if (!uniqueId) {
            return undefined;
        }
        for (const [path, file] of this._files) {
            if (file.uniqueId === uniqueId) {
                return path;
            }
        }
        return undefined;
    }

    async link({ projectId, branchId }: { projectId: number; branchId: string }) {
        if (this._projectId || this._branchId) {
            throw this.error.set(() => new Error('project already linked'));
        }

        // fetch project asset metadata
        const assets = await guard(this._rest.projectAssets(projectId, branchId, 'codeeditor'), this.error);

        // validate token scope by checking for uniqueId presence
        if (!Array.isArray(assets) || (assets.length > 0 && !('uniqueId' in assets[0]))) {
            throw this.error.set(() => new Error('invalid access token scope'));
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
                    this.error.set(() => new Error(`failed to subscribe to asset ${uniqueId}`));
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
        const { folders, files } = ordered.reduce(
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
        const sortByPathDepth = (a: (typeof ordered)[0], b: (typeof ordered)[0]) => {
            const pathA = (a.data.path as number[] | undefined) ?? [];
            const pathB = (b.data.path as number[] | undefined) ?? [];
            return pathA.length - pathB.length;
        };
        folders.sort(sortByPathDepth);
        files.sort(sortByPathDepth);

        const loadFileNext = await progressNotification('Loading Files', folders.length + files.length);
        let collisionsDirty = false;

        // add all folders first
        for (const asset of folders) {
            if (!this._addFolder(asset.uniqueId)) {
                collisionsDirty = true;
            }
            loadFileNext();
        }

        // add all files next in batches
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            const subscriptions: [string, string][] = batch.map((asset) => ['documents', `${asset.uniqueId}`]);
            const docs = await this._sharedb.bulkSubscribe(subscriptions);
            this._cleanup.push(async () => {
                await this._sharedb.bulkUnsubscribe(subscriptions);
            });
            for (let j = 0; j < docs.length; j++) {
                const doc = docs[j];
                const { uniqueId } = batch[j];
                if (!doc) {
                    this.error.set(() => new Error(`failed to subscribe to document ${uniqueId}`));
                    loadFileNext();
                    continue;
                }

                // add file to file system
                if (!this._addFile(uniqueId, doc)) {
                    collisionsDirty = true;
                }
                loadFileNext();
            }
        }

        // show collisions if dirty
        if (collisionsDirty) {
            this._alertCollisions();
        }

        // watchers
        const unwatchEvents = this._watchEvents(projectId);
        const unwatchSharedb = this._watchSharedb();
        const unwatchMessenger = this._watchMessenger(branchId);

        // store state
        this._projectId = projectId;
        this._branchId = branchId;

        // register cleanup
        this._cleanup.push(async () => {
            unwatchEvents();
            unwatchSharedb();
            unwatchMessenger();

            this._files.clear();
            this._assets.clear();
            this._idToUniqueId.clear();
            this._collisions.clear();

            this._projectId = undefined;
            this._branchId = undefined;
        });

        this._log.info(`project ${this._projectId} (branch ${this._branchId}) loaded`);
    }

    async unlink() {
        if (!this._projectId || !this._branchId) {
            throw this.error.set(() => new Error('project not linked'));
        }
        const projectId = this._projectId;
        const branchId = this._branchId;

        await super.unlink();

        this._log.info(`project ${projectId} (branch ${branchId}) unloaded`);

        return { projectId, branchId };
    }
}

export { ProjectManager };
