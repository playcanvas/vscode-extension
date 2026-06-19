import ignore from 'ignore';
import { type as ottext } from 'ot-text';
import * as vscode from 'vscode';

import { NAME } from './config';
import { progressNotification } from './notification';
import type { ProjectManager } from './project-manager';
import type { TypeFiles } from './type-installer';
import type { EventMap } from './typings/event-map';
import type { ShareDbTextOp } from './typings/sharedb';
import { UndoManager } from './undo-manager';
import * as buffer from './utils/buffer';
import { Debouncer } from './utils/debouncer';
import { fail } from './utils/error';
import type { EventEmitter } from './utils/event-emitter';
import { Linker } from './utils/linker';
import { Mutex } from './utils/mutex';
import { signal } from './utils/signal';
import { delta, diff, norm, stat, sharedb2vscode, vscode2sharedb } from './utils/text';
import { pool, parsePath, relativePath, uriStartsWith, fileExists, tryCatch, hash } from './utils/utils';

const FETCH_CONCURRENCY = 8;
const WRITE_CONCURRENCY = 16;
const SYNC_DELAY = 200;

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

class Disk extends Linker<{ folderUri: vscode.Uri; projectManager: ProjectManager; types: TypeFiles }> {
    static IGNORE_FILE = '.pcignore';

    static TYPE_DIR = '.pc';

    // injected into the ignore ruleset so editor/vcs metadata dirs are never synced.
    // .vscode holds workspace settings we write ourselves (files.autoSave, files.eol);
    // .cursor is Cursor's equivalent editor-local config dir.
    static VCS_IGNORE = '.git\n.hg\n.svn\n.vscode\n.cursor\n';

    private _events: EventEmitter<EventMap>;

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _echo: Map<string, string> = new Map<string, string>();

    private _locks = new Set<string>();

    // per-uri counter held while a remote op is being processed. incremented
    // synchronously in the 'asset:file:update' listener so the keystroke
    // handler bails before OTDocument._text (already advanced to post-op) and
    // the vscode buffer (still pre-op until _update's applyEdit runs) can
    // diverge. _locks alone isn't enough — it's only added inside _update's
    // async mutex callback, so contentChange offsets misalign in the
    // sync-to-microtask gap.
    private _opLocks = new Map<string, number>();

    private _syncing = new Set<string>();

    private _diskHash = new Map<string, string>();

    private _diskStat = new Map<string, { mtime: number; size: number }>();

    private _saving = new Set<string>();

    private _blocked = new Set<string>();

    private _undos = new Map<string, UndoManager>();

    private _readMutex = new Mutex<void>(pathsRelated, (err) => this._log.warn('readMutex error', err));

    private _writeMutex = new Mutex<void>(pathsRelated, (err) => this._log.warn('writeMutex error', err));

    private _debouncer = new Debouncer<void>(50);

    private _ignoring = (_uri: vscode.Uri) => false;

    private _ignoreHash = '';

    error = signal<Error | undefined>(undefined);

    private _types?: TypeFiles;

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

        // prepend vcs rules so .git/.hg/.svn are always excluded (prevents binary round-trip corruption)
        const ig = ignore().add(`${Disk.VCS_IGNORE}${text}`);
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
        if (text) {
            this._log.debug(`parsed ignore file ${vscode.Uri.joinPath(folderUri, Disk.IGNORE_FILE)}`);
        }
    }

    private async _sameFile(uri: vscode.Uri, content: Uint8Array) {
        const [err, current] = await tryCatch(vscode.workspace.fs.readFile(uri) as Promise<Uint8Array>);
        if (err) {
            return false;
        }
        return hash(current) === hash(content);
    }

    private async _writeTypeFiles(folderUri: vscode.Uri, types = this._types) {
        if (!types) {
            this._log.warn('failed to write playcanvas types: no type files loaded');
            return;
        }

        const dirUri = vscode.Uri.joinPath(folderUri, Disk.TYPE_DIR);
        this._echo.set(`${dirUri}:create`, '');
        await vscode.workspace.fs.createDirectory(dirUri);

        // global pc namespace types
        const globalsUri = vscode.Uri.joinPath(dirUri, 'globals.d.ts');
        const globalsChanged = !(await this._sameFile(globalsUri, types.globals));
        if (globalsChanged) {
            this._echo.set(`${globalsUri}:create`, '');
            this._echo.set(`${globalsUri}:change`, hash(types.globals));
            await vscode.workspace.fs.writeFile(globalsUri, types.globals);
        }

        // 'playcanvas' module declaration (must be separate — script file referencing global pc)
        const moduleUri = vscode.Uri.joinPath(dirUri, 'module.d.ts');
        const moduleChanged = !(await this._sameFile(moduleUri, types.module));
        if (moduleChanged) {
            this._echo.set(`${moduleUri}:create`, '');
            this._echo.set(`${moduleUri}:change`, hash(types.module));
            await vscode.workspace.fs.writeFile(moduleUri, types.module);
        }

        if (globalsChanged || moduleChanged) {
            void tryCatch(vscode.commands.executeCommand('typescript.restartTsServer') as Promise<unknown>);
        }

        this._log.debug(`wrote type files to .pc/ (${types.version}${types.fallback ? ', fallback' : ''})`);
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

                if (this._isOpen(uri)) {
                    this._log.debug(`create.remote.open ${uri}`);
                    return;
                }

                // for files, check content — compare normalized text so CRLF on disk
                // doesn't read as "diverged" against LF-canonical server content
                const existingContent = await vscode.workspace.fs.readFile(uri);
                const existingText = norm(buffer.toString(existingContent));
                const contentText = norm(buffer.toString(content));
                if (existingText === contentText) {
                    this._diskHash.set(uri.path, hash(contentText));
                    return;
                }

                // server is authoritative — fall through to overwrite divergent disk
            }

            if (!exists) {
                // ensure parent folder exists — handles race where a child create event
                // is processed before the parent's disk write completes
                const parentUri = vscode.Uri.joinPath(uri, '..');
                if (!(await fileExists(parentUri))) {
                    const folderUri = this._folderUri;
                    if (!folderUri) {
                        throw this.error.set(() => fail`parent folder does not exist: ${parentUri.path}`);
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
                    const h = hash(content);
                    this._echo.set(`${uri}:change`, h);
                    await vscode.workspace.fs.writeFile(uri, content);
                    this._diskHash.set(uri.path, h);
                    const [, st] = await tryCatch(Promise.resolve(vscode.workspace.fs.stat(uri)));
                    if (st) {
                        this._diskStat.set(uri.path, { mtime: st.mtime, size: st.size });
                    }
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

    // open check — textDocuments is the source of truth. keeps the watcher from
    // pushing open files upstream, racing the editor path and duplicating content
    private _isOpen(uri: vscode.Uri) {
        return vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
    }

    private _update(uri: vscode.Uri, op: ShareDbTextOp, content: string, prev: string) {
        const snapshot = norm(content);
        return this._writeMutex.atomic([`${uri}`], async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // check if file is open in editor
            const viewing = this._isOpen(uri);

            // update on disk if not open in editor (avoid conflicts with unsaved buffer content)
            if (!viewing) {
                const key = `${uri}`;
                this._syncing.add(key);

                // debounce rapid changes to avoid overwhelming disk with writes
                const next = buffer.from(snapshot);
                void this._debouncer
                    .debounce(key, async () => {
                        const h = hash(next);
                        this._echo.set(`${uri}:change`, h);
                        let attempt = 0;
                        while (true) {
                            const [err] = await tryCatch(Promise.resolve(vscode.workspace.fs.writeFile(uri, next)));
                            if (!err) {
                                break;
                            }
                            if (attempt++ >= 2 || !/EBUSY/.test(err.message)) {
                                throw err;
                            }
                            await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
                        }
                        this._diskHash.set(uri.path, h);
                        const [, st] = await tryCatch(Promise.resolve(vscode.workspace.fs.stat(uri)));
                        if (st) {
                            this._diskStat.set(uri.path, { mtime: st.mtime, size: st.size });
                        }
                        setTimeout(() => this._syncing.delete(key), SYNC_DELAY);
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
                mgr.transform(op);
            }

            // update editor if file is open
            this._locks.add(`${uri}`);
            await tryCatch(async () => {
                const document = await vscode.workspace.openTextDocument(uri);
                const raw = document.getText();
                const bufferText = norm(raw);

                // bailed keystrokes (typed during _locks) — prev already includes every
                // keystroke the handler processed via apply(), so this delta is exactly
                // the lock-window edits that still need to reach the server. computing it
                // off any older baseline would resubmit already-acked ops and the server
                // would land them at offsets shifted by op — silent positional divergence.
                const fullUserOp = delta(prev, bufferText);

                // transform remote op into buffer-space so positions align
                const bufferOp = fullUserOp ? (ottext.transform(op, fullUserOp, 'right') as ShareDbTextOp) : op;
                const edit = sharedb2vscode(document, uri, [bufferOp], bufferText);
                const applied = await vscode.workspace.applyEdit(edit);

                if (this._projectManager && this._folderUri) {
                    const path = relativePath(uri, this._folderUri);
                    const file = this._projectManager.files.get(path);
                    if (file?.type === 'file') {
                        // submit bailed keystrokes only, transformed against the remote op
                        if (fullUserOp) {
                            const transformed = ottext.transform(fullUserOp, op, 'left') as ShareDbTextOp;
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
                            this._log.warn(`sync.remote.resync ${uri} applied=false`);
                            return;
                        }

                        // reconcile: recover keystrokes typed during applyEdit await
                        // compute expected locally — NOT file.doc.text which may include queued remote ops
                        const postRaw = document.getText();
                        const postText = norm(postRaw);
                        const expected = ottext.apply(bufferText, bufferOp) as string;

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

            // remove from disk. callers iterate bottom-up so folders are
            // always empty here — no recursion, no cascading OS events
            this._echo.set(`${uri}:delete`, '');
            await vscode.workspace.fs.delete(uri, {
                recursive: false,
                useTrash: false
            });

            this._diskHash.delete(uri.path);
            this._diskStat.delete(uri.path);

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

            // next _update or _create write on newUri.path will repopulate
            this._diskHash.delete(oldUri.path);
            this._diskStat.delete(oldUri.path);

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
            if (this._isOpen(uri)) {
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

    private async _subscribed(uri: vscode.Uri, path: string, content: string, dirty: boolean) {
        // undo inverses reference pre-reload OT history — clear so undo can't resurrect missing content
        this._undos.get(uri.path)?.clear();

        if (this._isOpen(uri)) {
            // reconcile buffer with live ShareDB doc after subscribe
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

                    // server is authoritative — apply live ShareDB doc to buffer on any divergence
                    if (file.doc.text !== bufferText) {
                        const { prefix, suffix } = diff(bufferText, file.doc.text);
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(
                            uri,
                            new vscode.Range(doc.positionAt(prefix), doc.positionAt(bufferText.length - suffix)),
                            file.doc.text.substring(prefix, file.doc.text.length - suffix)
                        );
                        const applied = await vscode.workspace.applyEdit(edit);
                        if (!applied) {
                            this._log.warn(`subscribe.resync applyEdit failed for ${uri}`);
                        }
                        this._log.info(`subscribe.resync ${uri}`);
                    }
                });
                this._locks.delete(`${uri}`);
            });
        } else {
            // sync server snapshot to disk for closed files — server is authoritative
            const buf = buffer.from(norm(content));
            const key = `${uri}`;

            // skip if disk already matches server
            if (await fileExists(uri)) {
                const existing = await vscode.workspace.fs.readFile(uri);
                const existingText = norm(buffer.toString(existing));
                const bufText = norm(buffer.toString(buf));
                if (existingText === bufText) {
                    this._diskHash.set(uri.path, hash(bufText));
                    if (dirty) {
                        this._events.emit('asset:file:dirty', path, true);
                    }
                    return;
                }
            }

            this._syncing.add(key);
            void this._debouncer
                .debounce(key, async () => {
                    const h = hash(buf);
                    this._echo.set(`${uri}:change`, h);
                    await vscode.workspace.fs.writeFile(uri, buf);
                    this._diskHash.set(uri.path, h);
                    setTimeout(() => this._syncing.delete(key), SYNC_DELAY);
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
    }

    private async _reconcile(uri: vscode.Uri, path: string, type: 'file' | 'folder') {
        if (type !== 'file' || !this._isOpen(uri)) {
            return;
        }

        const file = this._projectManager?.files.get(path);
        if (!file || file.type !== 'file') {
            return;
        }

        await this._subscribed(uri, path, file.doc.text, file.dirty);
    }

    private _dirty(doc: vscode.TextDocument) {
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
                        this._log.warn(`dirty applyEdit failed for ${doc.uri}`);
                    }
                } else {
                    // content matches -- make a reversible edit to mark dirty without final text change
                    const pos = doc.positionAt(0);
                    const add = new vscode.WorkspaceEdit();
                    add.insert(doc.uri, pos, ' ');
                    if (await vscode.workspace.applyEdit(add)) {
                        const remove = new vscode.WorkspaceEdit();
                        remove.delete(doc.uri, new vscode.Range(pos, doc.positionAt(1)));
                        await vscode.workspace.applyEdit(remove);
                    }
                }
            });
            this._locks.delete(`${doc.uri}`);

            this._log.debug(`dirty ${doc.uri}`);
        });
    }

    private async _dirtyReload(document: vscode.TextDocument, text: string) {
        // only refresh _diskHash if buffer actually matches disk. external=true
        // is also a false positive on the first keystroke (VS Code reports
        // isDirty=false transiently), where buffer ≠ disk — and stomping
        // _diskHash there breaks the discard guard on later close-discard (#278).
        const [, bytes] = await tryCatch(
            Promise.resolve(vscode.workspace.fs.readFile(document.uri) as Promise<Uint8Array>)
        );
        if (bytes && norm(buffer.toString(bytes)) === text) {
            this._diskHash.set(document.uri.path, hash(text));
        }

        // avoid touching eol chars
        const raw = document.getText();
        const i = raw.search(/[^\r\n]/);
        if (i === -1) {
            return;
        }

        const key = `${document.uri}`;
        const ch = raw.charAt(i);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(i), document.positionAt(i + 1)), ch);

        // set lock to prevent echo and discard from _update
        this._locks.add(key);
        void Promise.resolve(vscode.workspace.applyEdit(edit))
            .then((applied) => {
                if (!applied) {
                    this._log.warn(`dirty reload applyEdit failed for ${document.uri}`);
                }
            })
            .finally(() => {
                this._locks.delete(key);
            });
    }

    private _revertBlockedEdit(document: vscode.TextDocument) {
        const key = `${document.uri}`;
        return this._writeMutex.atomic([key], async () => {
            if (this._locks.has(key)) {
                return;
            }

            const [, bytes] = await tryCatch(
                Promise.resolve(vscode.workspace.fs.readFile(document.uri) as Promise<Uint8Array>)
            );
            const expected = bytes ? norm(buffer.toString(bytes)) : '';
            const current = document.getText();
            if (current === expected) {
                return;
            }

            const { prefix, suffix } = diff(current, expected);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(document.positionAt(prefix), document.positionAt(current.length - suffix)),
                expected.substring(prefix, expected.length - suffix)
            );

            this._locks.add(key);
            this._blocked.add(key);
            const [err, applied] = await tryCatch(Promise.resolve(vscode.workspace.applyEdit(edit)));
            this._blocked.delete(key);
            this._locks.delete(key);
            if (err || !applied) {
                this._log.warn(`blocked edit revert failed for ${document.uri}`);
            }
        });
    }

    private _watchEvents(folderUri: vscode.Uri) {
        const assetFileCreate = this._events.on('asset:file:create', async (path, type, content) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            await this._create(uri, type, content);
            await this._reconcile(uri, path, type);
        });
        const assetFileUpdate = this._events.on('asset:file:update', async (path, op, content, prev) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            const key = `${uri}`;
            this._opLocks.set(key, (this._opLocks.get(key) ?? 0) + 1);
            this._checkIgnoreUpdated(uri);
            await tryCatch(this._update(uri, op, content, prev));
            const remaining = (this._opLocks.get(key) ?? 1) - 1;
            if (remaining > 0) {
                this._opLocks.set(key, remaining);
            } else {
                this._opLocks.delete(key);
            }
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
        const assetFileFailed = this._events.on('asset:file:failed', async (path) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            if (!doc || doc.isDirty) {
                return;
            }
            await this._dirty(doc);
        });
        const assetFileSubscribed = this._events.on('asset:file:subscribed', async (path, content, dirty) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            await this._subscribed(uri, path, content, dirty);
        });
        return () => {
            this._events.off('asset:file:create', assetFileCreate);
            this._events.off('asset:file:update', assetFileUpdate);
            this._events.off('asset:file:rename', assetFileRename);
            this._events.off('asset:file:delete', assetFileDelete);
            this._events.off('asset:file:save', assetFileSave);
            this._events.off('asset:file:failed', assetFileFailed);
            this._events.off('asset:file:subscribed', assetFileSubscribed);
        };
    }

    private _watchUndoRedo(folderUri: vscode.Uri, projectManager: ProjectManager) {
        // gate the undo/redo keybindings on an active collab editor. re-derive
        // from the LIVE activeTextEditor on focus/visible-editor changes too, not
        // just active-editor changes — a stale context lets Ctrl+Z fall through to
        // native undo, which bypasses OT sync. (the native-undo handler stays as a
        // safety net for Edit-menu / palette undo, which keybindings can't gate.)
        let active: boolean | undefined;
        const updateCtx = () => {
            const e = vscode.window.activeTextEditor;
            const next = !!(e && uriStartsWith(e.document.uri, folderUri));
            if (next === active) {
                return;
            }
            active = next;
            vscode.commands.executeCommand('setContext', 'playcanvas.active', next);
        };
        updateCtx();
        const onEditor = vscode.window.onDidChangeActiveTextEditor(updateCtx);
        const onVisible = vscode.window.onDidChangeVisibleTextEditors(updateCtx);
        const onWindow = vscode.window.onDidChangeWindowState(updateCtx);

        // shared apply logic for undo/redo — op pop + apply are atomic inside mutex
        const applyOp = async (
            op: ShareDbTextOp,
            uri: vscode.Uri,
            path: string,
            file: { doc: { text: string; apply: (op: ShareDbTextOp) => void }; dirty: boolean }
        ) => {
            this._locks.add(`${uri}`);
            await tryCatch(async () => {
                // apply to OT canonical state (submits to ShareDB)
                file.doc.apply(op);
                const target = file.doc.text;

                // write the buffer to match canonical via a minimal diff against
                // the ACTUAL current buffer — never assume it equals pre-op
                // canonical. a stale buffer (e.g. a prior buffer write that failed
                // to land) would otherwise be misread as concurrent user input and
                // the op transformed against a phantom divergence, duplicating
                // content. diffing against the live buffer self-heals any drift.
                const doc = await vscode.workspace.openTextDocument(uri);
                const buf = norm(doc.getText());
                const bufOp = delta(buf, target);

                if (bufOp) {
                    const edit = sharedb2vscode(doc, uri, [bufOp], buf);
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (!applied) {
                        this._log.warn(`sync.undo.apply failed ${uri}`);
                    } else {
                        // reconcile keystrokes typed during the applyEdit await
                        const late = delta(target, norm(doc.getText()));
                        if (late) {
                            const adv = delta(target, file.doc.text);
                            const adjusted = adv ? (ottext.transform(late, adv, 'left') as ShareDbTextOp) : late;
                            file.doc.apply(adjusted);
                        }

                        // cursor: position after the op's primary edit
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
                            active.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
                        }
                    }
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
            onVisible.dispose();
            onWindow.dispose();
            undoCmd.dispose();
            redoCmd.dispose();
            vscode.commands.executeCommand('setContext', 'playcanvas.active', false);
        };
    }

    private _resetNativeHistory(document: vscode.TextDocument, text: string) {
        const key = `${document.uri}`;
        void this._writeMutex.atomic([key], async () => {
            if (this._locks.has(key)) {
                return;
            }

            const raw = document.getText();
            const next = document.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, '\r\n') : text;
            if (raw === next) {
                return;
            }

            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(raw.length)), next);

            this._locks.add(key);
            const [err, applied] = await tryCatch(Promise.resolve(vscode.workspace.applyEdit(edit)));
            this._locks.delete(key);
            if (err || !applied) {
                this._log.warn(`native history reset failed ${document.uri}`);
            }
        });
    }

    private _syncNativeHistory(
        document: vscode.TextDocument,
        path: string,
        file: { doc: { text: string; apply: (op: ShareDbTextOp) => void }; dirty: boolean },
        mgr: UndoManager | undefined,
        redo: boolean
    ) {
        const op = redo ? mgr?.redo(file.doc.text) : mgr?.undo(file.doc.text);
        if (!op) {
            this._resetNativeHistory(document, file.doc.text);
            return;
        }

        const expected = ottext.apply(file.doc.text, op) as string;
        file.doc.apply(op);

        const wasDirty = file.dirty;
        file.dirty = true;
        if (!wasDirty) {
            this._events.emit('asset:file:dirty', path, true);
        }

        if (norm(document.getText()) !== expected) {
            this._resetNativeHistory(document, expected);
        }
    }

    private _watchDocument(folderUri: vscode.Uri, projectManager: ProjectManager) {
        for (const open of vscode.workspace.textDocuments) {
            if (!uriStartsWith(open.uri, folderUri)) {
                continue;
            }
            const path = relativePath(open.uri, folderUri);
            this._undos.set(open.uri.path, new UndoManager());
            if (!this._diskHash.has(open.uri.path)) {
                this._diskHash.set(open.uri.path, hash(norm(open.getText())));
            }
            this._events.emit('asset:doc:open', path);
            this._dirty(open);
        }
        const onopen = vscode.workspace.onDidOpenTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }
            const path = relativePath(document.uri, folderUri);
            this._undos.set(document.uri.path, new UndoManager());
            this._diskHash.set(document.uri.path, hash(norm(document.getText())));
            this._events.emit('asset:doc:open', path);
            this._dirty(document);
        });
        const onclose = vscode.workspace.onDidCloseTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }
            const path = relativePath(document.uri, folderUri);
            this._undos.get(document.uri.path)?.clear();
            this._undos.delete(document.uri.path);
            this._diskHash.delete(document.uri.path);
            this._diskStat.delete(document.uri.path);
            this._saving.delete(document.uri.path);
            this._blocked.delete(`${document.uri}`);
            this._opLocks.delete(`${document.uri}`);
            this._events.emit('asset:doc:close', path);
        });

        const onchange = vscode.workspace.onDidChangeTextDocument((e) => {
            const { document, contentChanges, reason } = e;
            // check if in folder
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }

            // check if there are changes
            if (contentChanges.length === 0) {
                return;
            }

            // check if file is in memory
            const path = relativePath(document.uri, folderUri);
            const file = projectManager.files.get(path);
            if ((!file || file.type !== 'file') && projectManager.loading(path)) {
                if (!this._blocked.has(`${document.uri}`)) {
                    if (!this._locks.has(`${document.uri}`)) {
                        void this._revertBlockedEdit(document);
                    }
                    void vscode.window.showWarningMessage('PlayCanvas file is still loading. Try again in a moment.');
                }
                return;
            }

            // check if locked (from remote update) or remote op pending in
            // the sync-to-microtask gap before _update's mutex body runs
            const lockKey = `${document.uri}`;
            if (this._locks.has(lockKey) || this._opLocks.has(lockKey)) {
                return;
            }

            if (!file || file.type !== 'file') {
                return;
            }

            const mgr = this._undos.get(document.uri.path);
            if (reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo) {
                this._syncNativeHistory(document, path, file, mgr, reason === vscode.TextDocumentChangeReason.Redo);
                return;
            }

            // check if content actually changed (avoid echo and discard)
            // normalize to LF — canonical OT state is always LF
            const text = norm(document.getText());
            if (file.doc.text === text) {
                return;
            }

            // skip discard/revert: a non-undo/redo change that lands the buffer back on
            // the on-disk bytes is a revert (Don't Save / Revert File), never a real edit.
            // the disk file is the derived save-only artifact (server treats the live OT
            // doc as source of truth), so pushing it upstream rolls every collaborator back
            // to stale content (#315). the native close dialog can fire this while
            // document.isDirty is still true, so do NOT gate on the transient dirty flag.
            // undo/redo carry a reason and are handled above.
            if (!reason && hash(text) === this._diskHash.get(document.uri.path)) {
                return;
            }

            // submit ops via OTDocument (applies locally + submits to ShareDB)
            const ops = vscode2sharedb(document, contentChanges, file.doc.text);
            for (const op of ops) {
                // push inverse to undo stack for local edits
                // (extension undo/redo apply under _locks, so they never reach here)
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

            // trigger VSCode dirty indicator if externally changed
            const external = !reason && ops.length > 0 && !document.isDirty;
            if (external) {
                this._dirtyReload(document, text);
            }

            this._log.debug(
                `document.change ${document.uri.path} ${ops.map((o) => stat(o)).join(' ')} external=${external}`
            );
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
                                        // open file: editor's onDidChangeTextDocument owns reload+submit;
                                        // pushing here too races and duplicates content
                                        if (this._isOpen(op.uri)) {
                                            this._log.debug(`change.local (atomic open-skip) ${op.uri}`);
                                            return;
                                        }
                                        this._log.debug(`change.local (atomic) ${op.uri}`);
                                        await projectManager.write(path, content);
                                        // dirtify if the file is open in an editor
                                        const doc = vscode.workspace.textDocuments.find(
                                            (d) => d.uri.path === op.uri.path
                                        );
                                        if (doc) {
                                            this._dirty(doc);
                                        }
                                        return;
                                    }

                                    // ensure ancestor folders top-down — always delegate to create() so siblings
                                    // serialise via the _creating coalescer across the messenger ack; echo each
                                    // ancestor so a late watcher event for the folder is dropped, not re-queued.
                                    const segments = path.split('/');
                                    for (let j = 1; j < segments.length; j++) {
                                        const ancestorPath = segments.slice(0, j).join('/');
                                        const ancestorUri = vscode.Uri.joinPath(folderUri, ancestorPath);
                                        this._echo.set(`${ancestorUri}:create`, '');
                                        await projectManager.create(ancestorPath, 'folder');
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
                                    const doc = vscode.workspace.textDocuments.find((d) => d.uri.path === op.uri.path);
                                    if (doc) {
                                        this._dirty(doc);
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

            // skip .pc/ type files
            const createRel = relativePath(uri, folderUri);
            if (createRel === Disk.TYPE_DIR || createRel.startsWith(`${Disk.TYPE_DIR}/`)) {
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

            // restore .pc/ type files if modified by user (skip if echo matches our own write)
            const changeRel = relativePath(uri, folderUri);
            if (changeRel === Disk.TYPE_DIR || changeRel.startsWith(`${Disk.TYPE_DIR}/`)) {
                const echoHash = this._echo.get(`${uri}:change`);
                if (echoHash) {
                    this._echo.delete(`${uri}:change`);
                } else {
                    void this._writeTypeFiles(folderUri);
                }
                return;
            }

            // check if document is not open
            // NOTE: document change event handles open files; the watcher must defer to
            // it or it races the editor path and duplicates content on the server
            if (this._isOpen(uri)) {
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

            // re-create .pc/ type files if deleted
            const deleteRel = relativePath(uri, folderUri);
            if (deleteRel === Disk.TYPE_DIR || deleteRel.startsWith(`${Disk.TYPE_DIR}/`)) {
                void this._writeTypeFiles(folderUri);
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

    async link({
        folderUri,
        projectManager,
        types
    }: {
        folderUri: vscode.Uri;
        projectManager: ProjectManager;
        types: TypeFiles;
    }) {
        if (this._folderUri !== undefined) {
            throw this.error.set(() => fail`manager already linked`);
        }

        // drain stale cleanup from a previously failed link
        await super.unlink();

        // install baseline vcs-aware ignore filter before any disk writes —
        // .pcignore content is parsed later once stubs are on disk
        this._parseIgnoreText('', folderUri);

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

        // show progress notification early so users see feedback during REST prefetch
        const folders = ordered.filter(([, f]) => f.type === 'folder');
        const files = ordered.filter(([, f]) => f.type !== 'folder');
        const updatingDiskNext = await progressNotification('Updating Disk', folders.length + files.length);

        // prefetch REST content for stubs (pooled — continuous worker saturation under concurrency cap)
        const stubs = ordered.filter(([, f]) => f.type === 'stub');
        const fetched = new Map<number, Uint8Array>();
        await pool(stubs, FETCH_CONCURRENCY, async ([, f]) => {
            const [err, buf] = await tryCatch(projectManager.fetchContent(f.uniqueId));
            // normalize REST content to LF — S3 may hold CRLF from pre-fix uploads
            fetched.set(f.uniqueId, err ? new Uint8Array() : buffer.from(norm(buffer.toString(buf))));
        });

        // write files to disk — folders first (parents before descendants), then files, via worker pool
        const writeAll = (entries: typeof ordered, type: 'file' | 'folder') =>
            pool(entries, WRITE_CONCURRENCY, async ([path, file]) => {
                const uri = vscode.Uri.joinPath(folderUri, path);
                let content: Uint8Array;
                if (file.type === 'file') {
                    content = buffer.from(file.doc.text);
                } else if (file.type === 'stub') {
                    content = fetched.get(file.uniqueId) ?? new Uint8Array();
                } else {
                    content = new Uint8Array();
                }
                await this._create(uri, type, content);
                updatingDiskNext();
            });
        await writeAll(folders, 'folder');
        await writeAll(files, 'file');

        // parse ignore file (after disk write so stub content is available)
        const ignoreFile = projectManager.files.get(Disk.IGNORE_FILE);
        if (ignoreFile?.type === 'file') {
            this._parseIgnoreText(ignoreFile.doc.text, folderUri);
        } else if (ignoreFile?.type === 'stub') {
            const ignoreUri = vscode.Uri.joinPath(folderUri, Disk.IGNORE_FILE);
            const [, raw] = await tryCatch(vscode.workspace.fs.readFile(ignoreUri) as Promise<Uint8Array>);
            if (raw) {
                this._parseIgnoreText(norm(buffer.toString(raw)), folderUri);
            }
        }

        // write type definition files to .pc/
        await this._writeTypeFiles(folderUri, types);

        // remove old files deepest-first — siblings at each level parallelize
        const levels = new Map<number, vscode.Uri[]>();
        for (const uri of await readDirRecursive(folderUri)) {
            const path = relativePath(uri, folderUri);
            if (
                !projectManager.files.has(path) &&
                path !== Disk.TYPE_DIR &&
                !path.startsWith(`${Disk.TYPE_DIR}/`) &&
                !this._ignoring(uri)
            ) {
                const depth = path.split('/').length;
                const bucket = levels.get(depth);
                if (bucket) {
                    bucket.push(uri);
                } else {
                    levels.set(depth, [uri]);
                }
            }
        }
        for (const depth of [...levels.keys()].sort((a, b) => b - a)) {
            await pool(levels.get(depth)!, WRITE_CONCURRENCY, (uri) => this._delete(uri));
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
            this._ignoring = (_uri: vscode.Uri) => false;
            this._ignoreHash = '';
            this._types = undefined;
        });

        this._folderUri = folderUri;
        this._projectManager = projectManager;
        this._types = types;

        this._log.info(`linked to ${folderUri.toString()}`);
    }

    async unlink() {
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;
        const types = this._types;
        if (!folderUri || !projectManager || !types) {
            throw this.error.set(() => fail`unlink called before link`);
        }
        await super.unlink();
        this._folderUri = undefined;
        this._projectManager = undefined;
        this._types = undefined;
        this._diskHash.clear();
        this._diskStat.clear();
        this._opLocks.clear();
        this._undos.forEach((m) => m.clear());
        this._undos.clear();
        void vscode.commands.executeCommand('setContext', 'playcanvas.active', false);
        this._log.info(`unlinked from ${folderUri.toString()}`);
        return { folderUri, projectManager, types };
    }
}

export { Disk };
