import ignore from 'ignore';
import * as vscode from 'vscode';

import { NAME } from './config';
import { ShareDb } from './connections/sharedb';
import { simpleNotification } from './notification';
import type { ProjectManager } from './project-manager';
import type { EventMap } from './typings/event-map';
import type { ShareDbTextOp } from './typings/sharedb';
import * as buffer from './utils/buffer';
import { Debouncer } from './utils/debouncer';
import type { EventEmitter } from './utils/event-emitter';
import { Linker } from './utils/linker';
import { Mutex } from './utils/mutex';
import { signal } from './utils/signal';
import {
    parsePath,
    sharedb2vscode,
    vscode2sharedb,
    opdiff,
    relativePath,
    uriStartsWith,
    fileExists,
    tryCatch,
    hash,
    minimalDiff
} from './utils/utils';

const readDirRecursive = async (uri: vscode.Uri) => {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const result: vscode.Uri[] = [];
    const subdirs: Promise<vscode.Uri[]>[] = [];
    for (const [name, type] of entries) {
        const fullPath = vscode.Uri.joinPath(uri, name);
        result.push(fullPath);
        if (type === vscode.FileType.Directory) {
            subdirs.push(readDirRecursive(fullPath));
        }
    }
    const nested = await Promise.all(subdirs);
    for (const uris of nested) {
        result.push(...uris);
    }
    return result;
};

const fileType = async (uri: vscode.Uri) => {
    const [error, stat] = await tryCatch(vscode.workspace.fs.stat(uri) as Promise<vscode.FileStat>);
    if (error) {
        return undefined;
    }
    return stat.type === vscode.FileType.Directory ? 'folder' : 'file';
};

const fileContent = async (uri: vscode.Uri, type: Promise<'file' | 'folder' | undefined>) => {
    if ((await type) !== 'file') {
        return undefined;
    }
    const [error, content] = await tryCatch(vscode.workspace.fs.readFile(uri) as Promise<Uint8Array>);
    if (error) {
        return undefined;
    }
    return content;
};

// Helper function for path matching (checks if paths are related - ancestor/descendant)
const pathsRelated = (path1: string, path2: string): boolean => {
    if (path1 === path2) {
        return true;
    }
    if (path1.startsWith(`${path2}/`)) {
        return true;
    }
    if (path2.startsWith(`${path1}/`)) {
        return true;
    }
    return false;
};

class Disk extends Linker<{ folderUri: vscode.Uri; projectManager: ProjectManager }> {
    static IGNORE_FILE = '.pcignore';

    private _events: EventEmitter<EventMap>;

    private _linked = false;

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _opened = new Set<string>();

    private _echo: Map<string, string> = new Map<string, string>();

    private _locks = new Set<string>();

    private _syncing = new Set<string>();

    private _readMutex = new Mutex<void>(pathsRelated, (err) => this._log.warn('readMutex error', err));

    private _writeMutex = new Mutex<void>(pathsRelated, (err) => this._log.warn('writeMutex error', err));

    private _debouncer = new Debouncer<void>(50);

    private _ignoring = (_uri: vscode.Uri) => false;

    private _ignoreHash = '';

    error = signal<Error | undefined>(undefined);

    constructor({ events }: { events: EventEmitter<EventMap> }) {
        super();

        this._events = events;
    }

    private _checkIgnoreUpdated(uri: vscode.Uri, deleted = false) {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }
        if (relativePath(uri, folderUri) !== Disk.IGNORE_FILE) {
            return;
        }

        const file = pm.files.get(Disk.IGNORE_FILE);
        const text = deleted ? '' : file?.type === 'file' ? (file.doc.data as string) : '';
        const h = hash(buffer.from(text));
        if (h === this._ignoreHash) {
            return;
        }

        // re-parse immediately so future ops respect new rules
        this._parseIgnoreText(text, folderUri, h);

        // prompt reload for disk sync (safe sequential writes + progress UI via link())
        vscode.window
            .showInformationMessage('Ignore rules updated. Reload to sync files to disk.', 'Reload')
            .then(async (res) => {
                if (res === 'Reload') {
                    await vscode.commands.executeCommand(`${NAME}.reloadProject`);
                }
            });
    }

    private _parseIgnoreText(text: string, folderUri: vscode.Uri, h = hash(buffer.from(text))) {
        this._ignoreHash = h;

        if (!text) {
            this._ignoring = (_uri: vscode.Uri) => false;
            this._log.debug(`cleared ignore rules from empty ignore file`);
            return;
        }

        const ig = ignore().add(text);
        this._ignoring = (uri: vscode.Uri) => {
            const path = relativePath(uri, folderUri);

            // skip root
            if (!path) {
                return false;
            }

            // skip ignore file itself
            if (path === Disk.IGNORE_FILE) {
                return false;
            }

            return ig.ignores(path);
        };
        this._log.debug(`parsed ignore file ${vscode.Uri.joinPath(folderUri, Disk.IGNORE_FILE)}`);
    }

    private _sync(uri: vscode.Uri, content: Uint8Array, remote = false) {
        const key = `${uri}`;
        if (remote) {
            this._syncing.add(key);
        }
        this._debouncer
            .debounce(key, async () => {
                // set echo hash at write time to match actual file content
                this._echo.set(`${uri}:change`, hash(content));
                let attempt = 0;
                while (true) {
                    const [err] = await tryCatch(Promise.resolve(vscode.workspace.fs.writeFile(uri, content)));
                    if (!err) {
                        break;
                    }
                    if (attempt++ >= 2 || !/EBUSY/.test(err.message)) {
                        throw err;
                    }
                    await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
                }
                if (remote) {
                    setTimeout(() => this._syncing.delete(key), 200);
                }
            })
            .catch((err) => {
                // ignore cancellation from debounce supersede/cancel/clear
                if (/debounce/.test(err.message)) {
                    return;
                }
                if (remote) {
                    this._syncing.delete(key);
                }
                this._log.error(`failed to sync ${uri}: ${err.message}`);
            });
    }

    private _create(uri: vscode.Uri, type: 'file' | 'folder', content: Uint8Array) {
        return this._writeMutex.atomic([`${uri}`], async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // check local echo
            const exists = await fileExists(uri);
            if (exists) {
                // for folders, if it exists, we're good
                if (type === 'folder') {
                    return;
                }

                // for files, check content
                const existingContent = await vscode.workspace.fs.readFile(uri);
                if (buffer.cmp(existingContent, content)) {
                    return;
                }
            }

            // ensure parent folder exists on disk
            // handles race condition where child creation event is processed before parent's disk write completes
            if (!exists) {
                const parentUri = vscode.Uri.joinPath(uri, '..');
                if (!(await fileExists(parentUri))) {
                    const folderUri = this._folderUri;
                    if (!folderUri) {
                        throw this.error.set(() => new Error(`parent folder does not exist: ${parentUri.path}`));
                    }
                    // set echo for all missing ancestors to prevent disk watcher from re-processing
                    let ancestor = parentUri;
                    while (ancestor.path !== folderUri.path && !(await fileExists(ancestor))) {
                        this._echo.set(`${ancestor}:create`, '');
                        ancestor = vscode.Uri.joinPath(ancestor, '..');
                    }
                    await vscode.workspace.fs.createDirectory(parentUri);
                }
            }

            // create on disk
            if (!exists) {
                this._echo.set(`${uri}:create`, '');
            }
            switch (type) {
                case 'file': {
                    // clear any pending debounced writes and write immediately
                    this._debouncer.cancel(`${uri}`);
                    this._echo.set(`${uri}:change`, hash(content));
                    await vscode.workspace.fs.writeFile(uri, content);
                    break;
                }
                case 'folder': {
                    await vscode.workspace.fs.createDirectory(uri);
                    break;
                }
            }

            this._log.debug(`${exists ? 'change' : 'create'}.remote ${type} ${uri}`);
        });
    }

    private _update(uri: vscode.Uri, op: ShareDbTextOp, content: Uint8Array) {
        return this._writeMutex.atomic([`${uri}`], async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // update editor if file is open
            const viewing =
                this._opened.has(uri.path) ||
                vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString());
            if (viewing) {
                // lock before any await so onDidChangeTextDocument can't
                // submit ops with stale offsets while doc.data is ahead of buffer
                this._locks.add(`${uri}`);

                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    const workspaceEdit = new vscode.WorkspaceEdit();
                    workspaceEdit.set(uri, sharedb2vscode(document, [op]));
                    const applied = await vscode.workspace.applyEdit(workspaceEdit);

                    // reconcile: applyEdit is async so buffer may drift from doc.data
                    // if user typed during the gap, VS Code merges keystrokes into
                    // the buffer natively — diff doc.data vs buffer to recover them
                    if (this._projectManager && this._folderUri) {
                        const path = relativePath(uri, this._folderUri);
                        const file = this._projectManager.files.get(path);
                        if (file?.type === 'file') {
                            const docData = file.doc.data as string;
                            const currentText = document.getText();
                            if (!applied) {
                                // applyEdit failed — force-reset to server state
                                const reset = new vscode.WorkspaceEdit();
                                const range = new vscode.Range(
                                    document.positionAt(0),
                                    document.positionAt(currentText.length)
                                );
                                reset.replace(uri, range, docData);
                                const resyncApplied = await vscode.workspace.applyEdit(reset);
                                if (!resyncApplied) {
                                    this._log.error(`resync.remote.failed ${uri}`);
                                }
                                this._sync(uri, buffer.from(docData));
                                this._log.warn(`sync.remote.resync ${uri} applied=false`);
                                return;
                            }
                            if (docData !== currentText) {
                                // buffer drifted — user typed during async gap.
                                // diff against doc.data to extract the net user edit
                                const { prefix, suffix } = minimalDiff(docData, currentText);
                                const delLen = docData.length - prefix - suffix;
                                const insText = currentText.substring(prefix, currentText.length - suffix);
                                const recovered: ShareDbTextOp =
                                    delLen > 0 && insText.length > 0
                                        ? [prefix, insText, { d: delLen }]
                                        : delLen > 0
                                          ? [prefix, { d: delLen }]
                                          : [prefix, insText];
                                file.doc.submitOp(recovered, { source: ShareDb.SOURCE });
                                const prev = file.dirty;
                                file.dirty = true;
                                if (!prev) {
                                    this._events.emit('asset:file:dirty', path, true);
                                }
                                this._sync(document.uri, buffer.from(file.doc.data as string));
                                this._log.info(
                                    `sync.remote.recovered ${uri} ${opdiff(op)} recovered=${opdiff(recovered)}`
                                );
                                return;
                            }
                        }
                    }
                } finally {
                    this._locks.delete(`${uri}`);
                }
            }

            // debounce-write to disk (remote flag skips watcher echo)
            this._sync(uri, content, true);

            this._log.debug(`change.remote.${viewing ? 'open' : 'closed'} ${uri} ${opdiff(op)}`);
        });
    }

    private _delete(uri: vscode.Uri) {
        return this._writeMutex.atomic([`${uri}`], async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // check local echo by seeing if file exists
            const exists = await fileExists(uri);
            if (!exists) {
                return;
            }

            // remove from disk
            this._echo.set(`${uri}:delete`, '');
            await vscode.workspace.fs.delete(uri, {
                recursive: true,
                useTrash: false
            });

            this._log.debug(`delete.remote file ${uri}`);
        });
    }

    private _rename(oldUri: vscode.Uri, newUri: vscode.Uri) {
        return this._writeMutex.atomic([`${oldUri}`, `${newUri}`], async () => {
            if (this._ignoring(oldUri)) {
                return;
            }

            // check local echo by seeing if old file exists
            const oldExists = await fileExists(oldUri);
            if (!oldExists) {
                return;
            }

            // rename on disk
            this._echo.set(`${oldUri}:delete`, '');
            this._echo.set(`${newUri}:create`, '');
            await vscode.workspace.fs.rename(oldUri, newUri, {
                overwrite: false
            });

            this._log.debug(`rename.remote ${oldUri.path} -> ${newUri.path}`);
        });
    }

    private _save(uri: vscode.Uri) {
        return this._writeMutex.atomic([`${uri}`], async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // open files: disk already synced by _update() via _sync().
            // no document.save() to avoid triggering formatOnSave.
            if (this._opened.has(uri.path)) {
                const document = await vscode.workspace.openTextDocument(uri);

                // empty documents: flush to disk and revert to clear mtime
                // mismatch. safe — no content to race with.
                if (document.getText().length === 0) {
                    this._debouncer.cancel(`${uri}`);
                    await vscode.workspace.fs.writeFile(uri, new Uint8Array());

                    const active = vscode.window.activeTextEditor;
                    await vscode.window.showTextDocument(document, { preserveFocus: false });
                    await vscode.commands.executeCommand('workbench.action.files.revert');

                    if (active && active.document.uri.toString() !== uri.toString()) {
                        await vscode.window.showTextDocument(active.document, { preserveFocus: false });
                    }

                    this._log.debug(`save.remote.open.empty ${uri}`);
                } else {
                    this._log.debug(`save.remote.open ${uri}`);
                }
            } else {
                this._log.debug(`save.remote.closed ${uri}`);
            }
        });
    }

    private _watchEvents(folderUri: vscode.Uri) {
        const assetFileCreate = this._events.on('asset:file:create', async (path, type, content) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            await this._create(uri, type, content);
        });
        const assetFileUpdate = this._events.on('asset:file:update', async (path, op, content) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            await this._update(uri, op, content);
        });
        const assetFileDelete = this._events.on('asset:file:delete', async (path) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri, true);
            await this._delete(uri);
        });
        const assetFileRename = this._events.on('asset:file:rename', async (oldPath, newPath) => {
            const oldUri = vscode.Uri.joinPath(folderUri, oldPath);
            const newUri = vscode.Uri.joinPath(folderUri, newPath);
            this._checkIgnoreUpdated(oldUri);
            this._checkIgnoreUpdated(newUri);
            await this._rename(oldUri, newUri);
        });
        const assetFileSave = this._events.on('asset:file:save', async (path) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            await this._save(uri);
        });
        return () => {
            this._events.off('asset:file:create', assetFileCreate);
            this._events.off('asset:file:update', assetFileUpdate);
            this._events.off('asset:file:rename', assetFileRename);
            this._events.off('asset:file:delete', assetFileDelete);
            this._events.off('asset:file:save', assetFileSave);
        };
    }

    private _dirtify(doc: vscode.TextDocument) {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return;
        }

        return this._writeMutex.atomic([`${doc.uri}`], async () => {
            const path = relativePath(doc.uri, folderUri);
            const file = pm.files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            if (!file.dirty) {
                return;
            }

            this._locks.add(`${doc.uri}`);
            try {
                const current = doc.getText();
                const expected = file.doc.data as string;

                if (current !== expected) {
                    // buffer has stale content -- apply minimal diff
                    const { prefix, suffix } = minimalDiff(current, expected);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        doc.uri,
                        new vscode.Range(doc.positionAt(prefix), doc.positionAt(current.length - suffix)),
                        expected.substring(prefix, expected.length - suffix)
                    );
                    if (await vscode.workspace.applyEdit(edit)) {
                        this._sync(doc.uri, buffer.from(expected));
                    } else {
                        this._log.warn(`dirtify applyEdit failed for ${doc.uri}`);
                    }
                } else {
                    // content matches -- noop to mark dirty
                    const edit1 = new vscode.WorkspaceEdit();
                    edit1.insert(doc.uri, new vscode.Position(0, 0), ' ');
                    await vscode.workspace.applyEdit(edit1);
                    const edit2 = new vscode.WorkspaceEdit();
                    edit2.delete(doc.uri, new vscode.Range(0, 0, 0, 1));
                    await vscode.workspace.applyEdit(edit2);
                }
            } finally {
                this._locks.delete(`${doc.uri}`);
            }

            this._log.debug(`dirtify ${doc.uri}`);
        });
    }

    private _watchDocument(folderUri: vscode.Uri, projectManager: ProjectManager) {
        for (const open of vscode.workspace.textDocuments) {
            if (!uriStartsWith(open.uri, folderUri)) {
                continue;
            }
            const path = relativePath(open.uri, folderUri);
            this._opened.add(open.uri.path);
            this._events.emit('asset:doc:open', path);
            this._dirtify(open);
        }
        const onopen = vscode.workspace.onDidOpenTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }
            const path = relativePath(document.uri, folderUri);
            this._opened.add(document.uri.path);
            this._events.emit('asset:doc:open', path);
            this._dirtify(document);
        });
        const onclose = vscode.workspace.onDidCloseTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }
            const path = relativePath(document.uri, folderUri);
            this._opened.delete(document.uri.path);
            this._events.emit('asset:doc:close', path);
        });

        const onchange = vscode.workspace.onDidChangeTextDocument((e) => {
            const { document, contentChanges } = e;
            if (contentChanges.length === 0) {
                return;
            }

            // check if in folder
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }

            // check if file is in memory
            const path = relativePath(document.uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // check if locked (from remote update)
            if (this._locks.has(`${document.uri}`)) {
                return;
            }

            // check if content actually changed (avoid echo and discard)
            const text = document.getText();
            if (file.doc.data === text) {
                return;
            }

            // submit ops
            const opOptions = vscode2sharedb(contentChanges);
            for (const [op, options] of opOptions) {
                file.doc.submitOp(op, options);
            }

            // sync to disk (debounced)
            this._sync(document.uri, buffer.from(text));

            // mark as dirty if any ops submitted (any unsaved changes)
            const prev = file.dirty;
            file.dirty ||= !!opOptions.length;
            if (!prev && file.dirty) {
                this._events.emit('asset:file:dirty', path, true);
            }

            // external disk change — force dirty indicator
            if (!document.isDirty && opOptions.length) {
                this._dirtify(document);
            }

            this._log.debug(`document.change ${document.uri.path} ${opOptions.map(([o]) => opdiff(o)).join(' ')}`);
        });
        const onsave = vscode.workspace.onWillSaveTextDocument((e) => {
            const { document } = e;

            // check if file is in memory
            const path = relativePath(document.uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // skip auto-save: only manual saves (Cmd+S) should trigger server
            // save and mtime refresh. auto-save would clear the dirtify marker
            // set on load for files dirty on the server.
            if (e.reason !== vscode.TextDocumentSaveReason.Manual) {
                return;
            }

            // cancel pending debounced write to prevent it firing after native save
            this._debouncer.cancel(`${document.uri}`);

            // detect if _sync already wrote to disk (bumping mtime) before save
            if (this._echo.has(`${document.uri}:change`)) {
                this._log.error(`save.mtime.risk ${path}`);
            }

            // write buffer to disk so mtime is fresh before native save,
            // preventing "file on disk is newer" when initial sync or
            // remote edits wrote to disk after VS Code last tracked mtime
            const content = buffer.from(document.getText());
            this._echo.set(`${document.uri}:change`, hash(content));
            e.waitUntil(vscode.workspace.fs.writeFile(document.uri, content));

            // check if ignore updated (only if file has unsaved changes)
            if (file.dirty) {
                this._checkIgnoreUpdated(document.uri);
            }

            // save file in project manager
            projectManager.save(path);
        });

        return () => {
            onopen.dispose();
            onclose.dispose();

            onchange.dispose();
            onsave.dispose();
        };
    }

    private _watchDisk(folderUri: vscode.Uri, projectManager: ProjectManager) {
        type DeferOp =
            | {
                  action: 'create';
                  uri: vscode.Uri;
                  type: Promise<'file' | 'folder' | undefined>;
                  content: Promise<Uint8Array | undefined>;
              }
            | {
                  action: 'change';
                  uri: vscode.Uri;
                  type: Promise<'file' | undefined>;
                  content: Promise<Uint8Array | undefined>;
                  hash?: string;
              }
            | {
                  action: 'delete';
                  uri: vscode.Uri;
                  type: Promise<'file' | 'folder' | undefined>;
              };
        const queue: DeferOp[] = [];
        let timeout: NodeJS.Timeout | null = null;

        // can batch create+delete into rename
        const potentialRename = (op1: DeferOp, op2: DeferOp) => {
            if (op1.action === 'delete' && op2.action === 'create') {
                return [op2, op1];
            }
            if (op1.action === 'create' && op2.action === 'delete') {
                return [op1, op2];
            }
            return null;
        };

        // defer operation to queue
        const defer = (op: DeferOp) => {
            queue.push(op);

            // if already scheduled, do nothing
            if (timeout) {
                return;
            }

            // schedule processing with delay to allow for rename batching
            timeout = setTimeout(async () => {
                while (queue.length > 0) {
                    // snapshot queue
                    const batch = queue.splice(0);

                    // process batch
                    for (let i = 0; i < batch.length; i++) {
                        if (i + 1 < batch.length) {
                            const rename = potentialRename(batch[i], batch[i + 1]);
                            if (rename) {
                                const [op1, op2] = rename;

                                // batch create/delete of same file into rename
                                const path1 = relativePath(op1.uri, folderUri);
                                const path2 = relativePath(op2.uri, folderUri);
                                const [folder1, name1] = parsePath(path1);
                                const [folder2, name2] = parsePath(path2);
                                if (name1 === name2 || folder1 === folder2) {
                                    this._readMutex.atomic([path1, path2], async () => {
                                        const type1 = await op1.type;
                                        if (!type1) {
                                            this._log.warn(`skipping rename of ${op1.uri} as type not found`);
                                            return;
                                        }
                                        const type2 = await op2.type;
                                        if (!type2) {
                                            this._log.warn(`skipping rename of ${op2.uri} as type not found`);
                                            return;
                                        }

                                        this._log.debug(`rename.local ${op2.uri} -> ${op1.uri}`);
                                        return projectManager.rename(path2, path1);
                                    });
                                    i++;
                                    continue;
                                }
                            }
                        }
                        const op = batch[i];
                        switch (op.action) {
                            case 'create': {
                                const path = relativePath(op.uri, folderUri);
                                this._readMutex.atomic([path], async () => {
                                    const type = await op.type;
                                    const content = await op.content;
                                    if (!type) {
                                        this._log.warn(`skipping create of ${op.uri} as type not found`);
                                        return;
                                    }

                                    // atomic write pattern: external tools write temp+rename,
                                    // producing create events for existing files — treat as change
                                    const existing = projectManager.files.get(path);
                                    if (existing && existing.type === 'file' && type === 'file' && content) {
                                        if (existing.doc.data === buffer.toString(content)) {
                                            return;
                                        }
                                        this._log.debug(`change.local (atomic) ${op.uri}`);
                                        projectManager.write(path, content);
                                        if (this._opened.has(op.uri.path)) {
                                            const doc = vscode.workspace.textDocuments.find(
                                                (d) => d.uri.path === op.uri.path
                                            );
                                            if (doc) {
                                                this._dirtify(doc);
                                            }
                                        }
                                        return;
                                    }

                                    // ensure ancestor folders exist before creating
                                    // handles race condition where child events arrive before parent events
                                    const segments = path.split('/');
                                    for (let j = 1; j < segments.length; j++) {
                                        const ancestorPath = segments.slice(0, j).join('/');
                                        if (!projectManager.files.has(ancestorPath)) {
                                            this._log.debug(
                                                `create.local folder ${ancestorPath} (ensuring ancestor of ${path})`
                                            );
                                            await projectManager.create(ancestorPath, 'folder');
                                        }
                                    }

                                    this._log.debug(`create.local ${type} ${op.uri}`);
                                    return projectManager.create(path, type, content);
                                });
                                break;
                            }
                            case 'change': {
                                const path = relativePath(op.uri, folderUri);
                                this._readMutex.atomic([path], async () => {
                                    const content = await op.content;
                                    if (!content) {
                                        this._log.warn(`skipping change of ${op.uri} as content not found`);
                                        return;
                                    }

                                    // skip if file is in memory and content is the same
                                    const file = projectManager.files.get(path);
                                    if (file && file.type === 'file' && file.doc.data === buffer.toString(content)) {
                                        this._log.trace(`echo.skip.equal ${op.uri}`);
                                        return;
                                    }

                                    // check for echo (hash set from _sync)
                                    if (op.hash !== undefined) {
                                        // skip if newer change detected
                                        if (op.hash !== this._echo.get(`${op.uri}:change`)) {
                                            this._log.trace(`echo.skip.newer ${op.uri}`);
                                            return;
                                        }
                                        // skip if hash is the same
                                        if (op.hash === hash(content)) {
                                            this._log.trace(`echo.skip.match ${op.uri}`);
                                            return;
                                        }
                                        // skip if content is empty
                                        // FIXME: figure out why content can be empty (maybe from readFile not returning anything)
                                        if (content.length === 0) {
                                            this._log.trace(`echo.skip.empty ${op.uri}`);
                                            return;
                                        }
                                    }

                                    this._log.debug(`change.local ${op.uri}`);
                                    projectManager.write(path, content);

                                    // dirtify if file was opened while change was deferred
                                    if (this._opened.has(op.uri.path)) {
                                        const doc = vscode.workspace.textDocuments.find(
                                            (d) => d.uri.path === op.uri.path
                                        );
                                        if (doc) {
                                            this._dirtify(doc);
                                        }
                                    }

                                    return Promise.resolve();
                                });
                                break;
                            }
                            case 'delete': {
                                const path = relativePath(op.uri, folderUri);
                                this._readMutex.atomic([path], async () => {
                                    const type = await op.type;
                                    if (!type) {
                                        this._log.warn(`skipping delete of ${op.uri} as type not found`);
                                        return;
                                    }

                                    this._log.debug(`delete.local ${type} ${op.uri}`);
                                    return projectManager.delete(path, type);
                                });
                                break;
                            }
                        }
                    }

                    // wait for all processing promises to resolve
                    await this._readMutex.all();
                }

                timeout = null;
            }, 10);
        };

        // file system watcher
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folderUri, '**'));
        watcher.onDidCreate((uri) => {
            if (folderUri.scheme !== uri.scheme) {
                return;
            }
            const key = `${uri}:create`;

            // check local echo
            if (this._echo.has(key)) {
                return;
            }

            // ignore check
            if (this._ignoring(uri)) {
                return;
            }

            const type = fileType(uri);
            defer({
                action: 'create',
                uri,
                type,
                content: fileContent(uri, type)
            });
        });
        watcher.onDidChange((uri) => {
            if (folderUri.scheme !== uri.scheme) {
                return;
            }

            // ignore check
            if (this._ignoring(uri)) {
                return;
            }

            // check if document is not open
            // NOTE: document change event handles open files
            if (this._opened.has(uri.path)) {
                return;
            }

            // skip watcher events from remote-originated disk writes
            if (this._syncing.has(`${uri}`)) {
                return;
            }

            // check if file is in memory and of type file
            const path = relativePath(uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            const type = Promise.resolve('file' as const);
            defer({
                action: 'change',
                uri,
                type,
                content: fileContent(uri, type),
                hash: this._echo.get(`${uri}:change`)
            });
        });
        watcher.onDidDelete((uri) => {
            if (folderUri.scheme !== uri.scheme) {
                return;
            }
            const key = `${uri}:delete`;

            // check local echo
            if (this._echo.has(key)) {
                return;
            }

            // ignore check
            if (this._ignoring(uri)) {
                return;
            }

            // check if file is in memory
            const path = relativePath(uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file) {
                this._log.debug(`skipping delete of ${path} (not in memory)`);
                return;
            }

            defer({
                action: 'delete',
                uri,
                type: Promise.resolve(file.type)
            });
        });
        return () => {
            if (timeout) {
                clearTimeout(timeout);
            }
            queue.length = 0;
            watcher.dispose();
        };
    }

    async link({ folderUri, projectManager }: { folderUri: vscode.Uri; projectManager: ProjectManager }) {
        if (this._linked) {
            throw this.error.set(() => new Error('manager already linked'));
        }

        // read files to disk
        const updatingDiskDone = await simpleNotification('Updating Disk');

        // parse ignore file
        const file = projectManager.files.get(Disk.IGNORE_FILE);
        if (file?.type === 'file') {
            this._parseIgnoreText(file.doc.data, folderUri);
        }

        // sort into hierarchy
        // TODO: store as tree instead of flat map and sorting
        const ordered = Array.from(projectManager.files.entries()).sort((a, b) => {
            const foldersA = a[0].split('/');
            const foldersB = b[0].split('/');

            // sort by depth first
            if (foldersA.length !== foldersB.length) {
                return foldersA.length - foldersB.length;
            }

            // compare each folder from root to leaf
            for (let i = 0; i < foldersA.length; i++) {
                const nameA = foldersA[i].toLowerCase();
                const nameB = foldersB[i].toLowerCase();
                if (nameA !== nameB) {
                    return nameA.localeCompare(nameB);
                }
            }
            return 0;
        });

        // add files from project (write ShareDB content to disk)
        for (const [path, file] of ordered) {
            const uri = vscode.Uri.joinPath(folderUri, path);
            const content = file.type === 'file' ? buffer.from(file.doc.data) : new Uint8Array();
            await this._create(uri, file.type, content);
        }

        // remove old files
        const existing = await readDirRecursive(folderUri);
        for (const uri of existing) {
            const path = relativePath(uri, folderUri);
            if (!projectManager.files.has(path)) {
                await this._delete(uri);
            }
        }

        // watchers
        const unwatchEvents = this._watchEvents(folderUri);
        const unwatchDocument = this._watchDocument(folderUri, projectManager);
        const unwatchDisk = this._watchDisk(folderUri, projectManager);

        // store state
        this._folderUri = folderUri;
        this._projectManager = projectManager;

        // register cleanup
        this._cleanup.push(async () => {
            unwatchEvents();
            unwatchDocument();
            unwatchDisk();

            this._echo.clear();
            this._syncing.clear();
            await this._readMutex.clear();
            await this._writeMutex.clear();
            this._debouncer.clear();
            this._opened.clear();
            this._ignoring = (_uri: vscode.Uri) => false;
            this._ignoreHash = '';
        });

        this._linked = true;

        // notify completion
        updatingDiskDone();

        this._log.info(`linked to ${folderUri.toString()}`);
    }

    async unlink() {
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;
        if (!this._linked) {
            this._log.warn('unlink called when not linked');
            if (!folderUri || !projectManager) {
                throw this.error.set(() => new Error('unlink called before link'));
            }
            return { folderUri, projectManager };
        }
        await super.unlink();
        this._linked = false;
        this._log.info(`unlinked from ${folderUri!.toString()}`);
        return { folderUri: folderUri!, projectManager: projectManager! };
    }
}

export { Disk };
