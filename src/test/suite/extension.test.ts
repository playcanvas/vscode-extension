import * as assert from 'assert';

import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as authModule from '../../auth';
import * as messengerModule from '../../connections/messenger';
import * as relayModule from '../../connections/relay';
import * as restModule from '../../connections/rest';
import * as sharedbModule from '../../connections/sharedb';
import type { Asset } from '../../typings/models';
import { MockAuth } from '../mocks/auth';
import { MockMessenger } from '../mocks/messenger';
import { assets, documents, branches, projectSettings, project, user, uniqueId } from '../mocks/models';
import { MockRelay } from '../mocks/relay';
import { MockRest } from '../mocks/rest';
import { MockShareDb } from '../mocks/sharedb';

const sandbox = sinon.createSandbox();

// mock connection classes
const auth = new MockAuth(sandbox);
const messenger = new MockMessenger(sandbox);
const sharedb = new MockShareDb(sandbox, messenger);
const relay = new MockRelay(sandbox);
const rest = new MockRest(sandbox, messenger, sharedb);

// stub connection class constructors
sandbox.stub(authModule, 'Auth').returns(auth);
sandbox.stub(restModule, 'Rest').returns(rest);
sandbox.stub(sharedbModule, 'ShareDb').returns(sharedb);
sandbox.stub(messengerModule, 'Messenger').returns(messenger);
sandbox.stub(relayModule, 'Relay').returns(relay);

// stub vscode methods
const quickPickStub = sandbox
    .stub(vscode.window, 'showQuickPick')
    .callsFake(async (items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>) => {
        return (await items)[0];
    });
const openFolderStub = sandbox
    .stub(vscode.commands, 'executeCommand')
    .callThrough()
    .withArgs('vscode.openFolder', sandbox.match.any, false);

// FIXME: increase timeout to improve stability in CI environment
const assertResolves = async <T>(promise: PromiseLike<T>, name: string, timeout = process.env.CI ? 2000 : 1000) => {
    const timeoutId = setTimeout(() => {
        throw new Error(`${name} resolution exceeded timeout of ${timeout}ms`);
    }, timeout);
    const result = await promise;
    clearTimeout(timeoutId);
    return result;
};

const watchFilePromise = (folderUri: vscode.Uri, file: string, action: 'create' | 'change' | 'delete') => {
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folderUri, file),
        action !== 'create',
        action !== 'change',
        action !== 'delete'
    );
    return new Promise<vscode.Uri>((resolve) => {
        switch (action) {
            case 'create': {
                const disposable = watcher.onDidCreate((createdUri) => {
                    resolve(createdUri);
                    disposable.dispose();
                    watcher.dispose();
                });
                break;
            }
            case 'change': {
                const disposable = watcher.onDidChange((changedUri) => {
                    resolve(changedUri);
                    disposable.dispose();
                    watcher.dispose();
                });
                break;
            }
            case 'delete': {
                const disposable = watcher.onDidDelete((deletedUri) => {
                    resolve(deletedUri);
                    disposable.dispose();
                    watcher.dispose();
                });
                break;
            }
        }
    });
};

const assertOpsPromise = (key: string, expected: unknown[]) => {
    return new Promise<void>((resolve) => {
        const doc = sharedb.subscriptions.get(key);
        assert.ok(doc);
        const ops = expected.slice();
        const onop = (args: unknown) => {
            const op = args as unknown[];
            const expectedOp = ops.shift();
            assert.deepStrictEqual(expectedOp, op);
            if (ops.length === 0) {
                doc.off('op', onop);
                resolve();
            }
        };
        doc.on('op', onop);
    });
};

suite('Extension Test Suite', () => {
    suiteTeardown(async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (workspace) {
            // delete workspace folder after tests
            await vscode.workspace.fs.delete(workspace.uri, { recursive: true });
        }
    });

    // FIXME: increase teardown delay to improve stability in CI environment
    if (process.env.CI) {
        teardown(async () => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
        });
    }

    const assetCreate = async ({ name, content = '', parent }: { name: string; content?: string; parent?: number }) => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // watch for file creation
        let uri: vscode.Uri;
        if (parent) {
            const parentAsset = assets.get(parent);
            assert.ok(parentAsset);
            uri = vscode.Uri.joinPath(folderUri, parentAsset.name);
        } else {
            uri = folderUri;
        }
        const watcher = watchFilePromise(uri, name, 'create');

        // remote asset creation
        const res = await assertResolves(
            rest.assetCreate(project.id, projectSettings.branch, {
                type: 'script',
                name: name,
                parent: parent,
                preload: true,
                filename: `${name}.js`,
                file: new Blob([content], { type: 'text/plain' })
            }),
            'rest.assetCreate'
        );

        // wait for local file creation
        await assertResolves(watcher, 'watcher.create');

        // get created asset
        const asset = assets.get(res.uniqueId);
        assert.ok(asset);
        return asset;
    };

    test('project load', async () => {
        // get extension
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);

        // activate the extension
        await assertResolves(extension.activate(), 'extension.activate');

        // check if extension is active
        assert.ok(extension.isActive);

        // check first subscribe call is for project settings
        const call = sharedb.subscribe.getCall(0);
        assert.ok(call);
        assert.deepStrictEqual(call.args, ['settings', `project_${project.id}_${user.id}`]);
    });

    test('command playcanvas.openProject', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // open a project
        await assertResolves(vscode.commands.executeCommand('playcanvas.openProject'), 'playcanvas.openProject');

        // check if quick pick was shown
        assert.ok(quickPickStub.called);

        // check if open folder was called
        assert.ok(openFolderStub.called);
    });

    test('command playcanvas.switchBranch', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // reset rest branchCheckout spy call history
        rest.branchCheckout.resetHistory();

        // switch branch
        await assertResolves(vscode.commands.executeCommand('playcanvas.switchBranch'), 'playcanvas.switchBranch');

        // check if quick pick was shown
        assert.ok(quickPickStub.called);

        // check if branch checkout was called
        const other = branches.get('other');
        assert.ok(other);
        const call = rest.branchCheckout.getCall(0);
        assert.deepStrictEqual(call.args, [other.id]);
    });

    test('file create (remote -> local)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // add new asset to project
        const id = uniqueId.next().value;
        const name = 'create_remote_local.js';
        const document = `console.log('remote file');\n`;
        const asset: Asset = {
            uniqueId: id,
            item_id: `${id}`,
            file: {
                filename: `${name}.js`
            },
            path: [],
            name: name,
            type: 'script'
        };
        assets.set(asset.uniqueId, asset);
        documents.set(asset.uniqueId, document);

        // fire messenger event for asset creation
        const watcher = watchFilePromise(folderUri, asset.name, 'create');
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: asset.item_id,
                    name: asset.name,
                    type: asset.type,
                    branchId: projectSettings.branch
                }
            }
        });

        // check if local file was created
        const uri = await assertResolves(watcher, 'watcher.create');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), document);
    });

    test('file create (local -> remote)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create new local file
        const name = 'create_local_remote.js';
        const document = `console.log('local file');\n`;

        // create created promise
        const created = new Promise<void>((resolve) => {
            const onnew = messenger.on('asset.new', (data) => {
                if (data.data.asset.name === name) {
                    messenger.off('asset.new', onnew);
                    setTimeout(resolve, 0);
                }
            });
        });

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        // write the file to disk
        const uri = vscode.Uri.joinPath(folderUri, name);
        await assertResolves(vscode.workspace.fs.writeFile(uri, Buffer.from(document)), 'fs.writeFile');

        // wait for remote creation to be detected
        await assertResolves(created, 'asset.new');

        // check if rest assetCreate was called with correct parameters
        const call = rest.assetCreate.getCall(0);
        assert.deepStrictEqual(call.args, [
            project.id,
            projectSettings.branch,
            {
                type: 'script',
                name: name,
                parent: undefined,
                preload: true,
                filename: `${name}.js`,
                file: new Blob([document], { type: 'text/plain' })
            }
        ]);
    });

    test('file changes (remote -> local)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // make remote change
        const watcher = watchFilePromise(folderUri, asset.name, 'change');
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc);
        doc.submitOp([0, '// REMOTE COMMENT\n'], { source: 'remote' });

        // check if local file was changed
        const uri = await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), `// REMOTE COMMENT\n${document}`);
    });

    test('file changes (opened local -> remote)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_opened_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // create update promise
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [0, '// LOCAL TEST COMMENT\n'] // insert at start
        ]);

        // make local change by editing the document
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL TEST COMMENT\n');
        await vscode.workspace.applyEdit(edit);

        // save document to trigger remote update
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await tdoc.save();

        // wait for remote update to be detected
        await assertResolves(updated, 'sharedb.op');
    });

    test('file changes (closed local -> remote)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create asset
        const asset = await assetCreate({ name: 'change_closed_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);

        // get document content
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // create update promise
        const newContent = `// CLOSED LOCAL TEST COMMENT\n${document}`;
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [0, { d: document.length }], // delete existing content
            [0, newContent] // add new content
        ]);

        // make local change by writing to the file directly
        await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent));

        // wait for remote update to be detected
        await assertResolves(updated, 'sharedb.op');
    });

    // FIXME: fails as notification popup shows when override applied
    test('file changes (local overrides remote)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create asset
        const asset = await assetCreate({
            name: 'override_local_remote.js',
            content: '// 123456'
        });
        const insert = '789';
        assert.ok(asset);

        // get document content
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // create update promise
        const insertIndex = document.length;
        const updated1 = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [insertIndex, insert] // insert at end
        ]);

        // make local change by editing the document
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, insertIndex), insert);
        await vscode.workspace.applyEdit(edit);

        // open document
        await vscode.workspace.openTextDocument(uri);

        // wait for remote update to be detected
        await assertResolves(updated1, 'sharedb.op');

        // make remote change to remove extra characters
        const deleteCount = 3;
        const watcher = watchFilePromise(folderUri, asset.name, 'change');
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc);
        doc.submitOp([insertIndex - deleteCount, { d: insert.length + deleteCount }], { source: 'remote' });
        const documentRemote = document.slice(0, document.length - deleteCount);

        // check if local file was changed
        const changedUri = await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(changedUri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), documentRemote);

        // create update promise for override
        const updated2 = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [0, { d: documentRemote.length }], // delete remote change
            [0, `${document}${insert}`] // add local changes
        ]);

        // save the document to trigger override
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await tdoc.save();

        // check if remote override detected
        await assertResolves(updated2, 'sharedb.op');
    });

    test('file delete (remote -> local)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create asset
        const asset = await assetCreate({ name: 'delete_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);

        // watch for file deletion
        const watcher = watchFilePromise(folderUri, asset.name, 'delete');

        // fire messenger event for asset deletion
        messenger.emit('assets.delete', {
            data: {
                assets: [asset.item_id]
            }
        });

        // check if local file was deleted
        const uri = await assertResolves(watcher, 'watcher.delete');
        assert.ok(uri);
    });

    test('file delete (local -> remote)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create asset
        const asset = await assetCreate({ name: 'delete_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);

        // create delete promise
        const delete_ = new Promise<void>((resolve) => {
            const ondelete = messenger.on('assets.delete', (data) => {
                if (data.data.assets.includes(`${asset.uniqueId}`)) {
                    messenger.off('assets.delete', ondelete);
                    setTimeout(resolve, 0);
                }
            });
        });

        // reset sharedb sendRaw spy call history
        sharedb.sendRaw.resetHistory();

        // delete local file
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        await assertResolves(vscode.workspace.fs.delete(uri), 'fs.delete');

        // wait for delete to be processed
        await assertResolves(delete_, 'assets.delete');

        // check if sharedb sendRaw was called for asset deletion
        const call = sharedb.sendRaw.getCall(0);
        assert.deepStrictEqual(call.args, [
            `fs${JSON.stringify({
                op: 'delete',
                ids: [asset.uniqueId]
            })}`
        ]);
    });

    test('file rename (remote -> local)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create new asset
        const oldName = 'rename_remote_local.js';
        const newName = 'rename_remote_local_renamed.js';
        const document = `console.log('remote file');\n`;
        const asset = await assetCreate({ name: oldName, content: document });

        // watch for file rename (delete + create)
        const deleteWatcher = watchFilePromise(folderUri, asset.name, 'delete');
        const createWatcher = watchFilePromise(folderUri, newName, 'create');

        // make remote name change
        const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
        assert.ok(doc);
        doc.submitOp(
            [
                {
                    p: ['name'],
                    oi: newName
                }
            ],
            { source: 'remote' }
        );
        asset.name = newName;

        // check if local file was renamed
        const deletedUri = await assertResolves(deleteWatcher, 'watcher.delete');
        assert.ok(deletedUri);
        const createdUri = await assertResolves(createWatcher, 'watcher.create');
        assert.ok(createdUri);

        // check new file content
        const content = await assertResolves(vscode.workspace.fs.readFile(createdUri), 'fs.readFile');
        assert.ok(document);
        assert.strictEqual(Buffer.from(content).toString(), document);
    });

    test('file rename (local -> remote)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create new asset
        const oldName = 'rename_local_remote.js';
        const newName = 'rename_local_remote_renamed.js';
        const document = `console.log('local file');\n`;
        const asset = await assetCreate({ name: oldName, content: document });

        // create renamed promise
        const renamed = assertOpsPromise(`assets:${asset.uniqueId}`, [
            [{ p: ['name'], oi: newName }] // rename op
        ]);

        // reset rest assetRename spy call history
        rest.assetRename.resetHistory();

        // rename local file
        const oldUri = vscode.Uri.joinPath(folderUri, asset.name);
        const newUri = vscode.Uri.joinPath(folderUri, newName);
        await assertResolves(vscode.workspace.fs.rename(oldUri, newUri), 'fs.rename');

        // wait for remote rename to be detected
        await assertResolves(renamed, 'asset.rename');

        // check if asset rename was called
        const call = rest.assetRename.getCall(0);
        assert.deepStrictEqual(call.args, [project.id, projectSettings.branch, asset.uniqueId, newName]);
    });

    test('file move (remote -> local)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get folder asset
        const folderAsset = Array.from(assets.values()).find((a) => a.type === 'folder');
        assert.ok(folderAsset);
        const folderAssetId = parseInt(folderAsset.item_id, 10);

        // create new file
        const name = 'move_remote_local.js';
        const document = `console.log('move test');\n`;
        const asset = await assetCreate({ name, content: document });

        // watch for file rename (delete + create)
        const deleteWatcher = watchFilePromise(folderUri, asset.name, 'delete');
        const createWatcher = watchFilePromise(folderUri, `${folderAsset.name}/${asset.name}`, 'create');

        // make remote name change
        const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
        assert.ok(doc);
        doc.submitOp(
            [
                {
                    p: ['path'],
                    li: folderAssetId
                }
            ],
            { source: 'remote' }
        );
        asset.path = [folderAssetId];

        // check if local file was moved
        const deletedUri = await assertResolves(deleteWatcher, 'watcher.delete');
        assert.ok(deletedUri);
        const createdUri = await assertResolves(createWatcher, 'watcher.create');
        assert.ok(createdUri);

        // check new file content
        const content = await assertResolves(vscode.workspace.fs.readFile(createdUri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), document);
    });

    test('file move (local -> remote)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and folder
        const folderAsset = Array.from(assets.values()).find((a) => a.type === 'folder');
        assert.ok(folderAsset);
        const folderAssetId = parseInt(folderAsset.item_id, 10);

        // create new file
        const name = 'move_local_remote.js';
        const document = `console.log('move test');\n`;
        const asset = await assetCreate({ name, content: document, parent: folderAssetId });

        // create moved promise
        const moved = assertOpsPromise(`assets:${asset.uniqueId}`, [
            [{ p: ['path'], ld: folderAssetId }] // move op
        ]);

        // reset sharedb sendRaw spy call history
        sharedb.sendRaw.resetHistory();

        // rename local file
        const oldUri = vscode.Uri.joinPath(folderUri, folderAsset.name, asset.name);
        const newUri = vscode.Uri.joinPath(folderUri, asset.name);
        await assertResolves(vscode.workspace.fs.rename(oldUri, newUri), 'fs.rename');

        // wait for remote rename to be detected
        await assertResolves(moved, 'sharedb.op');

        // check if sharedb fs move was called
        const call = sharedb.sendRaw.getCall(0);
        assert.deepStrictEqual(call.args, [
            `fs${JSON.stringify({
                op: 'move',
                ids: [asset.uniqueId],
                to: 0
            })}`
        ]);

        // check content of renamed file
        const content = await assertResolves(vscode.workspace.fs.readFile(newUri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), document);
    });

    test('.pcignore parsing (file and folder)', async () => {
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);
        await assertResolves(extension.activate(), 'extension.activate');

        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create .pcignore file
        const ignoreContent = `ignored_file.js\nignored_folder/\n`;
        const ignoreUri = vscode.Uri.joinPath(folderUri, '.pcignore');
        await assertResolves(vscode.workspace.fs.writeFile(ignoreUri, Buffer.from(ignoreContent)), 'fs.writeFile');

        // create ignored file and folder
        const ignoredFileUri = vscode.Uri.joinPath(folderUri, 'ignored_file.js');
        const ignoredFolderUri = vscode.Uri.joinPath(folderUri, 'ignored_folder');
        const ignoredFolderFileUri = vscode.Uri.joinPath(ignoredFolderUri, 'file_in_ignored_folder.js');
        await assertResolves(
            vscode.workspace.fs.writeFile(ignoredFileUri, Buffer.from('// IGNORED FILE')),
            'fs.writeFile'
        );
        await assertResolves(vscode.workspace.fs.createDirectory(ignoredFolderUri), 'fs.createDirectory');
        await assertResolves(
            vscode.workspace.fs.writeFile(ignoredFolderFileUri, Buffer.from('// IGNORED FOLDER FILE')),
            'fs.writeFile'
        );

        // add regular file that should be created as asset
        const name = 'regular_file.js';
        const document = `console.log('regular file');\n`;

        // create created promises
        const createWatcher = watchFilePromise(folderUri, name, 'create');

        // remote asset creation
        const res = await assertResolves(
            rest.assetCreate(project.id, projectSettings.branch, {
                type: 'script',
                name: name,
                preload: true,
                filename: `${name}.js`,
                file: new Blob([document], { type: 'text/plain' })
            }),
            'rest.assetCreate'
        );

        // wait for local file creation
        await assertResolves(createWatcher, 'watcher.create');

        // check created asset
        const asset = assets.get(res.uniqueId);
        assert.ok(asset);
        assert.strictEqual(asset.name, name);

        // check ignored files do not exist as assets
        const ignoredFileAsset = Array.from(assets.values()).find((a) => a.name === 'ignored_file.js');
        assert.strictEqual(ignoredFileAsset, undefined);
        const ignoredFolderFileAsset = Array.from(assets.values()).find((a) => a.name === 'file_in_ignored_folder.js');
        assert.strictEqual(ignoredFolderFileAsset, undefined);
    });
});
