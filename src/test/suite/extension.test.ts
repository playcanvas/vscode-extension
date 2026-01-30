import * as assert from 'assert';

import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as authModule from '../../auth';
import { NAME, PUBLISHER } from '../../config';
import * as messengerModule from '../../connections/messenger';
import * as relayModule from '../../connections/relay';
import * as restModule from '../../connections/rest';
import * as sharedbModule from '../../connections/sharedb';
import * as uriHandlerModule from '../../handlers/uri-handler';
import type { Asset } from '../../typings/models';
import * as buffer from '../../utils/buffer';
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

// stub warning message for collision dialogs
const warningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

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
        assert.ok(doc, `sharedb subscription for ${key} should exist`);
        const ops = expected.slice();
        const onop = (args: unknown) => {
            const op = args as unknown[];
            const expectedOp = ops.shift();
            assert.deepStrictEqual(expectedOp, op, `op should match expected for ${key}`);
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
        const extension = vscode.extensions.getExtension(`${PUBLISHER}.${NAME}`);
        assert.ok(extension, 'extension should be found');

        // activate the extension
        await assertResolves(extension.activate(), 'extension.activate');

        // check if extension is active
        assert.ok(extension.isActive, 'extension should be active');
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
        assert.ok(folderUri, 'workspace folder should exist');

        // watch for file creation
        let uri: vscode.Uri;
        if (parent) {
            const parentAsset = assets.get(parent);
            assert.ok(parentAsset, `parent asset ${parent} should exist`);
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
        assert.ok(asset, `asset ${res.uniqueId} should exist`);
        return asset;
    };

    // NOTE: file path is set in MockUriHandler instance above
    test('project load (with file path)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // check if sharedb subscribe was called for project settings
        const call1 = sharedb.subscribe.getCall(0);
        assert.ok(call1, 'sharedb.subscribe should have been called');
        assert.deepStrictEqual(
            call1.args,
            ['settings', `project_${project.id}_${user.id}`],
            'subscribe args should match'
        );

        // check if document was opened
        const asset = assets.get(1);
        assert.ok(asset, 'asset 1 should exist');
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const call2 = openTextDocumentSpy.getCall(0);
        assert.ok(call2, 'openTextDocument should have been called');
        assert.strictEqual(call2.args[0]?.toString(), uri.toString(), 'opened document uri should match');
    });

    test(`command ${NAME}.openProject`, async () => {
        // open a project
        await assertResolves(vscode.commands.executeCommand(`${NAME}.openProject`), `${NAME}.openProject`);

        // check if quick pick was shown
        assert.ok(quickPickStub.called, 'quick pick should have been shown');

        // check if open folder was called
        assert.ok(openFolderStub.called, 'open folder should have been called');
    });

    test(`command ${NAME}.switchBranch`, async () => {
        // reset rest branchCheckout spy call history
        rest.branchCheckout.resetHistory();

        // switch branch
        await assertResolves(vscode.commands.executeCommand(`${NAME}.switchBranch`), `${NAME}.switchBranch`);

        // check if quick pick was shown
        assert.ok(quickPickStub.called, 'quick pick should have been shown');

        // check if branch checkout was called
        const other = branches.get('other');
        assert.ok(other, 'other branch should exist');
        const call = rest.branchCheckout.getCall(0);
        assert.deepStrictEqual(call.args, [other.id], 'branchCheckout args should match');
    });

    test(`command ${NAME}.showCollidingAssets`, async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create first asset
        const name = 'show_skipped_test.js';
        const document = `console.log('first file');\n`;
        const asset1 = await assetCreate({ name, content: document });
        assert.ok(asset1, 'first asset should be created');

        // add second asset with same name (simulating remote collision)
        const id = uniqueId.next().value;
        const document2 = `console.log('second file');\n`;
        const asset2: Asset = {
            uniqueId: id,
            item_id: `${id}`,
            file: {
                filename: `${name}.js`,
                hash: hash(document2)
            },
            path: [],
            name: name,
            type: 'script'
        };
        assets.set(asset2.uniqueId, asset2);
        documents.set(asset2.uniqueId, document2);

        // create promise for asset processing
        const assetProcessed = new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
        });

        // fire messenger event for second asset
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: asset2.item_id,
                    name: asset2.name,
                    type: asset2.type,
                    branchId: projectSettings.branch
                }
            }
        });

        await assertResolves(assetProcessed, 'asset.new processing');

        // reset quick pick stub
        quickPickStub.resetHistory();

        // execute showSkippedAssets command
        await assertResolves(
            vscode.commands.executeCommand(`${NAME}.showCollidingAssets`),
            `${NAME}.showCollidingAssets`
        );

        // check if quick pick was shown
        assert.ok(quickPickStub.called, 'quick pick should have been shown for skipped assets');

        // verify the quick pick contains collision info
        const quickPickCall = quickPickStub.getCall(0);
        const items = (await quickPickCall.args[0]) as vscode.QuickPickItem[];
        assert.ok(items.length > 0, 'quick pick should have at least one item');

        // check that one of the items is our collided asset
        const collisionItem = items.find((item) => item.label === name || item.description?.includes(`${id}`));
        assert.ok(collisionItem, 'quick pick should contain the collided asset');
    });

    test('uri open file', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'uri_open_file.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

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
            authority: `${PUBLISHER}.${NAME}`,
            path: `/project/${project.id}/asset/${asset.uniqueId}`
        });
        await vscode.env.openExternal(externalUri);

        // check if document was opened
        await assertResolves(openTextDocument, 'openTextDocument');

        // check if uri handler was called
        const call = uriHandler.handleUri.getCall(0);
        assert.strictEqual(call.args[0].toString(), externalUri.toString(), 'uri handler args should match');
    });

    test('uri open collision file shows warning', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create first asset
        const name = 'uri_collision_test.js';
        const document = `console.log('first file');\n`;
        const asset1 = await assetCreate({ name, content: document });
        assert.ok(asset1, 'first asset should be created');

        // add second asset with same name (simulating remote collision)
        const id = uniqueId.next().value;
        const document2 = `console.log('second file');\n`;
        const asset2: Asset = {
            uniqueId: id,
            item_id: `${id}`,
            file: {
                filename: `${name}.js`,
                hash: hash(document2)
            },
            path: [],
            name: name,
            type: 'script'
        };
        assets.set(asset2.uniqueId, asset2);
        documents.set(asset2.uniqueId, document2);

        // create promise for asset processing
        const assetProcessed = new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
        });

        // fire messenger event for second asset
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: asset2.item_id,
                    name: asset2.name,
                    type: asset2.type,
                    branchId: projectSettings.branch
                }
            }
        });

        await assertResolves(assetProcessed, 'asset.new processing');

        // reset warning message stub and open text document spy
        warningMessageStub.resetHistory();
        openTextDocumentSpy.resetHistory();

        // try to open the collided asset via uri handler
        const externalUri = vscode.Uri.from({
            scheme: vscode.env.uriScheme,
            authority: `${PUBLISHER}.${NAME}`,
            path: `/project/${project.id}/asset/${id}` // use the collided asset's id
        });
        await vscode.env.openExternal(externalUri);

        // give time for uri handler to process
        await new Promise((resolve) => setTimeout(resolve, 200));

        // check if warning dialog was shown for collision
        assert.ok(
            warningMessageStub.called,
            'warning dialog should have been shown when trying to open collided asset'
        );

        // verify the warning mentions the collision
        const warningCall = warningMessageStub.getCall(0);
        if (warningCall) {
            const message = warningCall.args[0] as string;
            assert.ok(
                message.includes('collision') || message.includes('conflicting') || message.includes('Cannot open'),
                'warning message should mention collision or conflicting paths'
            );
        }
    });

    test('file create (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

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
        assert.strictEqual(buffer.toString(content), document, 'file content should match');
    });

    test('file create (local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

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
        await assertResolves(vscode.workspace.fs.writeFile(uri, buffer.from(document)), 'fs.writeFile');

        // wait for remote creation to be detected
        await assertResolves(created, 'asset.new');

        // check if rest assetCreate was called with correct parameters
        const call = rest.assetCreate.getCall(0);
        assert.deepStrictEqual(
            call.args,
            [
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
            ],
            'assetCreate args should match'
        );
    });

    test('file create (fast create local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

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
            return assertResolves(vscode.workspace.fs.writeFile(uri, buffer.from(file.content)), 'fs.writeFile');
        });
        await Promise.all(writes);

        // wait for remote creation to be detected
        await assertResolves(created, 'asset.new');

        // check if rest assetCreate was called with correct parameters
        const calls = rest.assetCreate.getCalls();
        assert.strictEqual(calls.length, files.length, 'assetCreate should be called for each file');
        for (let i = 0; i < files.length; i++) {
            const call = calls[i];
            assert.deepStrictEqual(
                call.args,
                [
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
                ],
                `assetCreate args should match for file ${i}`
            );
        }
    });

    test('folder create (nested structure local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

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
        await vscode.workspace.fs.writeFile(fileUri, buffer.from(fileContent));

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
        assert.ok(folderUri, 'workspace folder should exist');

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
            vscode.workspace.fs.writeFile(vscode.Uri.joinPath(siblingAUri, fileA), buffer.from(fileContent)),
            vscode.workspace.fs.writeFile(vscode.Uri.joinPath(siblingBUri, fileB), buffer.from(fileContent))
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
            `parent should be created before sibling A. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            parentIndex < siblingBIndex,
            `parent should be created before sibling B. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            siblingAIndex < fileAIndex,
            `sibling A should be created before its file. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            siblingBIndex < fileBIndex,
            `sibling B should be created before its file. Order: ${creationOrder.join(' -> ')}`
        );

        // verify all 5 assets were created
        assert.strictEqual(creationOrder.length, 5, 'all 5 assets should be created');
    });

    test('folder create (similar names independent local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

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
            `parent should be created before A. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            parentIndex < folderABIndex,
            `parent should be created before AB. Order: ${creationOrder.join(' -> ')}`
        );

        // verify all 3 assets were created (proves neither blocked the other indefinitely)
        assert.strictEqual(creationOrder.length, 3, 'all 3 assets should be created');

        // verify A and AB are both in the order (they can be in any order relative to each other)
        assert.ok(folderAIndex !== -1, 'folder A should be created');
        assert.ok(folderABIndex !== -1, 'folder AB should be created');
    });

    test('file changes (opened remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_opened_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

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
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp([0, '// REMOTE COMMENT\n'], { source: 'remote' });
        const newDocument = `// REMOTE COMMENT\n${document}`;

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');

        // check text document was updated
        await assertResolves(changed, 'vscode.onDidChangeTextDocument');
        assert.strictEqual(tdoc.getText(), newDocument, 'text document content should match');

        // check if local file was changed
        await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(buffer.toString(content), newDocument, 'file content should match');
    });

    test('file changes (closed remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_closed_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

        // create update promise
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [[0, '// REMOTE COMMENT\n']]);

        // create change watcher
        const watcher = watchFilePromise(folderUri, asset.name, 'change');

        // make remote change
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp([0, '// REMOTE COMMENT\n'], { source: 'remote' });

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');

        // check if local file was changed
        const uri = await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(buffer.toString(content), `// REMOTE COMMENT\n${document}`, 'file content should match');
    });

    test('file changes (opened local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_opened_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

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
        assert.strictEqual(tdoc.getText(), newDocument, 'text document content should match');

        // wait for local change to be detected (debounced disk sync)
        await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(buffer.toString(content), newDocument, 'file content should match');
    });

    test('file changes (closed local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create asset
        const asset = await assetCreate({ name: 'change_closed_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');

        // get document content
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // create update promise
        const newContent = `// CLOSED LOCAL TEST COMMENT\n${document}`;
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [0, { d: document.length }], // delete existing content
            [0, newContent] // add new content
        ]);

        // make local change by writing to the file directly
        await vscode.workspace.fs.writeFile(uri, buffer.from(newContent));

        // wait for remote update to be detected
        await assertResolves(updated, 'sharedb.op');
    });

    test('file save (local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'save_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

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
        assert.deepStrictEqual(call.args, [`doc:save:${asset.uniqueId}`], 'sendRaw args should match');
    });

    test('file save (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'save_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

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
            const disposable = vscode.workspace.onDidSaveTextDocument((document) => {
                if (document.uri.toString() === uri.toString()) {
                    disposable.dispose();
                    resolve();
                }
            });
        });

        // make remote save
        assert.ok(asset.file, 'asset.file should exist');
        const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb asset document should exist');
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

    test('file save empty (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'save_empty_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // open document and show it in editor
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        // watch for file change (debounced sync will write empty content)
        const diskSynced = watchFilePromise(folderUri, asset.name, 'change');

        // clear all content to make document empty
        const edit = new vscode.WorkspaceEdit();
        edit.delete(uri, new vscode.Range(0, 0, tdoc.lineCount, 0));
        await vscode.workspace.applyEdit(edit);

        // verify document is now empty and dirty
        assert.strictEqual(tdoc.getText(), '', 'document should be empty');
        assert.strictEqual(tdoc.isDirty, true, 'document should be dirty before save');

        // wait for debounced sync to write empty content to disk
        await assertResolves(diskSynced, 'watcher.change');

        // create promise that resolves when document becomes not dirty (revert completed)
        const reverted = new Promise<void>((resolve) => {
            if (!tdoc.isDirty) {
                resolve();
                return;
            }
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && !e.document.isDirty) {
                    disposable.dispose();
                    resolve();
                }
            });
        });

        // make remote save (this should trigger revert for empty files)
        assert.ok(asset.file, 'asset.file should exist');
        const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb asset document should exist');
        const newHash = hash('');
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
        documents.set(asset.uniqueId, '');

        // wait for revert to complete (document becomes not dirty)
        await assertResolves(reverted, 'document.revert');

        // verify document is no longer dirty (revert cleared it)
        assert.strictEqual(tdoc.isDirty, false, 'document should not be dirty after remote save');

        // verify file content on disk is empty
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(buffer.toString(content), '', 'file content should be empty');
    });

    test('file delete (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create asset
        const asset = await assetCreate({ name: 'delete_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');

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
        assert.ok(uri, 'deleted uri should exist');
    });

    test('file delete (local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create asset
        const asset = await assetCreate({ name: 'delete_local_remote.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');

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
        assert.deepStrictEqual(
            call.args,
            [
                `fs${JSON.stringify({
                    op: 'delete',
                    ids: [asset.uniqueId]
                })}`
            ],
            'sendRaw delete args should match'
        );
    });

    test('file rename (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

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
        assert.ok(doc, 'sharedb asset document should exist');
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
        assert.ok(deletedUri, 'deleted uri should exist');
        const createdUri = await assertResolves(createWatcher, 'watcher.create');
        assert.ok(createdUri, 'created uri should exist');

        // check new file content
        const content = await assertResolves(vscode.workspace.fs.readFile(createdUri), 'fs.readFile');
        assert.ok(document, 'document should exist');
        assert.strictEqual(buffer.toString(content), document, 'file content should match');
    });

    test('file rename (local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

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
        assert.deepStrictEqual(
            call.args,
            [project.id, projectSettings.branch, asset.uniqueId, newName],
            'assetRename args should match'
        );
    });

    test('file move (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get folder asset
        const folderAsset = Array.from(assets.values()).find((a) => a.type === 'folder');
        assert.ok(folderAsset, 'folder asset should exist');
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
        assert.ok(doc, 'sharedb asset document should exist');
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
        assert.ok(deletedUri, 'deleted uri should exist');
        const createdUri = await assertResolves(createWatcher, 'watcher.create');
        assert.ok(createdUri, 'created uri should exist');

        // check new file content
        const content = await assertResolves(vscode.workspace.fs.readFile(createdUri), 'fs.readFile');
        assert.strictEqual(buffer.toString(content), document, 'file content should match');
    });

    test('file move (local -> remote)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and folder
        const folderAsset = Array.from(assets.values()).find((a) => a.type === 'folder');
        assert.ok(folderAsset, 'folder asset should exist');
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
        assert.deepStrictEqual(
            call.args,
            [
                `fs${JSON.stringify({
                    op: 'move',
                    ids: [asset.uniqueId],
                    to: 0
                })}`
            ],
            'sendRaw move args should match'
        );

        // check content of renamed file
        const content = await assertResolves(vscode.workspace.fs.readFile(newUri), 'fs.readFile');
        assert.strictEqual(buffer.toString(content), document, 'file content should match');
    });

    test('.pcignore parsing (file)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create .pcignore file
        const ignoreContent = `ignored*.js\n`;
        const ignoreUri = vscode.Uri.joinPath(folderUri, '.pcignore');
        await assertResolves(vscode.workspace.fs.writeFile(ignoreUri, buffer.from(ignoreContent)), 'fs.writeFile');

        // create file to be ignored
        const watcher = watchFilePromise(folderUri, 'ignored_file.js', 'create');
        const ignoredFileUri = vscode.Uri.joinPath(folderUri, 'ignored_file.js');
        await assertResolves(
            vscode.workspace.fs.writeFile(ignoredFileUri, buffer.from('// IGNORED FILE')),
            'fs.writeFile'
        );
        await assertResolves(watcher, 'watcher.create');

        // check ignored file and folder do not exist as assets
        const ignoredFileAsset = Array.from(assets.values()).find((a) => a.name === 'ignored_file.js');
        assert.strictEqual(ignoredFileAsset, undefined, 'ignored file should not exist as asset');
    });

    test('file path collision (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create first asset
        const name = 'collision_test.js';
        const document = `console.log('first file');\n`;
        const asset1 = await assetCreate({ name, content: document });
        assert.ok(asset1, 'first asset should be created');

        // reset warning message stub
        warningMessageStub.resetHistory();

        // add second asset with same name (simulating remote collision)
        const id = uniqueId.next().value;
        const document2 = `console.log('second file');\n`;
        const asset2: Asset = {
            uniqueId: id,
            item_id: `${id}`,
            file: {
                filename: `${name}.js`,
                hash: hash(document2)
            },
            path: [],
            name: name,
            type: 'script'
        };
        assets.set(asset2.uniqueId, asset2);
        documents.set(asset2.uniqueId, document2);

        // create promise that resolves after asset.new event is processed
        const assetProcessed = new Promise<void>((resolve) => {
            // give time for collision detection to complete
            setTimeout(resolve, 100);
        });

        // fire messenger event for second asset with same name
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: asset2.item_id,
                    name: asset2.name,
                    type: asset2.type,
                    branchId: projectSettings.branch
                }
            }
        });

        // wait for asset processing
        await assertResolves(assetProcessed, 'asset.new processing');

        // check if warning dialog was shown
        assert.ok(warningMessageStub.called, 'warning dialog should have been shown for collision');

        // verify the warning message mentions collision
        const warningCall = warningMessageStub.getCall(0);
        assert.ok(warningCall, 'warning message should have been called');
        const message = warningCall.args[0] as string;
        assert.ok(
            message.includes('collision') || message.includes('Skipped'),
            'warning message should mention collision or skipped'
        );
    });

    test('folder collision causes children to be skipped (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create first folder
        const folderName = 'collision_folder';
        const watcher = watchFilePromise(folderUri, folderName, 'create');

        // create folder asset via rest
        await assertResolves(
            rest.assetCreate(project.id, projectSettings.branch, {
                type: 'folder',
                name: folderName,
                preload: false
            }),
            'rest.assetCreate folder'
        );
        await assertResolves(watcher, 'watcher.create folder');

        // reset warning message stub
        warningMessageStub.resetHistory();

        // add second folder with same name (simulating remote collision)
        const folderId = uniqueId.next().value;
        const folder2: Asset = {
            uniqueId: folderId,
            item_id: `${folderId}`,
            path: [],
            name: folderName,
            type: 'folder'
        };
        assets.set(folder2.uniqueId, folder2);

        // create promise for folder processing
        const folderProcessed = new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
        });

        // fire messenger event for second folder with same name
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: folder2.item_id,
                    name: folder2.name,
                    type: folder2.type,
                    branchId: projectSettings.branch
                }
            }
        });

        await assertResolves(folderProcessed, 'folder.new processing');

        // check if warning dialog was shown for folder collision
        assert.ok(warningMessageStub.called, 'warning dialog should have been shown for folder collision');

        // now add a child file to the collided folder
        warningMessageStub.resetHistory();
        const childId = uniqueId.next().value;
        const childAsset: Asset = {
            uniqueId: childId,
            item_id: `${childId}`,
            file: {
                filename: 'child.js.js',
                hash: hash('// child content')
            },
            path: [parseInt(folder2.item_id, 10)],
            name: 'child.js',
            type: 'script'
        };
        assets.set(childAsset.uniqueId, childAsset);
        documents.set(childAsset.uniqueId, '// child content');

        // create promise for child processing
        const childProcessed = new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
        });

        // fire messenger event for child
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: childAsset.item_id,
                    name: childAsset.name,
                    type: childAsset.type,
                    branchId: projectSettings.branch
                }
            }
        });

        await assertResolves(childProcessed, 'child.new processing');

        // child should also be skipped due to parent collision
        assert.ok(warningMessageStub.called, 'warning dialog should have been shown for child of collided folder');
    });

    test('collision on rename (remote -> local)', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create two assets with different names
        const name1 = 'rename_collision_target.js';
        const name2 = 'rename_collision_source.js';
        const document1 = `console.log('target file');\n`;
        const document2 = `console.log('source file');\n`;

        const asset1 = await assetCreate({ name: name1, content: document1 });
        assert.ok(asset1, 'target asset should be created');

        const asset2 = await assetCreate({ name: name2, content: document2 });
        assert.ok(asset2, 'source asset should be created');

        // reset warning message stub
        warningMessageStub.resetHistory();

        // watch for file deletion (source file gets removed when becoming collision)
        const deleteWatcher = watchFilePromise(folderUri, name2, 'delete');

        // make remote name change to cause collision
        const doc = sharedb.subscriptions.get(`assets:${asset2.uniqueId}`);
        assert.ok(doc, 'sharedb asset document should exist');
        doc.submitOp(
            [
                {
                    p: ['name'],
                    oi: name1 // rename to same name as asset1
                }
            ],
            { source: 'remote' }
        );

        // wait for file deletion (collision causes old file to be removed)
        await assertResolves(deleteWatcher, 'watcher.delete');

        // check if warning dialog was shown
        assert.ok(warningMessageStub.called, 'warning dialog should have been shown for rename collision');
    });

    test('collision removed on asset delete', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create first asset
        const name = 'delete_collision_test.js';
        const document = `console.log('first file');\n`;
        const asset1 = await assetCreate({ name, content: document });
        assert.ok(asset1, 'first asset should be created');

        // add second asset with same name (simulating remote collision)
        const id = uniqueId.next().value;
        const document2 = `console.log('second file');\n`;
        const asset2: Asset = {
            uniqueId: id,
            item_id: `${id}`,
            file: {
                filename: `${name}.js`,
                hash: hash(document2)
            },
            path: [],
            name: name,
            type: 'script'
        };
        assets.set(asset2.uniqueId, asset2);
        documents.set(asset2.uniqueId, document2);

        // create promise for asset processing
        const assetProcessed = new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
        });

        // fire messenger event for second asset (will be collision)
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: asset2.item_id,
                    name: asset2.name,
                    type: asset2.type,
                    branchId: projectSettings.branch
                }
            }
        });

        await assertResolves(assetProcessed, 'asset.new processing');

        // reset warning message stub
        warningMessageStub.resetHistory();

        // create delete processed promise
        const deleteProcessed = new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
        });

        // fire messenger event for deletion of collided asset
        messenger.emit('assets.delete', {
            data: {
                assets: [asset2.item_id]
            }
        });

        await assertResolves(deleteProcessed, 'assets.delete processing');

        // manually clean up the mock assets map to simulate remote state
        assets.delete(asset2.uniqueId);
        documents.delete(asset2.uniqueId);

        // reset quick pick stub and check if showSkippedAssets no longer shows this collision
        quickPickStub.resetHistory();

        // execute showSkippedAssets command - should not show the deleted collision
        await assertResolves(
            vscode.commands.executeCommand(`${NAME}.showCollidingAssets`),
            `${NAME}.showCollidingAssets`
        );

        // if quick pick was called, verify our deleted collision is not in the list
        if (quickPickStub.called) {
            const quickPickCall = quickPickStub.getCall(0);
            const items = (await quickPickCall.args[0]) as vscode.QuickPickItem[];
            const deletedCollisionItem = items.find((item) => item.description?.includes(`${id}`));
            assert.strictEqual(
                deletedCollisionItem,
                undefined,
                'deleted collision should not appear in skipped assets'
            );
        }
    });
});
