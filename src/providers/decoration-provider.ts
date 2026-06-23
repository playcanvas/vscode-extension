import * as vscode from 'vscode';

import { Disk } from '../disk';
import type { ProjectManager } from '../project-manager';
import { SCM_SCHEME } from '../sync/scm';
import type { SyncState } from '../sync/status';
import type { NativeSyncEngine } from '../sync/sync-engine';
import type { EventMap } from '../typings/event-map';
import { fail } from '../utils/error';
import type { EventEmitter } from '../utils/event-emitter';
import { Linker } from '../utils/linker';
import { effect, signal } from '../utils/signal';

const MANAGED_COLOR = new vscode.ThemeColor('playcanvas.managedForeground');
const MANAGED_DECORATION: vscode.FileDecoration = {
    badge: 'PC',
    color: MANAGED_COLOR,
    tooltip: 'Managed by PlayCanvas'
};
const DIRTY_COLOR = new vscode.ThemeColor('playcanvas.dirtyForeground');
const SYNC_DECORATION: Record<
    Exclude<SyncState, 'clean'>,
    { badge: string; color: string; tooltip: string; strikeThrough?: boolean }
> = {
    modified: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'Modified' },
    behind: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'Incoming' },
    both: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'Modified, incoming' },
    conflicted: { badge: '!', color: 'gitDecoration.conflictingResourceForeground', tooltip: 'Conflict' },
    added: { badge: 'A', color: 'gitDecoration.addedResourceForeground', tooltip: 'Added' },
    deleted: { badge: 'D', color: 'gitDecoration.deletedResourceForeground', tooltip: 'Deleted', strikeThrough: true },
    renamed: { badge: 'R', color: 'gitDecoration.renamedResourceForeground', tooltip: 'Renamed' }
};

const syncDecoration = (state: SyncState) => {
    if (state === 'clean') {
        return undefined;
    }
    const d = SYNC_DECORATION[state];
    return {
        badge: d.badge,
        color: new vscode.ThemeColor(d.color),
        tooltip: d.tooltip,
        strikeThrough: d.strikeThrough,
        propagate: false
    };
};

class DecorationProvider
    extends Linker<{ folderUri: vscode.Uri; projectManager: ProjectManager }>
    implements vscode.FileDecorationProvider
{
    private _events: EventEmitter<EventMap>;

    private _syncEngine?: NativeSyncEngine;

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    error = signal<Error | undefined>(undefined);

    constructor({ events, syncEngine }: { events: EventEmitter<EventMap>; syncEngine?: NativeSyncEngine }) {
        super();
        this._events = events;
        this._syncEngine = syncEngine;
    }

    provideFileDecoration(uri: vscode.Uri) {
        // badge for .pc/ directory and its managed files
        const segments = uri.path.split('/');
        if (uri.scheme !== SCM_SCHEME && segments.includes(Disk.TYPE_DIR)) {
            return MANAGED_DECORATION;
        }

        const folderUri = this._folderUri;
        const pm = this._projectManager;
        if (!folderUri || !pm) {
            return undefined;
        }

        // check uri is under folder
        if (!uri.path.startsWith(folderUri.path + '/') && uri.path !== folderUri.path) {
            return undefined;
        }

        const path = uri.path.slice(folderUri.path.length + 1);
        if (uri.scheme === SCM_SCHEME) {
            return syncDecoration(this._syncEngine?.decorationStatus(path) ?? 'clean');
        }

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
        if (this._folderUri !== undefined) {
            throw this.error.set(() => fail`already linked`);
        }

        // drain stale cleanup from a previously failed link
        await super.unlink();

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
        const stopSync = this._syncEngine
            ? effect(() => {
                  this._syncEngine?.changed.get();
                  this._onDidChangeFileDecorations.fire(undefined);
              })
            : undefined;

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
            stopSync?.();

            // clear all decorations
            this._onDidChangeFileDecorations.fire(undefined);
        });

        this._folderUri = folderUri;
        this._projectManager = projectManager;

        this._log.info(`linked to ${folderUri.toString()}`);
    }

    async unlink() {
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;
        if (!folderUri || !projectManager) {
            throw this.error.set(() => fail`unlink called before link`);
        }
        await super.unlink();
        this._folderUri = undefined;
        this._projectManager = undefined;
        this._log.info(`unlinked from ${folderUri.toString()}`);
        return { folderUri, projectManager };
    }
}

export { DecorationProvider, syncDecoration };
