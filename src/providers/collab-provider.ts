import * as vscode from 'vscode';

import type { Relay } from '../connections/relay';
import type { Rest } from '../connections/rest';
import type { ProjectManager } from '../project-manager';
import * as buffer from '../utils/buffer';
import { Linker } from '../utils/linker';
import { signal } from '../utils/signal';
import { relativePath, uriStartsWith, tryCatch } from '../utils/utils';

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

    error = signal<Error | undefined>(undefined);

    constructor({ relay, rest }: { relay: Relay; rest: Rest }) {
        super();

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
            projectManager
                .waitForFile(path, 'file')
                .then((file) => {
                    // set room
                    this._room = `document-${file.uniqueId}`;
                    this.refresh();
                })
                // eslint-disable-next-line @typescript-eslint/no-empty-function
                .catch(() => {});
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

    counts() {
        const room = this._rooms.get(this._room || '');
        const same = room ? room.size : 0;
        let other = 0;
        for (const [name, users] of this._rooms) {
            if (name !== this._room) {
                other += users.size;
            }
        }
        return { same, other };
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
                return [];
            }

            const items: CollabItem[] = [];
            for (const id of room) {
                let item = this._items.get(id);
                if (!item) {
                    const [err, user] = await tryCatch(this._rest.user(id));
                    if (err) {
                        continue;
                    }
                    const [err2, buf] = await tryCatch(this._rest.userThumb(user.id));
                    if (err2) {
                        continue;
                    }
                    const base64 = buffer.toBase64(new Uint8Array(buf));
                    const iconUri = vscode.Uri.parse(`data:image/png;base64,${base64}`);
                    item = new CollabItem(user.username, iconUri);
                    this._items.set(id, item);
                }

                items.push(item);
            }
            return items.sort((a, b) => a.username.localeCompare(b.username));
        }

        return [];
    }

    async link({ folderUri, projectManager }: { folderUri: vscode.Uri; projectManager: ProjectManager }) {
        if (this._folderUri !== undefined) {
            throw this.error.set(() => new Error('manager already linked'));
        }

        const unwatchDocument = this._watchDocument(folderUri, projectManager);

        this._cleanup.push(async () => {
            unwatchDocument();

            this._room = undefined;
        });

        this._folderUri = folderUri;
        this._projectManager = projectManager;

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
        this._log.info(`unlinked from ${folderUri.toString()}`);
        return { folderUri, projectManager };
    }
}

export { CollabProvider };
