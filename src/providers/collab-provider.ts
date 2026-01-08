import * as vscode from 'vscode';

import type { Relay } from '../connections/relay';
import type { Rest } from '../connections/rest';
import type { ProjectManager } from '../project-manager';
import type { EventMap } from '../typings/event-map';
import * as buffer from '../utils/buffer';
import type { EventEmitter } from '../utils/event-emitter';
import { Linker } from '../utils/linker';
import { relativePath, uriStartsWith } from '../utils/utils';

class CollabItem extends vscode.TreeItem {
    readonly username: string;

    constructor(username: string, iconUri: vscode.Uri) {
        super(username, vscode.TreeItemCollapsibleState.None);
        this.username = username;
        this.iconPath = iconUri;
    }
}

class CollabProvider
    extends Linker<{ folderUri: vscode.Uri; projectManager: ProjectManager }>
    implements vscode.TreeDataProvider<CollabItem>
{
    private _events: EventEmitter<EventMap>;

    private _rest: Rest;

    private _rooms = new Map<string, Set<number>>();

    private _items = new Map<number, CollabItem>();

    private _room?: string;

    private _folderUri?: vscode.Uri;

    private _projectManager?: ProjectManager;

    private _onDidChangeTreeData: vscode.EventEmitter<CollabItem | undefined | void> = new vscode.EventEmitter<
        CollabItem | undefined | void
    >();
    readonly onDidChangeTreeData: vscode.Event<CollabItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor({
        debug,
        events,
        relay,
        rest
    }: {
        debug?: boolean;
        events: EventEmitter<EventMap>;
        relay: Relay;
        rest: Rest;
    }) {
        super(debug);

        this._events = events;
        this._rest = rest;

        relay.on('room:join', ({ name, userId, users }) => {
            let room = this._rooms.get(name);
            if (!room) {
                room = new Set<number>();
                this._rooms.set(name, room);
            }

            if (users) {
                for (const id of users) {
                    room.add(id);
                }
            }
            room.add(userId);
            this.refresh();
        });
        relay.on('room:leave', ({ name, userId }) => {
            const room = this._rooms.get(name);
            if (room) {
                room.delete(userId);
                if (room.size === 0) {
                    this._rooms.delete(name);
                }
            }
            this.refresh();
        });
    }

    private _watchDocument(folderUri: vscode.Uri, projectManager: ProjectManager) {
        const switchRoom = (uri: vscode.Uri) => {
            // check if in folder
            if (!uriStartsWith(uri, folderUri)) {
                return;
            }

            // wait for file to be available
            const path = relativePath(uri, folderUri);
            projectManager.waitForFile(path, 'file').then((file) => {
                // set room
                this._room = `document-${file.uniqueId}`;
                this.refresh();
            });
        };
        const disposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor) {
                this._room = undefined;
                this.refresh();
                return;
            }
            switchRoom(editor.document.uri);
        });
        if (vscode.window.activeTextEditor) {
            switchRoom(vscode.window.activeTextEditor.document.uri);
        }
        return () => {
            disposable.dispose();
        };
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem) {
        return element;
    }

    async getChildren(element?: vscode.TreeItem) {
        // top level
        if (!element) {
            const room = this._rooms.get(this._room || '');
            if (!room) {
                return Promise.resolve([]);
            }

            const items: CollabItem[] = [];
            for (const id of room) {
                let item = this._items.get(id);
                if (!item) {
                    const user = await this._rest.user(id);
                    const buf = await this._rest.userThumb(user.id);
                    const base64 = buffer.toBase64(new Uint8Array(buf));
                    const iconUri = vscode.Uri.parse(`data:image/png;base64,${base64}`);
                    item = new CollabItem(user.username, iconUri);
                    this._items.set(id, item);
                }

                items.push(item);
            }
            return Promise.resolve(items.sort((a, b) => a.username.localeCompare(b.username)));
        }

        return Promise.resolve([]);
    }

    link({ folderUri, projectManager }: { folderUri: vscode.Uri; projectManager: ProjectManager }) {
        if (this._folderUri || this._projectManager) {
            throw new Error('manager already linked');
        }

        this._folderUri = folderUri;
        this._projectManager = projectManager;

        const unwatchDocument = this._watchDocument(folderUri, projectManager);

        this._cleanup.push(async () => {
            unwatchDocument();

            this._room = undefined;

            this._folderUri = undefined;
            this._projectManager = undefined;
        });

        this._log(`linked to ${folderUri.toString()}`);

        return Promise.resolve();
    }

    async unlink() {
        if (!this._folderUri || !this._projectManager) {
            throw new Error('manager not linked');
        }
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;

        await super.unlink();

        this._log(`unlinked from ${folderUri.toString()}`);

        return { folderUri, projectManager };
    }
}

export { CollabProvider };
