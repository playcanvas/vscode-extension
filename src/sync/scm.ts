import * as vscode from 'vscode';

import { Debouncer } from '../utils/debouncer';
import { fail } from '../utils/error';
import { Linker } from '../utils/linker';
import { effect, signal } from '../utils/signal';
import { relativePath, uriStartsWith, tryCatch } from '../utils/utils';

import type { SyncState } from './status';
import type { NativeSyncEngine } from './sync-engine';

const BASE_SCHEME = 'playcanvas-base';
const REMOTE_SCHEME = 'playcanvas-remote';
const MERGE_SCHEME = 'playcanvas-merge';
const REFRESH_DELAY = 200;
const DECORATION: Record<SyncState, { letter: string; color: string; tooltip: string; strikeThrough?: boolean }> = {
    clean: { letter: '', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'clean' },
    modified: { letter: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'modified' },
    behind: { letter: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'incoming' },
    both: { letter: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'modified, incoming' },
    conflicted: { letter: '!', color: 'gitDecoration.conflictingResourceForeground', tooltip: 'conflict' },
    added: { letter: 'A', color: 'gitDecoration.addedResourceForeground', tooltip: 'added' },
    deleted: { letter: 'D', color: 'gitDecoration.deletedResourceForeground', tooltip: 'deleted', strikeThrough: true },
    renamed: { letter: 'R', color: 'gitDecoration.renamedResourceForeground', tooltip: 'renamed' }
};

type LinkParams = { folderUri: vscode.Uri; engine: NativeSyncEngine };

const scmDecoration = (state: SyncState, tooltip = DECORATION[state].tooltip) => {
    const d = DECORATION[state];
    return {
        letter: d.letter,
        color: new vscode.ThemeColor(d.color),
        priority: state === 'conflicted' ? 4 : 1,
        decorations: { tooltip, strikeThrough: d.strikeThrough }
    };
};

// git-style Source Control panel backed by the NativeSyncEngine status.
class PlayCanvasScm extends Linker<LinkParams> {
    private _folderUri?: vscode.Uri;

    private _engine?: NativeSyncEngine;

    private _scm?: vscode.SourceControl;

    private _changes?: vscode.SourceControlResourceGroup;

    private _incoming?: vscode.SourceControlResourceGroup;

    private _merge?: vscode.SourceControlResourceGroup;

    error = signal<Error | undefined>(undefined);

    private _resource(uri: vscode.Uri, path: string, state: SyncState) {
        if (state === 'conflicted') {
            if (this._engine?.structuralConflict(path)) {
                return {
                    resourceUri: uri,
                    ...scmDecoration(state, 'structural conflict — resolve'),
                    command: {
                        command: 'playcanvas.resolveStructuralConflict',
                        title: 'Resolve Structural Conflict',
                        arguments: [uri]
                    }
                };
            }
            return {
                resourceUri: uri,
                ...scmDecoration(state, 'conflict — open the merge editor'),
                command: {
                    command: 'playcanvas.resolveMerge',
                    title: 'Resolve in Merge Editor',
                    arguments: [uri]
                }
            };
        }
        // incoming: diff against the live remote — working vs base is empty here
        if (state === 'behind') {
            return {
                resourceUri: uri,
                ...scmDecoration(state, 'incoming — pull to apply'),
                command: {
                    command: 'vscode.diff',
                    title: 'Open Changes',
                    arguments: [uri, uri.with({ scheme: REMOTE_SCHEME }), `${path} (working vs remote)`]
                }
            };
        }
        return {
            resourceUri: uri,
            ...scmDecoration(state),
            command: {
                command: 'vscode.diff',
                title: 'Open Changes',
                arguments: [uri.with({ scheme: BASE_SCHEME }), uri, `${path} (working vs base)`]
            }
        };
    }

    private _render() {
        const folderUri = this._folderUri;
        const engine = this._engine;
        if (!folderUri || !engine || !this._changes || !this._incoming || !this._merge || !this._scm) {
            return;
        }

        const changes: vscode.SourceControlResourceState[] = [];
        const incoming: vscode.SourceControlResourceState[] = [];
        const merge: vscode.SourceControlResourceState[] = [];
        for (const [path, state] of engine.statuses()) {
            const uri = vscode.Uri.joinPath(folderUri, path);
            const rs = this._resource(uri, path, state);
            if (state === 'conflicted') {
                merge.push(rs);
            } else if (state === 'behind') {
                incoming.push(rs);
            } else if (
                state === 'modified' ||
                state === 'both' ||
                state === 'added' ||
                state === 'deleted' ||
                state === 'renamed'
            ) {
                changes.push(rs);
                // both: surface the server side too — base vs remote isolates
                // what pull will merge, without conflating your local edits
                if (state === 'both') {
                    incoming.push({
                        resourceUri: uri,
                        ...scmDecoration('behind', 'incoming — pull to merge'),
                        command: {
                            command: 'vscode.diff',
                            title: 'Open Changes',
                            arguments: [
                                uri.with({ scheme: BASE_SCHEME }),
                                uri.with({ scheme: REMOTE_SCHEME }),
                                `${path} (base vs remote)`
                            ]
                        }
                    });
                }
            }
        }
        this._changes.resourceStates = changes;
        this._incoming.resourceStates = incoming;
        this._merge.resourceStates = merge;
        this._scm.count = changes.length + merge.length;
    }

    async link({ folderUri, engine }: LinkParams) {
        if (this._folderUri !== undefined) {
            throw this.error.set(() => fail`already linked`);
        }
        await super.unlink();

        // no rootUri: sharing git's project folder makes VS Code render git's
        // resource-group actions (stage/discard) on our groups
        const scm = vscode.scm.createSourceControl('playcanvas', 'PlayCanvas');
        scm.inputBox.visible = false;
        const changes = scm.createResourceGroup('changes', 'Changes');
        const incoming = scm.createResourceGroup('incoming', 'Incoming Changes');
        const merge = scm.createResourceGroup('merge', 'Merge Changes');
        changes.hideWhenEmpty = true;
        incoming.hideWhenEmpty = true;
        merge.hideWhenEmpty = true;

        // gutter diff: working vs base
        scm.quickDiffProvider = {
            provideOriginalResource: (uri) =>
                uriStartsWith(uri, folderUri) ? uri.with({ scheme: BASE_SCHEME }) : undefined
        };

        // serve base content for the playcanvas-base: scheme. onDidChange
        // invalidates cached gutter quick-diffs when push/pull advance the base
        const baseChanged = new vscode.EventEmitter<vscode.Uri>();
        const content = vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
            onDidChange: baseChanged.event,
            provideTextDocumentContent: (uri) => engine.baseText(relativePath(uri, folderUri)) ?? ''
        });

        // serve live remote content (R) for incoming diffs. onDidChange keeps an
        // open diff current while a collaborator keeps typing (R moves between renders)
        const remoteChanged = new vscode.EventEmitter<vscode.Uri>();
        const remote = vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, {
            onDidChange: remoteChanged.event,
            provideTextDocumentContent: async (uri) => (await engine.remoteText(relativePath(uri, folderUri))) ?? ''
        });

        // serve ancestor/local/remote for the merge editor (one scheme each)
        const mergeProvider = (field: 'base' | 'local' | 'remote') =>
            vscode.workspace.registerTextDocumentContentProvider(`${MERGE_SCHEME}-${field}`, {
                provideTextDocumentContent: (uri) => engine.mergeInputs(relativePath(uri, folderUri))?.[field] ?? ''
            });
        const mergeBase = mergeProvider('base');
        const mergeLocal = mergeProvider('local');
        const mergeRemote = mergeProvider('remote');

        // recompute status of the saved file (saveAll during pull/push fires
        // one event per buffer — a full refresh each would rescan the project)
        const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
            if (uriStartsWith(doc.uri, folderUri)) {
                void engine.refresh(relativePath(doc.uri, folderUri));
            }
        });

        // live status: per-path debounce so concurrent edits to different files
        // don't cancel each other's refresh
        const debouncer = new Debouncer<void>(REFRESH_DELAY);
        const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
            if (!uriStartsWith(e.document.uri, folderUri)) {
                return;
            }
            const path = relativePath(e.document.uri, folderUri);
            void tryCatch(debouncer.debounce(path, () => engine.refresh(path)));
        });

        this._folderUri = folderUri;
        this._engine = engine;
        this._scm = scm;
        this._changes = changes;
        this._incoming = incoming;
        this._merge = merge;

        // re-render whenever the engine's status changes; invalidate base/remote
        // virtual docs too (only uris with an open editor get re-read by vscode)
        const stop = effect(() => {
            engine.changed.get();
            this._render();
            for (const path of engine.statuses().keys()) {
                const uri = vscode.Uri.joinPath(folderUri, path);
                baseChanged.fire(uri.with({ scheme: BASE_SCHEME }));
                remoteChanged.fire(uri.with({ scheme: REMOTE_SCHEME }));
            }
        });

        this._cleanup.push(async () => {
            stop();
            debouncer.clear();
            onChange.dispose();
            onSave.dispose();
            content.dispose();
            baseChanged.dispose();
            remote.dispose();
            remoteChanged.dispose();
            mergeBase.dispose();
            mergeLocal.dispose();
            mergeRemote.dispose();
            scm.dispose();
        });

        void vscode.commands.executeCommand('setContext', 'playcanvas.pullpush', true);
        this._log.info(`linked ${folderUri.toString()}`);
    }

    async unlink() {
        const folderUri = this._folderUri;
        const engine = this._engine;
        if (!folderUri || !engine) {
            throw this.error.set(() => fail`unlink called before link`);
        }
        await super.unlink();
        this._folderUri = undefined;
        this._engine = undefined;
        this._scm = undefined;
        this._changes = undefined;
        this._incoming = undefined;
        this._merge = undefined;
        void vscode.commands.executeCommand('setContext', 'playcanvas.pullpush', false);
        this._log.info(`unlinked ${folderUri.toString()}`);
        return { folderUri, engine };
    }
}

export { PlayCanvasScm, scmDecoration };
