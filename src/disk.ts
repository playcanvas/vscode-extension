import ignore from 'ignore';
import * as vscode from 'vscode';

import { simpleNotification } from './notification';
import type { ProjectManager } from './project-manager';
import type { EventMap } from './typings/event-map';
import type { ShareDbTextOp } from './typings/sharedb';
import * as buffer from './utils/buffer';
import type { EventEmitter } from './utils/event-emitter';
import { Linker } from './utils/linker';
import { Mutex } from './utils/mutex';
import {
    parsePath,
    sharedb2vscode,
    relativePath,
    vscode2sharedb,
    uriStartsWith,
    fileExists,
    catchError
} from './utils/utils';

const readDirRecursive = async (uri: vscode.Uri) => {
    const result: vscode.Uri[] = [];
    const entries = await vscode.workspace.fs.readDirectory(uri);
    for (const [name, type] of entries) {
        const fullPath = vscode.Uri.joinPath(uri, name);
        if (type === vscode.FileType.Directory) {
            result.push(fullPath, ...(await readDirRecursive(fullPath)));
        } else {
            result.push(fullPath);
        }
    }
    return result;
};

const fileType = async (uri: vscode.Uri) => {
    const [error, stat] = await catchError(() => vscode.workspace.fs.stat(uri) as Promise<vscode.FileStat>);
    if (error) {
        return undefined;
    }
    return stat.type === vscode.FileType.Directory ? 'folder' : 'file';
};

const fileContent = async (uri: vscode.Uri, type: Promise<'file' | 'folder' | undefined>) => {
    if ((await type) !== 'file') {
        return undefined;
    }
    const [error, content] = await catchError(() => vscode.workspace.fs.readFile(uri) as Promise<Uint8Array>);
    if (error) {
        return undefined;
    }
    return content;
};

class Disk extends Linker<{ folderUri: vscode.Uri; projectManager: ProjectManager }> {
    static IGNORE_FILE = '.pcignore';

    private _events: EventEmitter<EventMap>;

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _opened = new Set<string>();

    private _echo: Set<string> = new Set<string>();

    private _mutex = new Mutex<void>();

    private _ignoring = (_uri: vscode.Uri) => false;

    constructor({ debug = false, events }: { debug?: boolean; events: EventEmitter<EventMap> }) {
        super(debug);

        this._events = events;
    }

    private _checkIgnoreUpdated(uri: vscode.Uri) {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return;
        }
        const path = relativePath(uri, folderUri);
        if (path !== Disk.IGNORE_FILE) {
            return;
        }

        // TODO: re-parse ignore file. For now notify to reload project
        vscode.window
            .showInformationMessage(
                `The ignore file has changed on disk. Please reload the project to apply the new ignore rules.`,
                'Reload'
            )
            .then(async (res) => {
                if (res === 'Reload') {
                    await vscode.commands.executeCommand('playcanvas.reloadProject');
                }
            });
    }

    private _parseIgnoreText(text: string, folderUri: vscode.Uri) {
        if (!text) {
            this._ignoring = (_uri: vscode.Uri) => false;
            this._log(`cleared ignore rules from empty ignore file`);
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
        this._log(`parsed ignore file ${vscode.Uri.joinPath(folderUri, Disk.IGNORE_FILE)}`);
    }

    private _create(uri: vscode.Uri, type: 'file' | 'folder', content: Uint8Array) {
        return this._mutex.atomic(`${uri}`, async () => {
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

            // check if parent folder exists
            const parentUri = vscode.Uri.joinPath(uri, '..');
            const parentExists = await fileExists(parentUri);
            if (!parentExists) {
                throw new Error(`parent folder does not exist: ${parentUri.path}`);
            }

            // create on disk
            if (!exists) {
                this._echo.add(`${uri}:create`);
            }
            switch (type) {
                case 'file': {
                    await vscode.workspace.fs.writeFile(uri, content);
                    break;
                }
                case 'folder': {
                    await vscode.workspace.fs.createDirectory(uri);
                    break;
                }
            }

            this._log(`${exists ? 'change' : 'create'}.remote ${type} ${uri}`);
        });
    }

    private _update(uri: vscode.Uri, op: ShareDbTextOp, content: Uint8Array) {
        return this._mutex.atomic(`${uri}`, async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // NOTE: do not need to check local echo as ShareDB op event can check source

            // write directly to document if open
            const open = await vscode.workspace.openTextDocument(uri);
            if (!open.isDirty) {
                // apply edits
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.set(uri, sharedb2vscode(open, [op]));
                await vscode.workspace.applyEdit(workspaceEdit);

                // save document
                await open.save();
            } else {
                this._echo.add(`${uri}:change`);
                await vscode.workspace.fs.writeFile(uri, content);
            }

            this._log(`change.remote${!open.isDirty ? '.live' : ''} ${uri}`);
        });
    }

    private _delete(uri: vscode.Uri) {
        return this._mutex.atomic(`${uri}`, async () => {
            if (this._ignoring(uri)) {
                return;
            }

            // check local echo by seeing if file exists
            const exists = await fileExists(uri);
            if (!exists) {
                return;
            }

            // remove from disk
            this._echo.add(`${uri}:delete`);
            await vscode.workspace.fs.delete(uri, {
                recursive: true,
                useTrash: false
            });

            this._log(`delete.remote file ${uri}`);
        });
    }

    private _rename(oldUri: vscode.Uri, newUri: vscode.Uri) {
        return this._mutex.atomic(`${oldUri}`, async () => {
            if (this._ignoring(oldUri)) {
                return;
            }

            // check local echo by seeing if old file exists
            const oldExists = await fileExists(oldUri);
            if (!oldExists) {
                return;
            }

            // rename on disk
            this._echo.add(`${oldUri}:delete`);
            this._echo.add(`${newUri}:create`);
            await vscode.workspace.fs.rename(oldUri, newUri, {
                overwrite: false
            });

            this._log(`rename.remote ${oldUri.path} -> ${newUri.path}`);
        });
    }

    private _watchEvents(folderUri: vscode.Uri) {
        const assetFileCreate = this._events.on('asset:file:create', async (path, type, content) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            this._create(uri, type, content);
        });
        const assetFileUpdate = this._events.on('asset:file:update', async (path, op, content) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            this._update(uri, op, content);
        });
        const assetFileDelete = this._events.on('asset:file:delete', async (path) => {
            const uri = vscode.Uri.joinPath(folderUri, path);
            this._checkIgnoreUpdated(uri);
            this._delete(uri);
        });
        const assetFileRename = this._events.on('asset:file:rename', async (oldPath, newPath) => {
            const oldUri = vscode.Uri.joinPath(folderUri, oldPath);
            const newUri = vscode.Uri.joinPath(folderUri, newPath);
            this._checkIgnoreUpdated(oldUri);
            this._checkIgnoreUpdated(newUri);
            this._rename(oldUri, newUri);
        });
        return () => {
            this._events.off('asset:file:create', assetFileCreate);
            this._events.off('asset:file:update', assetFileUpdate);
            this._events.off('asset:file:rename', assetFileRename);
            this._events.off('asset:file:delete', assetFileDelete);
        };
    }

    private _watchDocument(folderUri: vscode.Uri, projectManager: ProjectManager) {
        for (const open of vscode.workspace.textDocuments) {
            if (!uriStartsWith(open.uri, folderUri)) {
                continue;
            }
            const path = relativePath(open.uri, folderUri);
            this._opened.add(open.uri.path);
            this._events.emit('asset:doc:open', path);
        }
        const onopen = vscode.workspace.onDidOpenTextDocument((document) => {
            if (!uriStartsWith(document.uri, folderUri)) {
                return;
            }
            const path = relativePath(document.uri, folderUri);
            this._opened.add(document.uri.path);
            this._events.emit('asset:doc:open', path);
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

            // check if content actually changed (avoid echo)
            if (file.doc.data === document.getText()) {
                return;
            }

            // submit ops
            vscode2sharedb(contentChanges).forEach(([op, options]) => {
                file.doc.submitOp(op, options);
            });

            // mark as unsaved
            file.saved = false;

            this._log(`changed file ${document.uri.path}`);
        });
        const onsave = vscode.workspace.onWillSaveTextDocument((e) => {
            const { document } = e;

            // check if file is in memory
            const path = relativePath(document.uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // check if ignore updated
            if (!file.saved) {
                this._checkIgnoreUpdated(document.uri);
            }

            // write to project
            const content = buffer.from(document.getText());
            projectManager.writeFile(path, content);
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

        // check if one path is related to the other (i.e. one is a parent of the other)
        const related = (path1: string, path2: string) => {
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

                    // processing promises
                    const processing = new Map<string, Promise<void>>();

                    // schedule promise
                    const schedule = (deps: string[], fn: () => Promise<void>) => {
                        // wait for all dependencies to resolve
                        const wait = Promise.all(
                            Array.from(processing.entries()).reduce((rest, [path, promise]) => {
                                if (deps.some((p) => related(p, path))) {
                                    rest.push(promise);
                                }
                                return rest;
                            }, [] as Promise<void>[])
                        );

                        // schedule promise
                        const chain = wait
                            .then(() => fn().catch((error) => this._warn(`schedule error: ${error}`)))
                            .finally(() => {
                                // cleanup
                                deps.forEach((path) => {
                                    if (processing.get(path) === chain) {
                                        processing.delete(path);
                                    }
                                });
                            });

                        // add to processing
                        deps.forEach((path) => processing.set(path, chain));

                        return chain;
                    };

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
                                    schedule([path1, path2], async () => {
                                        const type1 = await op1.type;
                                        if (!type1) {
                                            this._warn(`skipping rename of ${op1.uri} as type not found`);
                                            return;
                                        }
                                        const type2 = await op2.type;
                                        if (!type2) {
                                            this._warn(`skipping rename of ${op2.uri} as type not found`);
                                            return;
                                        }
                                        this._log(`rename.local ${op2.uri} -> ${op1.uri}`);
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
                                schedule([path], async () => {
                                    const type = await op.type;
                                    const content = await op.content;
                                    if (!type) {
                                        this._warn(`skipping create of ${op.uri} as type not found`);
                                        return;
                                    }
                                    this._log(`create.local ${type} ${op.uri}`);
                                    return projectManager.create(path, type, content);
                                });
                                break;
                            }
                            case 'change': {
                                const path = relativePath(op.uri, folderUri);
                                schedule([path], async () => {
                                    const content = await op.content;
                                    if (!content) {
                                        this._warn(`skipping change of ${op.uri} as content not found`);
                                        return;
                                    }
                                    this._log(`change.local ${op.uri}`);
                                    return projectManager.writeFile(path, content);
                                });
                                break;
                            }
                            case 'delete': {
                                const path = relativePath(op.uri, folderUri);
                                schedule([path], async () => {
                                    const type = await op.type;
                                    if (!type) {
                                        this._warn(`skipping delete of ${op.uri} as type not found`);
                                        return;
                                    }
                                    this._log(`delete.local ${type} ${op.uri}`);
                                    return projectManager.delete(path, type);
                                });
                                break;
                            }
                        }
                    }

                    // wait for all processing promises to resolve
                    await Promise.all(Array.from(processing.values()));
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
            const key = `${uri}:change`;

            // check local echo
            if (this._echo.has(key)) {
                this._echo.delete(key);
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

            // check if file is in memory and of type file
            const path = relativePath(uri, folderUri);
            const file = projectManager.files.get(path);
            if (!file || file.type !== 'file') {
                return;
            }

            // NOTE: mark as unsaved to allow project manager write
            file.saved = false;

            const type = Promise.resolve('file' as const);
            defer({
                action: 'change',
                uri,
                type,
                content: fileContent(uri, type)
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
                this._warn(`skipping delete of ${path} as it is not in memory`);
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

    private async _read(projectManager: ProjectManager, folderUri: vscode.Uri) {
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

        // add files from project
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

        updatingDiskDone();
    }

    async link({
        folderUri,
        projectManager,
        openFilePath
    }: {
        folderUri: vscode.Uri;
        projectManager: ProjectManager;
        openFilePath?: string;
    }) {
        if (this._folderUri || this._projectManager) {
            throw new Error('manager already linked');
        }

        // parse ignore file
        const file = projectManager.files.get(Disk.IGNORE_FILE);
        if (file?.type === 'file') {
            this._parseIgnoreText(file.doc.data, folderUri);
        }

        // read files to disk
        await this._read(projectManager, folderUri);

        // open file if specified
        if (openFilePath) {
            const openUri = vscode.Uri.joinPath(folderUri, openFilePath);
            if (await fileExists(openUri)) {
                const openDoc = await vscode.workspace.openTextDocument(openUri);
                await vscode.window.showTextDocument(openDoc);
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
            this._mutex.clear();

            this._folderUri = undefined;
            this._projectManager = undefined;
        });

        this._log(`linked to ${folderUri.toString()}`);
    }

    async unlink() {
        if (!this._folderUri || !this._projectManager) {
            throw new Error('manager not linked');
        }
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;

        await Promise.all(this._cleanup.map((fn) => fn()));
        this._cleanup.length = 0;

        this._log(`unlinked from ${folderUri.toString()}`);

        return { folderUri, projectManager };
    }
}

export { Disk };
