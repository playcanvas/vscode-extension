import type { Doc } from 'sharedb';

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
import { parsePath } from './utils/utils';

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
    ctime: number;
    mtime: number;
    uniqueId: number;
} & (
    | {
          type: 'folder';
      }
    | {
          type: 'file';
          doc: Doc;
          saved: boolean;
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

    error = signal<Error | undefined>(undefined);

    constructor({
        debug,
        events,
        sharedb,
        messenger,
        relay,
        rest
    }: {
        debug?: boolean;
        events: EventEmitter<EventMap>;
        sharedb: ShareDb;
        messenger: Messenger;
        relay: Relay;
        rest: Rest;
    }) {
        super(debug);

        this._events = events;
        this._sharedb = sharedb;
        this._messenger = messenger;
        this._relay = relay;
        this._rest = rest;
    }

    get files() {
        return this._files;
    }

    private _warn(...args: unknown[]) {
        console.warn(`[${this.constructor.name}]`, ...args);
    }

    private _assetPath(uniqueId: number, override: { path?: number[]; name?: string } = {}): string {
        const asset = this._assets.get(uniqueId);
        if (!asset) {
            throw new Error(`missing child asset ${uniqueId}`);
        }

        const path = override.path ?? asset.path;
        const name = override.name ?? asset.name;

        // FIXME: build full path using recursive approach as path can have duplicate asset ids
        const segments: string[] = [name];
        let parent = path[path.length - 1];
        while (parent) {
            const uniqueId = this._idToUniqueId.get(parent);
            if (!uniqueId) {
                throw new Error(`missing parent asset id mapping for ${parent}`);
            }
            const asset = this._assets.get(uniqueId);
            if (!asset) {
                throw new Error(`missing parent asset ${uniqueId}`);
            }
            segments.unshift(asset.name);

            const path = asset.path ?? [];
            parent = path[path.length - 1];
        }
        return segments.join('/');

        // // FIXME: path can have duplicate asset ids, why?
        // const path = [...new Set(override.path ?? asset.path)];
        // const name = override.name ?? asset.name;
        // return `${path
        //     .map((id: number) => {
        //         const asset = this._assets.get(id);
        //         if (!asset) {
        //             throw new Error(`missing asset ${id}`);
        //         }
        //         return `${asset.name}/`;
        //     })
        //     .join('')}${name}`;
    }

    private _addAsset(uniqueId: number, doc: Doc) {
        if (this._assets.has(uniqueId)) {
            throw new Error('asset already added');
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
                for (let i = 0; i < o.p.length - 1; i++) {
                    const p = o.p[i];
                    if (typeof object[p] !== 'object' || object[p] === null) {
                        object[p] = {};
                    }
                    object = object[p];
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

    private async _addFile(uniqueId: number, doc: Doc) {
        const path = this._assetPath(uniqueId);
        const now = Date.now();

        // check if file path already exists
        if (this._files.has(path)) {
            this._warn(`skipping load of ${path} for asset ${uniqueId} as it already exists`);
            return;
        }

        const file: VirtualFile = {
            type: 'file',
            ctime: now,
            mtime: now,
            uniqueId,
            doc,
            saved: true
        };
        this._files.set(path, file);

        // shareDB -> vscode
        doc.on('op', (op: unknown, source) => {
            // avoid echo
            if (source === ShareDb.SOURCE) {
                return;
            }

            const path = this._assetPath(uniqueId);

            // update modified time
            file.mtime = Date.now();

            // emit a change event to update on disk
            this._events.emit('asset:file:update', path, op as ShareDbTextOp, buffer.from(doc.data));
        });

        this._events.emit('asset:file:create', path, 'file', buffer.from(doc.data));

        this._log(`added file ${path}`);
    }

    private async _addFolder(uniqueId: number) {
        const path = this._assetPath(uniqueId);
        const now = Date.now();

        // check if file path already exists
        if (this._files.has(path)) {
            this._warn(`skipping load of ${path} for asset ${uniqueId} as it already exists`);
            return;
        }

        // add folder
        const file: VirtualFile = {
            type: 'folder',
            ctime: now,
            mtime: now,
            uniqueId
        };
        this._files.set(path, file);
        this._events.emit('asset:file:create', path, 'folder', new Uint8Array());

        this._log(`added folder ${path}`);
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
                this.error.set(() => new Error(`Failed to subscribe to new asset ${uniqueId}`));
                return;
            }
            this._cleanup.push(async () => {
                await this._sharedb.unsubscribe('assets', `${uniqueId}`);
            });

            // add asset
            this._addAsset(uniqueId, doc1);

            // handle folders
            if (asset.type === 'folder') {
                // add folder to file system
                await this._addFolder(uniqueId);

                // emit asset created event
                this._events.emit('asset:create', uniqueId);
                return;
            }

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
                this.error.set(() => new Error(`Failed to subscribe to new document ${uniqueId}`));
                return;
            }
            this._cleanup.push(async () => {
                await this._sharedb.unsubscribe('documents', `${uniqueId}`);
            });

            // add file to file system
            await this._addFile(uniqueId, doc2);

            // emit asset created event
            this._events.emit('asset:create', uniqueId);
        });
        const assetDeleteHandle = this._messenger.on('assets.delete', async (e) => {
            const subscriptions: [string, string][] = [];
            for (const raw of e.data.assets) {
                // check for valid number
                const uniqueId = parseInt(raw, 10);
                if (isNaN(uniqueId)) {
                    continue;
                }

                // check stored asset
                const asset = this._assets.get(uniqueId);
                if (!asset) {
                    continue;
                }

                // check if asset is a supported type
                if (!FILE_TYPES.includes(asset.type)) {
                    continue;
                }

                // remove from file system
                const path = this._assetPath(uniqueId);
                const file = this._files.get(path);
                if (file?.uniqueId === uniqueId) {
                    this._files.delete(path);
                } else {
                    this._warn(`skipping delete of ${path} for asset ${uniqueId} as it does not exist`);
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
        });
        return () => {
            this._messenger.off('asset.new', assetNewHandle);
            this._messenger.off('assets.delete', assetDeleteHandle);
        };
    }

    private _watchEvents(projectId: number) {
        const assetUpdateHandle = this._events.on('asset:update', async (uniqueId, key, before, after) => {
            // handle rename or move
            if (key === 'name' || key === 'path') {
                const from = this._assetPath(uniqueId, { [key]: before });
                const to = this._assetPath(uniqueId, { [key]: after });

                // find all files that need updating
                const update: [string, VirtualFile][] = [];
                for (const [path, file] of this._files) {
                    if (path.startsWith(from)) {
                        update.push([path, file]);
                    }
                }

                // update all files
                for (const [path, file] of update) {
                    const oldPath = path;
                    const newPath = path.replace(from, to);

                    // update in files
                    this._files.delete(oldPath);
                    this._files.set(newPath, file);

                    // add events for VS Code
                    this._events.emit('asset:file:rename', oldPath, newPath);
                }
            }
        });

        const docOpenHandle = this._events.on('asset:doc:open', (path: string) => {
            // wait for file to be available
            this.waitForFile(path).then((file) => {
                // join relay room
                this._relay.join(`document-${file.uniqueId}`, projectId);
            });
        });
        const docCloseHandle = this._events.on('asset:doc:close', (path: string) => {
            // check if in project
            const file = this._files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // leave relay room
            this._relay.leave(`document-${file.uniqueId}`);
        });

        return () => {
            this._events.off('asset:update', assetUpdateHandle);

            this._events.off('asset:doc:open', docOpenHandle);
            this._events.off('asset:doc:close', docCloseHandle);
        };
    }

    waitForFile(path: string, type: 'file' | 'folder' = 'file') {
        const file = this._files.get(path);
        if (file && file.type === type) {
            return Promise.resolve(file);
        }
        return new Promise<VirtualFile>((resolve) => {
            const oncreate = (uniqueId: number) => {
                const assetPath = this._assetPath(uniqueId);
                if (assetPath === path) {
                    this._events.off('asset:create', oncreate);
                    const file = this._files.get(path);
                    if (!file || file.type !== type) {
                        return;
                    }
                    resolve(file);
                }
            };
            this._events.on('asset:create', oncreate);
        });
    }

    async create(path: string, type: 'folder' | 'file', content?: Uint8Array) {
        if (!this._projectId || !this._branchId) {
            throw new Error('project not loaded');
        }

        const [parentPath, name] = parsePath(path);

        // validate name
        if (!name) {
            throw new Error(`missing name for ${path}`);
        }

        // validate parent
        let parent: number | undefined = undefined;
        if (parentPath !== '') {
            const file = this._files.get(parentPath);
            if (!file || file.type !== 'folder') {
                throw new Error(`missing parent folder ${parentPath}`);
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
        let asset: {
            type: string;
            name: string;
            parent?: number;
            preload: boolean;
            filename?: string;
            file?: Blob;
        };
        if (type === 'folder') {
            asset = {
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
            asset = {
                type: assetType,
                name,
                parent,
                preload: true,
                filename: `${name}.${ext}`,
                file: new Blob([src], { type: blobType })
            };
        }
        this._rest.assetCreate(this._projectId, this._branchId, asset).then(rest.resolve).catch(rest.reject);

        // wait for asset to be created
        await created;
    }

    async delete(path: string) {
        // check if file exists
        const file = this._files.get(path);
        if (!file) {
            throw new Error(`file not found ${path}`);
        }

        // notify ShareDB to delete asset
        this._sharedb.sendRaw(
            `fs${JSON.stringify({
                op: 'delete',
                ids: [file.uniqueId]
            })}`
        );

        // wait for messenger to notify of asset delete
        const fileUniqueId = file.uniqueId;
        await new Promise<void>((resolve) => {
            const ondelete = (uniqueId: number) => {
                if (uniqueId === fileUniqueId) {
                    this._events.off('asset:delete', ondelete);
                    resolve();
                }
            };
            this._events.on('asset:delete', ondelete);
        });

        this._log(`deleted ${path}`);
    }

    async rename(oldPath: string, newPath: string) {
        if (!this._projectId || !this._branchId) {
            throw new Error('project not loaded');
        }

        // skip if paths are identical
        if (oldPath === newPath) {
            return;
        }

        // check if moving root
        if (oldPath === '') {
            throw new Error('cannot move root folder');
        }

        // check if src file exists
        if (!this._files.has(oldPath)) {
            throw new Error(`file not found ${oldPath}`);
        }

        // check if dest file already exists
        if (this._files.has(newPath)) {
            throw new Error(`file already exists ${newPath}`);
        }

        // parse old file path
        const [oldParent] = parsePath(oldPath);
        const [newParent, newName] = parsePath(newPath);

        // check if we are doing a rename
        if (oldParent === newParent) {
            // find file to rename
            const file = this._files.get(oldPath);
            if (!file) {
                throw new Error(`file not found ${oldPath}`);
            }

            // rename asset
            const renamed = this._rest.assetRename(this._projectId, this._branchId, file.uniqueId, newName);

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

            // wait for rename and file update to complete
            await Promise.all([renamed, updated]);

            this._log(`renamed ${oldPath} to ${newPath}`);
            return;
        }

        // find src file
        const srcFile = this._files.get(oldPath);
        if (!srcFile) {
            throw new Error(`file not found ${oldPath}`);
        }

        // find dest folder
        const destFile = this._files.get(newParent);
        if (!destFile || destFile.type !== 'folder') {
            throw new Error(`destination folder not found ${newParent}`);
        }

        // move asset
        this._sharedb.sendRaw(
            `fs${JSON.stringify({
                op: 'move',
                ids: [srcFile.uniqueId],
                to: destFile.uniqueId
            })}`
        );

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

        // wait for file update to complete
        await updated;

        this._log(`moved ${oldPath} to ${newPath}`);
    }

    writeFile(path: string, content: Uint8Array) {
        // check if file is in memory
        const file = this._files.get(path);
        if (!file || file.type !== 'file') {
            return;
        }

        // check if content needs saving
        if (file.saved) {
            return;
        }
        file.mtime = Date.now();

        // check if document content is different from updated content
        if (!buffer.cmp(buffer.from(file.doc.data), content)) {
            // overwrite entire document content
            // vscode -> shareDB
            file.doc.submitOp([0, { d: file.doc.data.length }], {
                source: ShareDb.SOURCE
            });
            file.doc.submitOp([0, buffer.toString(content)], {
                source: ShareDb.SOURCE
            });
        }

        // notify ShareDB to save the document
        this._sharedb.sendRaw(`doc:save:${file.uniqueId}`);

        // mark as saved
        file.saved = true;

        this._log(`wrote file ${path}`);
    }

    async link({ projectId, branchId }: { projectId: number; branchId: string }) {
        if (this._projectId || this._branchId) {
            throw new Error('project already linked');
        }

        // fetch project asset metadata
        const assets = await this._rest.projectAssets(projectId, branchId, 'codeeditor');

        // validate token scope by checking for uniqueId presence
        if (!Array.isArray(assets) || (assets.length > 0 && !('uniqueId' in assets[0]))) {
            this.error.set(() => new Error('Invalid access token scope.'));
            return;
        }

        // add root folder
        this._files.set('', {
            type: 'folder',
            ctime: Date.now(),
            mtime: Date.now(),
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
                    this.error.set(() => new Error(`Failed to subscribe to asset ${uniqueId}`));
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

        const loadFileNext = await progressNotification('Loading Files', folders.length + files.length);

        // add all folders first
        for (const asset of folders) {
            await this._addFolder(asset.uniqueId);
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
                const asset = batch[j];
                if (!doc) {
                    this.error.set(() => new Error(`Failed to subscribe to document ${asset.uniqueId}`));
                    loadFileNext();
                    continue;
                }

                // add file to file system
                await this._addFile(asset.uniqueId, doc);
                loadFileNext();
            }
        }

        // watchers
        const unwatchEvents = this._watchEvents(projectId);
        const unwatchMessenger = this._watchMessenger(branchId);

        // store state
        this._projectId = projectId;
        this._branchId = branchId;

        // register cleanup
        this._cleanup.push(async () => {
            unwatchEvents();
            unwatchMessenger();

            this._files.clear();
            this._assets.clear();

            this._projectId = undefined;
            this._branchId = undefined;
        });

        this._log(`project ${this._projectId} (branch ${this._branchId}) loaded`);
    }

    async unlink() {
        if (!this._projectId || !this._branchId) {
            throw new Error('project not linked');
        }
        const projectId = this._projectId;
        const branchId = this._branchId;

        await super.unlink();

        this._log(`project ${projectId} (branch ${branchId}) unloaded`);

        return { projectId, branchId };
    }
}

export { ProjectManager };
