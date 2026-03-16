import * as vscode from 'vscode';

import type { ProjectManager } from '../project-manager';
import type { EventMap } from '../typings/event-map';
import type { EventEmitter } from '../utils/event-emitter';
import { Linker } from '../utils/linker';
import { signal } from '../utils/signal';

const DIRTY_COLOR = new vscode.ThemeColor('playcanvas.dirtyForeground');

class DirtyDecorationProvider
    extends Linker<{ folderUri: vscode.Uri; projectManager: ProjectManager }>
    implements vscode.FileDecorationProvider
{
    private _events: EventEmitter<EventMap>;

    private _linked = false;

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    error = signal<Error | undefined>(undefined);

    constructor({ events }: { events: EventEmitter<EventMap> }) {
        super();
        this._events = events;
    }

    provideFileDecoration(uri: vscode.Uri) {
        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm || !this._linked) {
            return undefined;
        }

        // check uri is under folder
        if (!uri.path.startsWith(folderUri.path + '/') && uri.path !== folderUri.path) {
            return undefined;
        }

        const path = uri.path.slice(folderUri.path.length + 1);
        const file = pm.files.get(path);
        if (!file || file.type !== 'file' || !file.dirty) {
            return undefined;
        }

        return { color: DIRTY_COLOR };
    }

    private _fire(path: string) {
        const folderUri = this._folderUri;
        if (!folderUri) {
            return;
        }
        this._onDidChangeFileDecorations.fire(vscode.Uri.joinPath(folderUri, path));
    }

    async link({ folderUri, projectManager }: { folderUri: vscode.Uri; projectManager: ProjectManager }) {
        if (this._linked) {
            throw this.error.set(() => new Error('already linked'));
        }

        this._folderUri = folderUri;
        this._projectManager = projectManager;

        // listen for dirty transitions
        const onDirty = this._events.on('asset:file:dirty', (path) => this._fire(path));
        const onUpdate = this._events.on('asset:file:update', (path) => this._fire(path));
        const onSave = this._events.on('asset:file:save', (path) => this._fire(path));
        const onCreate = this._events.on('asset:file:create', (path) => this._fire(path));
        const onDelete = this._events.on('asset:file:delete', (path) => this._fire(path));
        const onRename = this._events.on('asset:file:rename', (from, to) => {
            this._fire(from);
            this._fire(to);
        });

        // fire initial decorations for already-dirty files
        const uris: vscode.Uri[] = [];
        for (const [path, file] of projectManager.files) {
            if (file.type === 'file' && file.dirty) {
                uris.push(vscode.Uri.joinPath(folderUri, path));
            }
        }
        if (uris.length) {
            this._onDidChangeFileDecorations.fire(uris);
        }

        this._cleanup.push(async () => {
            this._events.off('asset:file:dirty', onDirty);
            this._events.off('asset:file:update', onUpdate);
            this._events.off('asset:file:save', onSave);
            this._events.off('asset:file:create', onCreate);
            this._events.off('asset:file:delete', onDelete);
            this._events.off('asset:file:rename', onRename);

            // clear all decorations
            this._onDidChangeFileDecorations.fire(undefined);
        });

        this._linked = true;

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

export { DirtyDecorationProvider };
