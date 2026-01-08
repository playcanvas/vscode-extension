import * as assert from 'assert';

import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as authModule from '../../auth';
import * as messengerModule from '../../connections/messenger';
import * as relayModule from '../../connections/relay';
import * as restModule from '../../connections/rest';
import * as sharedbModule from '../../connections/sharedb';
import * as uriHandlerModule from '../../handlers/uri-handler';
import type { Asset } from '../../typings/models';
import { hash } from '../../utils/utils';
import { MockAuth } from '../mocks/auth';
import { MockMessenger } from '../mocks/messenger';
import { assets, documents, branches, projectSettings, project, user, uniqueId } from '../mocks/models';
import { MockRelay } from '../mocks/relay';
import { MockRest } from '../mocks/rest';
import { MockShareDb } from '../mocks/sharedb';
import { MockUriHandler } from '../mocks/uri-handler';

const sandbox = sinon.createSandbox();

// mock connection classes
const auth = new MockAuth(sandbox);
const messenger = new MockMessenger(sandbox);
const sharedb = new MockShareDb(sandbox, messenger);
const relay = new MockRelay(sandbox);
const rest = new MockRest(sandbox, messenger, sharedb);
const uriHandler = new MockUriHandler(sandbox, rest);

// stub connection class constructors
sandbox.stub(authModule, 'Auth').returns(auth);
sandbox.stub(restModule, 'Rest').returns(rest);
sandbox.stub(sharedbModule, 'ShareDb').returns(sharedb);
sandbox.stub(messengerModule, 'Messenger').returns(messenger);
sandbox.stub(relayModule, 'Relay').returns(relay);
sandbox.stub(uriHandlerModule, 'UriHandler').returns(uriHandler);

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

// spy vscode methods
const openTextDocumentSpy = sandbox.spy(vscode.workspace, 'openTextDocument');

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

    setup(async () => {
        // get extension
        const extension = vscode.extensions.getExtension('playcanvas.playcanvas');
        assert.ok(extension);

        // activate the extension
        await assertResolves(extension.activate(), 'extension.activate');

        // check if extension is active
        assert.ok(extension.isActive);
    });

    // FIXME: increase teardown delay to improve stability in CI environment
    if (process.env.CI) {
        teardown(async () => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
        });
    }

    teardown(() => {
        // reset stubs and spies after each test
        sandbox.resetHistory();
    });

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

    // NOTE: file path is set in MockUriHandler instance above
    test('project load (with file path)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // check if sharedb subscribe was called for project settings
        const call1 = sharedb.subscribe.getCall(0);
        assert.ok(call1);
        assert.deepStrictEqual(call1.args, ['settings', `project_${project.id}_${user.id}`]);

        // check if document was opened
        const asset = assets.get(1);
        assert.ok(asset);
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const call2 = openTextDocumentSpy.getCall(0);
        assert.ok(call2);
        assert.strictEqual(call2.args[0]?.toString(), uri.toString());
    });

    test('command playcanvas.openProject', async () => {
        // open a project
        await assertResolves(vscode.commands.executeCommand('playcanvas.openProject'), 'playcanvas.openProject');

        // check if quick pick was shown
        assert.ok(quickPickStub.called);

        // check if open folder was called
        assert.ok(openFolderStub.called);
    });

    test('command playcanvas.switchBranch', async () => {
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

    test('uri open file', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and its document content
        const asset = await assetCreate({ name: 'uri_open_file.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // create open document promise
        const openTextDocument = new Promise<void>((resolve) => {
            const open = vscode.workspace.onDidOpenTextDocument((doc) => {
                if (doc.uri.toString() === uri.toString()) {
                    open.dispose();
                    resolve();
                }
            });
        });

        // open the file via uri
        const externalUri = vscode.Uri.from({
            scheme: vscode.env.uriScheme,
            authority: 'playcanvas.playcanvas',
            path: `/${project.name} (${project.id})/${asset.name}`
        });
        await vscode.env.openExternal(externalUri);

        // check if document was opened
        await assertResolves(openTextDocument, 'openTextDocument');

        // check if uri handler was called
        const call = uriHandler.handleUri.getCall(0);
        assert.strictEqual(call.args[0].toString(), externalUri.toString());
    });

    test('file create (remote -> local)', async () => {
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
                filename: `${name}.js`,
                hash: hash(document)
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

    test('file create (fast create local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create many local files
        const files = [
            { name: 'create_fast_local_remote_1.js', content: '// SAMPLE CONTENT' },
            { name: 'create_fast_local_remote_2.js', content: '// SAMPLE CONTENT' },
            { name: 'create_fast_local_remote_3.js', content: '// SAMPLE CONTENT' }
        ];

        // create created promise
        const created = new Promise<void>((resolve) => {
            let count = 3;
            const onnew = messenger.on('asset.new', (data) => {
                if (files.some((file) => data.data.asset.name === file.name)) {
                    count--;
                    if (count === 0) {
                        messenger.off('asset.new', onnew);
                        resolve();
                    }
                }
            });
        });

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        // write the files to disk
        const writes = files.map((file) => {
            const uri = vscode.Uri.joinPath(folderUri, file.name);
            return assertResolves(vscode.workspace.fs.writeFile(uri, Buffer.from(file.content)), 'fs.writeFile');
        });
        await Promise.all(writes);

        // wait for remote creation to be detected
        await assertResolves(created, 'asset.new');

        // check if rest assetCreate was called with correct parameters
        const calls = rest.assetCreate.getCalls();
        assert.strictEqual(calls.length, files.length);
        for (let i = 0; i < files.length; i++) {
            const call = calls[i];
            assert.deepStrictEqual(call.args, [
                project.id,
                projectSettings.branch,
                {
                    type: 'script',
                    name: files[i].name,
                    parent: undefined,
                    preload: true,
                    filename: `${files[i].name}.js`,
                    file: new Blob([files[i].content], { type: 'text/plain' })
                }
            ]);
        }
    });

    test('folder create (nested structure local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // define nested structure: parent folder, subfolder, and file
        const parentName = 'test_nested';
        const subfolderName = 'subfolder';
        const fileName = 'nested_file.js';
        const fileContent = '// NESTED FILE CONTENT';

        // track creation order
        const creationOrder: string[] = [];

        // create promise that resolves when all 3 assets are created
        const created = new Promise<void>((resolve) => {
            let count = 3;
            const onnew = messenger.on('asset.new', (data) => {
                const name = data.data.asset.name;
                if (name === parentName || name === subfolderName || name === fileName) {
                    creationOrder.push(name);
                    count--;
                    if (count === 0) {
                        messenger.off('asset.new', onnew);
                        resolve();
                    }
                }
            });
        });

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        // create nested structure by creating the deepest path
        // the dependency logic should ensure parent -> subfolder -> file order
        const parentUri = vscode.Uri.joinPath(folderUri, parentName);
        const subfolderUri = vscode.Uri.joinPath(parentUri, subfolderName);
        const fileUri = vscode.Uri.joinPath(subfolderUri, fileName);

        // create all at once (simulating fast file system operations)
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.createDirectory(subfolderUri);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent));

        // wait for all remote creations
        await assertResolves(created, 'asset.new');

        // verify creation order: parent must come before subfolder, subfolder before file
        const parentIndex = creationOrder.indexOf(parentName);
        const subfolderIndex = creationOrder.indexOf(subfolderName);
        const fileIndex = creationOrder.indexOf(fileName);

        assert.ok(
            parentIndex < subfolderIndex,
            `Parent folder should be created before subfolder. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            subfolderIndex < fileIndex,
            `Subfolder should be created before file. Order: ${creationOrder.join(' -> ')}`
        );
    });

    test('folder create (siblings in parallel local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // define sibling structure: parent with two child folders, each containing a file
        const parentName = 'test_siblings';
        const siblingA = 'sibling_A';
        const siblingB = 'sibling_B';
        const fileA = 'file_a.js';
        const fileB = 'file_b.js';
        const fileContent = '// SIBLING FILE CONTENT';

        // track creation order
        const creationOrder: string[] = [];

        // create promise that resolves when all 5 assets are created
        const created = new Promise<void>((resolve) => {
            let count = 5;
            const onnew = messenger.on('asset.new', (data) => {
                const name = data.data.asset.name;
                if ([parentName, siblingA, siblingB, fileA, fileB].includes(name)) {
                    creationOrder.push(name);
                    count--;
                    if (count === 0) {
                        messenger.off('asset.new', onnew);
                        resolve();
                    }
                }
            });
        });

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        // create parent first
        const parentUri = vscode.Uri.joinPath(folderUri, parentName);
        await vscode.workspace.fs.createDirectory(parentUri);

        // create both sibling folders and their files simultaneously
        const siblingAUri = vscode.Uri.joinPath(parentUri, siblingA);
        const siblingBUri = vscode.Uri.joinPath(parentUri, siblingB);

        await Promise.all([
            vscode.workspace.fs.createDirectory(siblingAUri),
            vscode.workspace.fs.createDirectory(siblingBUri)
        ]);

        await Promise.all([
            vscode.workspace.fs.writeFile(vscode.Uri.joinPath(siblingAUri, fileA), Buffer.from(fileContent)),
            vscode.workspace.fs.writeFile(vscode.Uri.joinPath(siblingBUri, fileB), Buffer.from(fileContent))
        ]);

        // wait for all remote creations
        await assertResolves(created, 'asset.new');

        // verify parent comes before both siblings
        const parentIndex = creationOrder.indexOf(parentName);
        const siblingAIndex = creationOrder.indexOf(siblingA);
        const siblingBIndex = creationOrder.indexOf(siblingB);
        const fileAIndex = creationOrder.indexOf(fileA);
        const fileBIndex = creationOrder.indexOf(fileB);

        assert.ok(
            parentIndex < siblingAIndex,
            `Parent should be created before sibling A. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            parentIndex < siblingBIndex,
            `Parent should be created before sibling B. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            siblingAIndex < fileAIndex,
            `Sibling A should be created before its file. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            siblingBIndex < fileBIndex,
            `Sibling B should be created before its file. Order: ${creationOrder.join(' -> ')}`
        );

        // verify all 5 assets were created
        assert.strictEqual(creationOrder.length, 5);
    });

    test('folder create (similar names independent local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // define similar named folders: A and AB (AB should NOT depend on A)
        const parentName = 'test_similar';
        const folderA = 'A';
        const folderAB = 'AB'; // similar prefix but NOT a child of A

        // track creation order
        const creationOrder: string[] = [];

        // create promise that resolves when all 3 assets are created
        const created = new Promise<void>((resolve) => {
            let count = 3;
            const onnew = messenger.on('asset.new', (data) => {
                const name = data.data.asset.name;
                if ([parentName, folderA, folderAB].includes(name)) {
                    creationOrder.push(name);
                    count--;
                    if (count === 0) {
                        messenger.off('asset.new', onnew);
                        resolve();
                    }
                }
            });
        });

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        // create parent first
        const parentUri = vscode.Uri.joinPath(folderUri, parentName);
        await vscode.workspace.fs.createDirectory(parentUri);

        // create A and AB simultaneously - they should NOT block each other
        const folderAUri = vscode.Uri.joinPath(parentUri, folderA);
        const folderABUri = vscode.Uri.joinPath(parentUri, folderAB);

        await Promise.all([
            vscode.workspace.fs.createDirectory(folderAUri),
            vscode.workspace.fs.createDirectory(folderABUri)
        ]);

        // wait for all remote creations
        await assertResolves(created, 'asset.new');

        // verify parent comes before both children
        const parentIndex = creationOrder.indexOf(parentName);
        const folderAIndex = creationOrder.indexOf(folderA);
        const folderABIndex = creationOrder.indexOf(folderAB);

        assert.ok(
            parentIndex < folderAIndex,
            `Parent should be created before A. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            parentIndex < folderABIndex,
            `Parent should be created before AB. Order: ${creationOrder.join(' -> ')}`
        );

        // verify all 3 assets were created (proves neither blocked the other indefinitely)
        assert.strictEqual(creationOrder.length, 3);

        // verify A and AB are both in the order (they can be in any order relative to each other)
        assert.ok(folderAIndex !== -1, 'Folder A should be created');
        assert.ok(folderABIndex !== -1, 'Folder AB should be created');
    });

    test('file changes (opened remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_opened_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // open text document
        const tdoc = await vscode.workspace.openTextDocument(uri);

        // create update promise
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [[0, '// REMOTE COMMENT\n']]);

        // create change promise
        const changed = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString()) {
                    disposable.dispose();
                    resolve();
                }
            });
        });

        // create change watcher
        const watcher = watchFilePromise(folderUri, asset.name, 'change');

        // make remote change
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc);
        doc.submitOp([0, '// REMOTE COMMENT\n'], { source: 'remote' });
        const newDocument = `// REMOTE COMMENT\n${document}`;

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');

        // check text document was updated
        await assertResolves(changed, 'vscode.onDidChangeTextDocument');
        assert.strictEqual(tdoc.getText(), newDocument);

        // check if local file was changed
        await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), newDocument);
    });

    test('file changes (closed remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_closed_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // create update promise
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [[0, '// REMOTE COMMENT\n']]);

        // create change watcher
        const watcher = watchFilePromise(folderUri, asset.name, 'change');

        // make remote change
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc);
        doc.submitOp([0, '// REMOTE COMMENT\n'], { source: 'remote' });

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');

        // check if local file was changed
        const uri = await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), `// REMOTE COMMENT\n${document}`);
    });

    test('file changes (opened local -> remote)', async () => {
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

        // open document
        const tdoc = await vscode.workspace.openTextDocument(uri);

        // create update promise
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [0, '// LOCAL TEST COMMENT\n'] // insert at start
        ]);

        // create change watcher
        const watcher = watchFilePromise(folderUri, asset.name, 'change');

        // make local change by editing the document
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL TEST COMMENT\n');
        await vscode.workspace.applyEdit(edit);
        const newDocument = `// LOCAL TEST COMMENT\n${document}`;

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');
        assert.strictEqual(tdoc.getText(), newDocument);

        // wait for local change to be detected (debounced disk sync)
        await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(Buffer.from(content).toString(), newDocument);
    });

    test('file changes (closed local -> remote)', async () => {
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

    test('file save (local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and its document content
        const asset = await assetCreate({ name: 'save_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // open document
        const tdoc = await vscode.workspace.openTextDocument(uri);

        // make local change by editing the document
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL TEST COMMENT\n');
        await vscode.workspace.applyEdit(edit);

        // reset sharedb ops spy call history
        sharedb.sendRaw.resetHistory();

        // save the document
        await tdoc.save();

        // check if sharedb sendRaw was called for document update
        const call = sharedb.sendRaw.getCall(0);
        assert.deepStrictEqual(call.args, [`doc:save:${asset.uniqueId}`]);
    });

    test('file save (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // get asset and its document content
        const asset = await assetCreate({ name: 'save_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset);
        const document = documents.get(asset.uniqueId);
        assert.ok(document);

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // open document
        await vscode.workspace.openTextDocument(uri);

        // make local change by editing the document
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL TEST COMMENT\n');
        await vscode.workspace.applyEdit(edit);

        // create save promise
        const saved = new Promise<void>((resolve) => {
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (document.uri.path === uri.path) {
                    resolve();
                }
            });
        });

        // make remote save
        assert.ok(asset.file);
        const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
        assert.ok(doc);
        const newContent = `// LOCAL TEST COMMENT\n${document}`;
        const newHash = hash(newContent);
        doc.submitOp(
            [
                {
                    p: ['file'],
                    od: {
                        filename: asset.file.filename,
                        hash: asset.file.hash
                    },
                    oi: {
                        filename: asset.file.filename,
                        hash: newHash
                    }
                }
            ],
            { source: 'remote' }
        );
        asset.file.hash = newHash;
        documents.set(asset.uniqueId, newContent);

        // wait for local file to be saved
        await assertResolves(saved, 'vscode.onDidSaveTextDocument');
    });

    test('file delete (remote -> local)', async () => {
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

    test('.pcignore parsing (file)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri);

        // create .pcignore file
        const ignoreContent = `ignored*.js\n`;
        const ignoreUri = vscode.Uri.joinPath(folderUri, '.pcignore');
        await assertResolves(vscode.workspace.fs.writeFile(ignoreUri, Buffer.from(ignoreContent)), 'fs.writeFile');

        // create file to be ignored
        const watcher = watchFilePromise(folderUri, 'ignored_file.js', 'create');
        const ignoredFileUri = vscode.Uri.joinPath(folderUri, 'ignored_file.js');
        await assertResolves(
            vscode.workspace.fs.writeFile(ignoredFileUri, Buffer.from('// IGNORED FILE')),
            'fs.writeFile'
        );
        await assertResolves(watcher, 'watcher.create');

        // check ignored file and folder do not exist as assets
        const ignoredFileAsset = Array.from(assets.values()).find((a) => a.name === 'ignored_file.js');
        assert.strictEqual(ignoredFileAsset, undefined);
    });
});
