import ignore from 'ignore';
import { type as ottext } from 'ot-text';
import * as vscode from 'vscode';

import { NAME } from './config';
import { simpleNotification } from './notification';
import type { ProjectManager } from './project-manager';
import type { EventMap } from './typings/event-map';
import type { ShareDbTextOp } from './typings/sharedb';
import { UndoManager } from './undo-manager';
import * as buffer from './utils/buffer';
import { Debouncer } from './utils/debouncer';
import type { EventEmitter } from './utils/event-emitter';
import { Linker } from './utils/linker';
import { Mutex } from './utils/mutex';
import { signal } from './utils/signal';
import { delta, diff, norm, stat, sharedb2vscode, vscode2sharedb } from './utils/text';
import { parsePath, relativePath, uriStartsWith, fileExists, tryCatch, hash } from './utils/utils';

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

const FETCH_CONCURRENCY = 16;

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

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _opened = new Set<string>();

    private _echo: Map<string, string> = new Map<string, string>();

    private _locks = new Set<string>();

    private _syncing = new Set<string>();

    private _diskHash = new Map<string, string>();

    private _saving = new Set<string>();

    private _bufferState = new Map<string, string>();

    private _undos = new Map<string, UndoManager>();

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
        const text = deleted ? '' : file?.type === 'file' ? file.doc.text : '';
        const h = hash(text);
        if (h === this._ignoreHash) {
            return;
        }

        // re-parse immediately so future ops respect new rules
        this._parseIgnoreText(text, folderUri, h);

        // prompt reload for disk sync (safe sequential writes + progress UI via link())
        void vscode.window
            .showInformationMessage('Ignore rules updated. Reload to sync files to disk.', 'Reload')
            .then(async (res) => {
                if (res === 'Reload') {
                    await vscode.commands.executeCommand(`${NAME}.reloadProject`);
                }
            });
    }

    private _parseIgnoreText(text: string, folderUri: vscode.Uri, h = hash(text)) {
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

    private _update(uri: vscode.Uri, op: ShareDbTextOp, content: string, prev: string) {
        const snapshot = norm(content);
        return this._writeMutex.atomic([`${uri}`], async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // check if file is open in editor
            const viewing =
                this._opened.has(uri.path) ||
                vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());

            // update on disk if not open in editor (avoid conflicts with unsaved buffer content)
            if (!viewing) {
                const key = `${uri}`;
                this._syncing.add(key);

                // debounce rapid changes to avoid overwhelming disk with writes
                const content = buffer.from(snapshot);
                void this._debouncer
                    .debounce(key, async () => {
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
                        setTimeout(() => this._syncing.delete(key), 200);
                    })
                    .catch((err) => {
                        if (/debounce/.test(err.message)) {
                            return;
                        }
                        this._syncing.delete(key);
                        this._log.error(`failed to sync ${uri}: ${err.message}`);
                    });

                this._log.debug(`change.remote.closed ${uri} ${stat(op)}`);
                return;
            }

            // transform undo/redo stacks against the remote op (OT-space)
            const mgr = this._undos.get(uri.path);
            if (mgr) {
                mgr.xform(op);
            }

            // update editor if file is open
            this._locks.add(`${uri}`);
            await tryCatch(async () => {
                const document = await vscode.workspace.openTextDocument(uri);
                const raw = document.getText();
                const bufferText = norm(raw);

                // all differences from canonical-before-op to buffer (for transforms)
                const fullUserOp = delta(prev, bufferText);

                // only new keystrokes since last _update (avoids re-submitting already-handled ones)
                const baseline = this._bufferState.get(uri.path);
                const newUserOp = baseline !== undefined ? delta(baseline, bufferText) : fullUserOp;

                // transform remote op into buffer-space so positions align
                const bufferOp = fullUserOp ? (ottext.transform(op, fullUserOp, 'right') as ShareDbTextOp) : op;
                const edit = sharedb2vscode(document, uri, [bufferOp], bufferText);
                const applied = await vscode.workspace.applyEdit(edit);

                if (this._projectManager && this._folderUri) {
                    const path = relativePath(uri, this._folderUri);
                    const file = this._projectManager.files.get(path);
                    if (file?.type === 'file') {
                        // submit only new user keystrokes to OT (transformed against remote op)
                        // guard: skip if fullUserOp is null — canonical already includes them
                        if (fullUserOp && newUserOp) {
                            const transformed = ottext.transform(newUserOp, op, 'left') as ShareDbTextOp;
                            file.doc.apply(transformed);
                            const wasDirty = file.dirty;
                            file.dirty = true;
                            if (!wasDirty) {
                                this._events.emit('asset:file:dirty', path, true);
                            }
                        }

                        // applyEdit failed — force-reset to canonical state
                        if (!applied) {
                            const curRaw = document.getText();
                            const reset = new vscode.WorkspaceEdit();
                            const range = new vscode.Range(document.positionAt(0), document.positionAt(curRaw.length));
                            reset.replace(uri, range, file.doc.text);
                            await vscode.workspace.applyEdit(reset);
                            this._bufferState.set(uri.path, norm(file.doc.text));
                            this._log.warn(`sync.remote.resync ${uri} applied=false`);
                            return;
                        }

                        // reconcile: recover keystrokes typed during applyEdit await
                        // compute expected locally — NOT file.doc.text which may include queued remote ops
                        const postRaw = document.getText();
                        const postText = norm(postRaw);
                        const expected = ottext.apply(bufferText, bufferOp) as string;
                        this._bufferState.set(uri.path, postText);

                        const late = delta(expected, postText);
                        if (late) {
                            // transform recovered keystrokes against canonical advancement
                            // (queued remote ops that OTDocument processed but _update hasn't applied yet)
                            const adv = delta(expected, file.doc.text);
                            const adjusted = adv ? (ottext.transform(late, adv, 'left') as ShareDbTextOp) : late;
                            file.doc.apply(adjusted);
                            const wasDirty = file.dirty;
                            file.dirty = true;
                            if (!wasDirty) {
                                this._events.emit('asset:file:dirty', path, true);
                            }
                            this._log.info(`sync.remote.recovered ${uri} ${stat(op)} recovered=${stat(late)}`);
                            return;
                        }
                    }
                }
            });
            this._locks.delete(`${uri}`);

            this._log.debug(`change.remote.open ${uri} ${stat(op)}`);
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

            // open files: disk writes only via VS Code's native save.
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
            await tryCatch(async () => {
                const current = doc.getText();
                const expected = file.doc.text;
                if (current !== expected) {
                    // buffer has stale content -- apply minimal diff
                    const { prefix, suffix } = diff(current, expected);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        doc.uri,
                        new vscode.Range(doc.positionAt(prefix), doc.positionAt(current.length - suffix)),
                        expected.substring(prefix, expected.length - suffix)
                    );
                    if (!(await vscode.workspace.applyEdit(edit))) {
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
            });
            this._locks.delete(`${doc.uri}`);

            this._log.debug(`dirtify ${doc.uri}`);
        });
    }

    private _watchEvents(folderUri: vscode.Uri) {
        const assetFileCreate = this._events.on('asset:file:create', async (path, type, content) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            await this._create(uri, type, content);
        });
        const assetFileUpdate = this._events.on('asset:file:update', async (path, op, content, prev) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            await this._update(uri, op, content, prev);
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
        const assetFileSubscribed = this._events.on('asset:file:subscribed', async (path, content, dirty) => {
            const uri = vscode.Uri.joinPath(folderUri, path);

            if (this._opened.has(uri.path)) {
                // reconcile: submit buffer divergence to OT (preserves user edits made before subscribe)
                await this._writeMutex.atomic([`${uri}`], async () => {
                    this._locks.add(`${uri}`);
                    await tryCatch(async () => {
                        const pm = this._projectManager;
                        if (!pm) {
                            return;
                        }
                        const file = pm.files.get(path);
                        if (!file || file.type !== 'file') {
                            return;
                        }

                        const doc = await vscode.workspace.openTextDocument(uri);
                        const bufferText = norm(doc.getText());

                        const userOp = delta(file.doc.text, bufferText);
                        if (userOp) {
                            file.doc.apply(userOp);
                            file.dirty = true;
                            this._events.emit('asset:file:dirty', path, true);
                            this._log.info(`subscribe.recovered ${uri}`);
                        }

                        this._bufferState.set(uri.path, norm(doc.getText()));
                    });
                    this._locks.delete(`${uri}`);
                });
            } else {
                // sync to disk for closed files
                const buf = buffer.from(norm(content));
                const key = `${uri}`;
                this._syncing.add(key);
                void this._debouncer
                    .debounce(key, async () => {
                        this._echo.set(`${uri}:change`, hash(buf));
                        await vscode.workspace.fs.writeFile(uri, buf);
                        setTimeout(() => this._syncing.delete(key), 200);
                    })
                    .catch((err) => {
                        if (/debounce/.test(err.message)) {
                            return;
                        }
                        this._syncing.delete(key);
                        this._log.error(`failed to sync subscribed ${uri}: ${err.message}`);
                    });
            }

            if (dirty) {
                this._events.emit('asset:file:dirty', path, true);
            }
        });
        return () => {
            this._events.off('asset:file:create', assetFileCreate);
            this._events.off('asset:file:update', assetFileUpdate);
            this._events.off('asset:file:rename', assetFileRename);
            this._events.off('asset:file:delete', assetFileDelete);
            this._events.off('asset:file:save', assetFileSave);
            this._events.off('asset:file:subscribed', assetFileSubscribed);
        };
    }

    private _watchUndoRedo(folderUri: vscode.Uri, projectManager: ProjectManager) {
        // track active editor to gate keybindings
        const updateCtx = (e?: vscode.TextEditor) => {
            const collab = e && uriStartsWith(e.document.uri, folderUri);
            vscode.commands.executeCommand('setContext', 'playcanvas.isCollabFile', !!collab);
        };
        updateCtx(vscode.window.activeTextEditor);
        const onEditor = vscode.window.onDidChangeActiveTextEditor(updateCtx);

        // shared apply logic for undo/redo — op pop + apply are atomic inside mutex
        const applyOp = async (
            op: ShareDbTextOp,
            uri: vscode.Uri,
            path: string,
            file: { doc: { text: string; apply: (op: ShareDbTextOp) => void }; dirty: boolean }
        ) => {
            this._locks.add(`${uri}`);
            await tryCatch(async () => {
                // capture pre-apply canonical text for correct buffer-space delta
                const pre = file.doc.text;

                // apply to OT canonical state (submits to ShareDB)
                file.doc.apply(op);

                // apply visual edit to buffer
                const doc = await vscode.workspace.openTextDocument(uri);
                const raw = doc.getText();
                const buf = norm(raw);
                // delta from pre-apply canonical to buffer gives true user divergence
                const userOp = delta(pre, buf);
                const bufOp = userOp ? (ottext.transform(op, userOp, 'right') as ShareDbTextOp) : op;
                const edit = sharedb2vscode(doc, uri, [bufOp], buf);
                await vscode.workspace.applyEdit(edit);

                // reconcile: recover keystrokes typed during applyEdit await
                const postText = norm(doc.getText());
                const expected = ottext.apply(buf, bufOp) as string;
                this._bufferState.set(uri.path, postText);

                const late = delta(expected, postText);
                if (late) {
                    const adv = delta(expected, file.doc.text);
                    const adjusted = adv ? (ottext.transform(late, adv, 'left') as ShareDbTextOp) : late;
                    file.doc.apply(adjusted);
                }

                // cursor: position after the buffer-space op's primary edit
                const active = vscode.window.activeTextEditor;
                if (active && active.document.uri.toString() === uri.toString()) {
                    let cursor = 0;
                    if (bufOp.length === 1) {
                        if (typeof bufOp[0] === 'string') {
                            cursor = bufOp[0].length;
                        }
                    } else if (bufOp.length > 1 && typeof bufOp[0] === 'number') {
                        cursor = bufOp[0];
                        if (typeof bufOp[1] === 'string') {
                            cursor += bufOp[1].length;
                        }
                    }
                    const pos = doc.positionAt(cursor);
                    active.selection = new vscode.Selection(pos, pos);
                }

                // mark dirty
                const wasDirty = file.dirty;
                file.dirty = true;
                if (!wasDirty) {
                    this._events.emit('asset:file:dirty', path, true);
                }
            });
            this._locks.delete(`${uri}`);
        };

        const undoCmd = vscode.commands.registerCommand(`${NAME}.undo`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const uri = editor.document.uri;
            const path = relativePath(uri, folderUri);
            const mgr = this._undos.get(uri.path);
            const file = projectManager.files.get(path);
            if (!mgr?.canUndo || !file || file.type !== 'file') {
                return;
            }

            // pop + apply inside mutex to prevent race with concurrent _update
            await this._writeMutex.atomic([`${uri}`], async () => {
                const op = mgr.undo(file.doc.text);
                if (!op) {
                    return;
                }
                await applyOp(op, uri, path, file);
            });
        });

        const redoCmd = vscode.commands.registerCommand(`${NAME}.redo`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const uri = editor.document.uri;
            const path = relativePath(uri, folderUri);
            const mgr = this._undos.get(uri.path);
            const file = projectManager.files.get(path);
            if (!mgr?.canRedo || !file || file.type !== 'file') {
                return;
            }

            // pop + apply inside mutex to prevent race with concurrent _update
            await this._writeMutex.atomic([`${uri}`], async () => {
                const op = mgr.redo(file.doc.text);
                if (!op) {
                    return;
                }
                await applyOp(op, uri, path, file);
            });
        });

        return () => {
            onEditor.dispose();
            undoCmd.dispose();
            redoCmd.dispose();
            vscode.commands.executeCommand('setContext', 'playcanvas.isCollabFile', false);
        };
    }

    private _watchDocument(folderUri: vscode.Uri, projectManager: ProjectManager) {
        for (const open of vscode.workspace.textDocuments) {
            if (!uriStartsWith(open.uri, folderUri)) {
                continue;
            }
            const path = relativePath(open.uri, folderUri);
            this._opened.add(open.uri.path);
            this._undos.set(open.uri.path, new UndoManager());
            this._events.emit('asset:doc:open', path);
            this._dirtify(open);
        }
        const onopen = vscode.workspace.onDidOpenTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }
            const path = relativePath(document.uri, folderUri);
            this._opened.add(document.uri.path);
            this._undos.set(document.uri.path, new UndoManager());
            this._diskHash.set(document.uri.path, hash(norm(document.getText())));
            this._events.emit('asset:doc:open', path);
            this._dirtify(document);
        });
        const onclose = vscode.workspace.onDidCloseTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }
            const path = relativePath(document.uri, folderUri);
            this._opened.delete(document.uri.path);
            this._undos.get(document.uri.path)?.clear();
            this._undos.delete(document.uri.path);
            this._diskHash.delete(document.uri.path);
            this._saving.delete(document.uri.path);
            this._bufferState.delete(document.uri.path);
            this._events.emit('asset:doc:close', path);
        });

        const onchange = vscode.workspace.onDidChangeTextDocument((e) => {
            const { document, contentChanges, reason } = e;
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
            // normalize to LF — canonical OT state is always LF
            const text = norm(document.getText());
            if (file.doc.text === text) {
                return;
            }

            // skip discard/revert: buffer reverted to stale disk content,
            // not a real edit. undo/redo are real edits that must reconcile OT state.
            if (!reason && !document.isDirty && hash(text) === this._diskHash.get(document.uri.path)) {
                return;
            }

            // submit ops via OTDocument (applies locally + submits to ShareDB)
            const ops = vscode2sharedb(document, contentChanges, file.doc.text);
            const mgr = this._undos.get(document.uri.path);
            for (const op of ops) {
                // push inverse to undo stack for local edits
                // (undo/redo apply under _locks, so they never reach here)
                if (mgr) {
                    const snap = file.doc.text;
                    const inv = ottext.semanticInvert(snap, op) as ShareDbTextOp;
                    // detect whitespace/newline from inserted text in the forward op
                    let ins = '';
                    for (const c of op) {
                        if (typeof c === 'string') {
                            ins += c;
                        }
                    }
                    const hasDel = op.some((c) => typeof c === 'object');
                    const ws = !hasDel && /^ +$/.test(ins);
                    const nl = !hasDel && /^\n+$/.test(ins);
                    // line number from op offset
                    const off = typeof op[0] === 'number' ? op[0] : 0;
                    let line = 0;
                    for (let i = 0; i < off && i < snap.length; i++) {
                        if (snap[i] === '\n') {
                            line++;
                        }
                    }
                    mgr.push(inv, ws, nl, line);
                }
                file.doc.apply(op);
            }

            // mark as dirty if any ops submitted (any unsaved changes)
            const prev = file.dirty;
            file.dirty ||= !!ops.length;
            if (!prev && file.dirty) {
                this._events.emit('asset:file:dirty', path, true);
            }

            // external disk change — force dirty indicator
            if (!document.isDirty && ops.length) {
                this._dirtify(document);
            }

            this._log.debug(`document.change ${document.uri.path} ${ops.map((o) => stat(o)).join(' ')}`);
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
                this._saving.delete(document.uri.path);
                return;
            }

            // update disk hash so discard detection stays in sync after save
            // defer projectManager.save() to onDidSaveTextDocument so VS Code's
            // native save completes before the remote save is triggered.
            const h = hash(norm(document.getText()));
            this._diskHash.set(document.uri.path, h);
            this._saving.add(document.uri.path);

            // check if ignore updated (only if file has unsaved changes)
            if (file.dirty) {
                this._checkIgnoreUpdated(document.uri);
            }
        });
        const ondidsave = vscode.workspace.onDidSaveTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }

            if (!this._saving.has(document.uri.path)) {
                return;
            }
            this._saving.delete(document.uri.path);

            const path = relativePath(document.uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            projectManager.save(path);
        });

        return () => {
            onopen.dispose();
            onclose.dispose();

            onchange.dispose();
            onsave.dispose();
            ondidsave.dispose();
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
                                    if (
                                        existing &&
                                        (existing.type === 'file' || existing.type === 'stub') &&
                                        type === 'file' &&
                                        content
                                    ) {
                                        if (
                                            existing.type === 'file' &&
                                            existing.doc.text === norm(buffer.toString(content))
                                        ) {
                                            return;
                                        }
                                        this._log.debug(`change.local (atomic) ${op.uri}`);
                                        await projectManager.write(path, content);
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
                                    if (
                                        file &&
                                        file.type === 'file' &&
                                        file.doc.text === norm(buffer.toString(content))
                                    ) {
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
                                    await projectManager.write(path, content);

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
                this._echo.delete(key);
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

            // check if file is in memory (stubs allowed — triggers subscribe on write)
            const path = relativePath(uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file || file.type === 'folder') {
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
                this._echo.delete(key);
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
                type: Promise.resolve(file.type === 'stub' ? 'file' : file.type)
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
        if (this._folderUri !== undefined) {
            throw this.error.set(() => new Error('manager already linked'));
        }

        // drain stale cleanup from a previously failed link
        await super.unlink();

        // read files to disk
        const updatingDiskDone = await simpleNotification('Updating Disk');

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

        // prefetch REST content for stubs (concurrent with limit)
        const stubs = ordered.filter(([, f]) => f.type === 'stub');
        const fetched = new Map<number, Uint8Array>();
        for (let i = 0; i < stubs.length; i += FETCH_CONCURRENCY) {
            const batch = stubs.slice(i, i + FETCH_CONCURRENCY);
            const results = await Promise.all(
                batch.map(async ([, f]) => {
                    const [err, buf] = await tryCatch(projectManager.fetchContent(f.uniqueId));
                    return [f.uniqueId, err ? new Uint8Array() : buf] as const;
                })
            );
            for (const [id, buf] of results) {
                fetched.set(id, buf);
            }
        }

        // write files to disk
        for (const [path, file] of ordered) {
            const uri = vscode.Uri.joinPath(folderUri, path);
            let content: Uint8Array;
            if (file.type === 'file') {
                content = buffer.from(file.doc.text);
            } else if (file.type === 'stub') {
                content = fetched.get(file.uniqueId) ?? new Uint8Array();
            } else {
                content = new Uint8Array();
            }
            await this._create(uri, file.type === 'folder' ? 'folder' : 'file', content);
        }

        // parse ignore file (after disk write so stub content is available)
        const ignoreFile = projectManager.files.get(Disk.IGNORE_FILE);
        if (ignoreFile?.type === 'file') {
            this._parseIgnoreText(ignoreFile.doc.text, folderUri);
        } else if (ignoreFile?.type === 'stub') {
            const ignoreUri = vscode.Uri.joinPath(folderUri, Disk.IGNORE_FILE);
            const [, raw] = await tryCatch(vscode.workspace.fs.readFile(ignoreUri) as Promise<Uint8Array>);
            if (raw) {
                this._parseIgnoreText(buffer.toString(raw), folderUri);
            }
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
        const unwatchUndoRedo = this._watchUndoRedo(folderUri, projectManager);

        // register cleanup
        this._cleanup.push(async () => {
            unwatchEvents();
            unwatchDocument();
            unwatchDisk();
            unwatchUndoRedo();

            this._echo.clear();
            this._syncing.clear();
            this._saving.clear();
            this._undos.forEach((m) => m.clear());
            this._undos.clear();
            await this._readMutex.clear();
            await this._writeMutex.clear();
            this._debouncer.clear();
            this._opened.clear();
            this._ignoring = (_uri: vscode.Uri) => false;
            this._ignoreHash = '';
        });

        this._folderUri = folderUri;
        this._projectManager = projectManager;

        // notify completion
        updatingDiskDone();

        this._log.info(`linked to ${folderUri.toString()}`);
    }

    async unlink() {
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;
        if (!folderUri || !projectManager) {
            throw this.error.set(() => new Error('unlink called before link'));
        }
        await super.unlink();
        this._folderUri = undefined;
        this._projectManager = undefined;
        this._bufferState.clear();
        this._undos.forEach((m) => m.clear());
        this._undos.clear();
        vscode.commands.executeCommand('setContext', 'playcanvas.isCollabFile', false);
        this._log.info(`unlinked from ${folderUri.toString()}`);
        return { folderUri, projectManager };
    }
}

export { Disk };
