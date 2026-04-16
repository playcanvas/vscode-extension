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
import { hash, wait } from '../../utils/utils';
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

// stub info message for ignore update prompts
const infoMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

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

const waitForAsset = (name: string) => {
    const existing = Array.from(assets.values()).find((v) => v.name === name);
    if (existing) {
        // yield macrotask to let PM's async handler finish (subscribe + _addFile + asset:create)
        return new Promise<Asset>((resolve) => setTimeout(() => resolve(existing)));
    }
    return assertResolves(
        new Promise<Asset>((resolve) => {
            const handler = messenger.on('asset.new', ({ data }: { data: { asset: { name: string } } }) => {
                if (data.asset.name !== name) {
                    return;
                }
                messenger.off('asset.new', handler);
                // yield macrotask to let PM's async handler finish (subscribe + _addFile + asset:create)
                setTimeout(() => {
                    const a = Array.from(assets.values()).find((v) => v.name === name);
                    assert.ok(a, `asset ${name} should exist after asset.new`);
                    resolve(a);
                });
            });
        }),
        `waitForAsset(${name})`
    );
};

suite('extension', () => {
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

    teardown(async () => {
        sandbox.resetHistory();
        // settle deferred queue / mutex between tests
        await wait(process.env.CI ? 2000 : 50);
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
    test('project load - file path', async () => {
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

    test(`command ${NAME}.showPathCollisions`, async () => {
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

        // reset stubs
        warningMessageStub.resetHistory();
        quickPickStub.resetHistory();

        // set up warning stub to simulate clicking "Show Path Collisions" button
        warningMessageStub.resolves('Show Path Collisions' as unknown as vscode.MessageItem);

        // execute showPathCollisions command
        await assertResolves(
            vscode.commands.executeCommand(`${NAME}.showPathCollisions`),
            `${NAME}.showPathCollisions`
        );

        // check if warning message was shown
        assert.ok(warningMessageStub.called, 'warning message should have been shown');

        // verify the warning message shows correct collision count
        const warningCall = warningMessageStub.getCall(0);
        const message = warningCall.args[0] as string;
        assert.ok(message.includes('collision'), 'warning message should mention collision');

        // give time for the .then() callback to execute
        await wait(50);

        // check if quick pick was shown after clicking "Show Path Collisions"
        assert.ok(quickPickStub.called, 'quick pick should have been shown after clicking button');

        // verify the quick pick contains collision info
        const quickPickCall = quickPickStub.getCall(0);
        const quickPickOptions = quickPickCall.args[1] as { title: string };
        assert.ok(quickPickOptions.title.includes('Collision'), 'quick pick should have collision title');
    });

    test('uri open - file', async () => {
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

    test('uri open - collision warning', async () => {
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
        await wait(200);

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

    test('file create - remote to local', async () => {
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

    test('file create - local to remote', async () => {
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

    test('file create - fast local to remote', async () => {
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

    test('folder create - nested local to remote', async () => {
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

    test('folder create - siblings local to remote', async () => {
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

    test('folder create - similar names local to remote', async () => {
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

    test('folder create - copy tree local to remote', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // build a nested source structure outside the workspace so the watcher doesn't see it
        const tmpBase = vscode.Uri.file('/tmp/claude/race_test_src');
        try {
            await vscode.workspace.fs.delete(tmpBase, { recursive: true });
        } catch {
            // ignore if doesn't exist
        }
        const srcSub = vscode.Uri.joinPath(tmpBase, 'race_sub');
        await vscode.workspace.fs.createDirectory(srcSub);
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(srcSub, 'race_child.js'),
            buffer.from('// RACE CONDITION TEST')
        );

        // define expected asset names
        const topName = 'test_race_copy';
        const subfolderName = 'race_sub';
        const fileName = 'race_child.js';

        // track creation order
        const creationOrder: string[] = [];

        // create promise that resolves when all 3 assets are created
        const created = new Promise<void>((resolve) => {
            let count = 3;
            const onnew = messenger.on('asset.new', (data) => {
                const name = data.data.asset.name;
                if ([topName, subfolderName, fileName].includes(name)) {
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

        // copy entire tree into workspace in one operation
        // this fires watcher events for all files/folders at once, where event order is
        // not guaranteed by the OS — exercises the ancestor-ensure fix in disk.ts
        const targetUri = vscode.Uri.joinPath(folderUri, topName);
        await vscode.workspace.fs.copy(tmpBase, targetUri, { overwrite: true });

        // wait for all remote creations
        await assertResolves(created, 'asset.new');

        // verify creation order: parents must come before children regardless of event order
        const topIndex = creationOrder.indexOf(topName);
        const subIndex = creationOrder.indexOf(subfolderName);
        const fileIndex = creationOrder.indexOf(fileName);

        assert.ok(
            topIndex < subIndex,
            `Top folder should be created before subfolder. Order: ${creationOrder.join(' -> ')}`
        );
        assert.ok(
            subIndex < fileIndex,
            `Subfolder should be created before file. Order: ${creationOrder.join(' -> ')}`
        );

        // verify all 3 assets were created successfully (no missing-parent errors)
        assert.strictEqual(creationOrder.length, 3, 'all 3 assets should be created');
    });

    test('file change - open remote to local', async () => {
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
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [['// REMOTE COMMENT\n']]);

        // create change promise
        const changed = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString()) {
                    disposable.dispose();
                    resolve();
                }
            });
        });

        // make remote change
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp(['// REMOTE COMMENT\n'], { source: 'remote' });
        const newDocument = `// REMOTE COMMENT\n${document}`;

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');

        // check text document was updated
        await assertResolves(changed, 'vscode.onDidChangeTextDocument');
        assert.strictEqual(tdoc.getText(), newDocument, 'text document content should match');
    });

    test('file change - closed remote to local', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // get asset and its document content
        const asset = await assetCreate({ name: 'change_closed_remote_local.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

        // create update promise
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [['// REMOTE COMMENT\n']]);

        // create change watcher
        const watcher = watchFilePromise(folderUri, asset.name, 'change');

        // make remote change
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp(['// REMOTE COMMENT\n'], { source: 'remote' });

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');

        // check if local file was changed
        const uri = await assertResolves(watcher, 'watcher.change');
        const content = await assertResolves(vscode.workspace.fs.readFile(uri), 'fs.readFile');
        assert.strictEqual(buffer.toString(content), `// REMOTE COMMENT\n${document}`, 'file content should match');
    });

    test('file change - open local to remote', async () => {
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
            ['// LOCAL TEST COMMENT\n'] // insert at start
        ]);

        // make local change by editing the document
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL TEST COMMENT\n');
        await vscode.workspace.applyEdit(edit);
        const newDocument = `// LOCAL TEST COMMENT\n${document}`;

        // check if remote update was detected
        await assertResolves(updated, 'sharedb.op');
        assert.strictEqual(tdoc.getText(), newDocument, 'text document content should match');
    });

    test('file change - closed local to remote', async () => {
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
            [3, 'CLOSED LOCAL TEST COMMENT\n// '] // minimal diff insert at offset 3 (after common prefix "// ")
        ]);

        // make local change by writing to the file directly
        await vscode.workspace.fs.writeFile(uri, buffer.from(newContent));

        // wait for remote update to be detected
        await assertResolves(updated, 'sharedb.op');
    });

    test('file change - atomic write local to remote', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create asset
        const asset = await assetCreate({ name: 'atomic_write_closed.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // snapshot assetCreate call count after setup
        const createsBefore = rest.assetCreate.callCount;

        // create update promise — minimal diff: "SAMPLE CONTENT" -> "ATOMIC CONTENT"
        const newContent = '// ATOMIC CONTENT';
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [3, 'ATOMIC', { d: 6 }] // replace "SAMPLE" with "ATOMIC" at offset 3
        ]);

        // simulate atomic write: write temp file outside workspace, then rename over existing
        const tmpUri = vscode.Uri.file(`/tmp/claude/atomic_write_closed.js`);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file('/tmp/claude'));
        await vscode.workspace.fs.writeFile(tmpUri, buffer.from(newContent));
        await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });

        // wait for remote update to be detected
        await assertResolves(updated, 'sharedb.op');

        // verify no new asset was created (atomic write, not new asset)
        assert.strictEqual(rest.assetCreate.callCount, createsBefore, 'should not call assetCreate for atomic write');
    });

    test('file change - atomic write identical skip', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create asset
        const asset = await assetCreate({ name: 'atomic_write_noop.js', content: '// SAME CONTENT' });
        assert.ok(asset, 'asset should be created');

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // get sharedb doc to check submitOp
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp.resetHistory();

        // snapshot assetCreate call count after setup
        const createsBefore = rest.assetCreate.callCount;

        // simulate atomic write with identical content
        const tmpUri = vscode.Uri.file(`/tmp/claude/atomic_write_noop.js`);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file('/tmp/claude'));
        await vscode.workspace.fs.writeFile(tmpUri, buffer.from('// SAME CONTENT'));
        await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });

        // wait for deferred handler to process (10ms defer + margin)
        await wait(200);

        // verify no ops submitted (content unchanged)
        assert.strictEqual(doc.submitOp.callCount, 0, 'should not submit ops for identical content');

        // verify no new asset was created
        assert.strictEqual(rest.assetCreate.callCount, createsBefore, 'should not call assetCreate for atomic write');
    });

    test('file change - no auto-save on external', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create asset
        const asset = await assetCreate({ name: 'no_autosave_closed.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

        // get file uri
        const uri = vscode.Uri.joinPath(folderUri, asset.name);

        // create update promise
        const newContent = `// CLOSED NO SAVE\n${document}`;
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            [3, 'CLOSED NO SAVE\n// '] // minimal diff insert at offset 3 (after common prefix "// ")
        ]);

        // reset sendRaw history
        sharedb.sendRaw.resetHistory();

        // make external change by writing to file directly
        await vscode.workspace.fs.writeFile(uri, buffer.from(newContent));

        // wait for remote update to be detected
        await assertResolves(updated, 'sharedb.op');

        // wait for any deferred save to fire
        await wait(200);

        // verify no doc:save was sent (no auto-save on external change)
        const saveCalls = sharedb.sendRaw.getCalls().filter((c) => `${c.args[0]}`.startsWith('doc:save:'));
        assert.strictEqual(saveCalls.length, 0, 'should not send doc:save for external closed file change');
    });

    test('file change - open external dirties document', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'external_open_dirty.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const document = documents.get(asset.uniqueId);
        assert.ok(document, 'document should exist');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp.resetHistory();

        const newContent = `// OPEN EXTERNAL\n${document}`;
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [[3, 'OPEN EXTERNAL\n// ']]);
        const dirtied = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() !== uri.toString()) {
                    return;
                }
                if (tdoc.isDirty && tdoc.getText() === newContent) {
                    disposable.dispose();
                    resolve();
                }
            });
        });

        await vscode.workspace.fs.writeFile(uri, buffer.from(newContent));

        await assertResolves(updated, 'sharedb.op');
        await assertResolves(dirtied, 'document dirty after external open change');

        assert.strictEqual(doc.submitOp.callCount, 1, 'should submit one op for external open file change');
        assert.strictEqual(tdoc.isDirty, true, 'document should be dirty after external open file change');
    });

    test('file save - local to remote', async () => {
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

        const willsave = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onWillSaveTextDocument((e) => {
                if (e.document.uri.toString() !== uri.toString()) {
                    return;
                }
                disposable.dispose();
                const saveCalls = sharedb.sendRaw.getCalls().filter((c) => `${c.args[0]}`.startsWith('doc:save:'));
                assert.strictEqual(saveCalls.length, 0, 'should not send doc:save during onWillSave');
                resolve();
            });
        });
        const didsave = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidSaveTextDocument((document) => {
                if (document.uri.toString() !== uri.toString()) {
                    return;
                }
                disposable.dispose();
                resolve();
            });
        });

        // save the document
        await tdoc.save();
        await assertResolves(willsave, 'vscode.onWillSaveTextDocument');
        await assertResolves(didsave, 'vscode.onDidSaveTextDocument');

        // check if sharedb sendRaw was called for document update
        const saveCalls = sharedb.sendRaw.getCalls().filter((c) => `${c.args[0]}`.startsWith('doc:save:'));
        assert.strictEqual(saveCalls.length, 1, 'should send one doc:save after native save');
        const call = saveCalls[0];
        assert.deepStrictEqual(call.args, [`doc:save:${asset.uniqueId}`], 'sendRaw args should match');
    });

    test('file change - undo to saved state preserves OT sync', async () => {
        // regression: undo back to saved state was misclassified as discard,
        // silently dropping the OT op and corrupting subsequent edits

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'undo_ot_sync.js', content: '// ORIGINAL' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);
        await assertResolves(
            new Promise<void>((resolve) => {
                if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                    resolve();
                    return;
                }
                const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                    if (e.document.uri.toString() !== uri.toString()) {
                        return;
                    }
                    if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                        disposable.dispose();
                        resolve();
                    }
                });
            }),
            'initial document settle'
        );

        // edit and save to establish a saved baseline
        const edit1 = new vscode.WorkspaceEdit();
        edit1.insert(uri, new vscode.Position(0, 0), '// SAVED\n');
        await vscode.workspace.applyEdit(edit1);
        await tdoc.save();

        const saved = tdoc.getText();
        assert.strictEqual(saved, '// SAVED\n// ORIGINAL', 'saved content should match');

        // edit after save (line 1 to prevent UndoManager composing with SAVED)
        const edit2 = new vscode.WorkspaceEdit();
        edit2.insert(uri, new vscode.Position(1, 0), '// TEMP\n');
        await vscode.workspace.applyEdit(edit2);
        assert.strictEqual(tdoc.isDirty, true, 'should be dirty after edit');

        // undo back to saved state
        const undone = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && tdoc.getText() === saved) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        await vscode.commands.executeCommand('playcanvas.undo');
        await assertResolves(undone, 'undo change event');

        assert.strictEqual(tdoc.getText(), saved, 'buffer should match saved content after undo');

        // edit again — this must apply against correct OT base
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            ['// FINAL\n'] // insert at start
        ]);
        const edit3 = new vscode.WorkspaceEdit();
        edit3.insert(uri, new vscode.Position(0, 0), '// FINAL\n');
        await vscode.workspace.applyEdit(edit3);
        await assertResolves(updated, 'sharedb.op after undo');

        // verify OT doc has correct content (no corruption)
        const expected = `// FINAL\n${saved}`;
        assert.strictEqual(tdoc.getText(), expected, 'buffer should have final edit');
        assert.strictEqual(documents.get(asset.uniqueId), expected, 'OT doc should match buffer (no corruption)');

        // final save should persist the same content without divergence
        sharedb.sendRaw.resetHistory();
        await tdoc.save();

        const saveCalls = sharedb.sendRaw.getCalls().filter((c) => `${c.args[0]}`.startsWith('doc:save:'));
        assert.strictEqual(saveCalls.length, 1, 'should send one doc:save for final save');
        assert.deepStrictEqual(saveCalls[0].args, [`doc:save:${asset.uniqueId}`], 'final save args should match');
        assert.strictEqual(documents.get(asset.uniqueId), expected, 'saved OT doc should still match buffer');
    });

    test('file save - remote to local', async () => {
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
        const tdoc = await vscode.workspace.openTextDocument(uri);

        // make local change and wait for it to propagate
        const changed = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString()) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL TEST COMMENT\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(changed, 'vscode.onDidChangeTextDocument');

        // make remote save (hash confirms local content matches S3)
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

        // document stays dirty (user must manually save)
        assert.strictEqual(tdoc.isDirty, true, 'document should stay dirty after remote save');
    });

    test('file save - empty remote to local', async () => {
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

        // clear all content to make document empty
        const edit = new vscode.WorkspaceEdit();
        edit.delete(uri, new vscode.Range(0, 0, tdoc.lineCount, 0));
        await vscode.workspace.applyEdit(edit);

        // verify document is now empty and dirty
        assert.strictEqual(tdoc.getText(), '', 'document should be empty');
        assert.strictEqual(tdoc.isDirty, true, 'document should be dirty before save');

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

    test('file save - doc save success', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create asset and open document
        const asset = await assetCreate({ name: 'save_docsave_success.js', content: '// SAMPLE CONTENT' });
        assert.ok(asset, 'asset should be created');
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        // make local edit (reliably makes isDirty = true)
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL EDIT\n');
        await vscode.workspace.applyEdit(edit);
        assert.strictEqual(tdoc.isDirty, true, 'document should be dirty after local edit');

        // simulate doc:save:success without hash change
        sharedb.sendRaw.resetHistory();
        sharedb.emit('doc:save', 'success', asset.uniqueId);

        // _save() is a no-op for open files — document stays dirty
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(tdoc.isDirty, true, 'document should stay dirty after doc:save:success');

        // verify no redundant server save was triggered
        const saveCalls = sharedb.sendRaw.getCalls().filter((c) => `${c.args[0]}`.startsWith('doc:save:'));
        assert.strictEqual(saveCalls.length, 0, 'should not send redundant doc:save to server');
    });

    test('file save - remote op reverts to s3 hash', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const content = '// REVERT TEST';
        const asset = await assetCreate({ name: 'revert_op_save.js', content });
        assert.ok(asset, 'asset should be created');
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');

        // remote op inserts text then reverts it (content returns to S3 hash)
        const insert = '// EXTRA\n';
        const changed = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && e.document.getText().startsWith(insert)) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        doc.submitOp([insert], { source: 'remote' });
        await assertResolves(changed, 'vscode.onDidChangeTextDocument');

        // revert op — hash matches S3 so asset:file:save fires
        const reverted = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && e.document.getText() === content) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        doc.submitOp([{ d: insert.length }], { source: 'remote' });

        await assertResolves(reverted, 'vscode.onDidChangeTextDocument');
        assert.strictEqual(tdoc.getText(), content, 'content should match original');
    });

    test('file delete - remote to local', async () => {
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

    test('file delete - local to remote', async () => {
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

    test('file rename - remote to local', async () => {
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

    test('file rename - local to remote', async () => {
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

    test('file move - remote to local', async () => {
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

    test('file move - local to remote', async () => {
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

    test('pcignore - parse file', async () => {
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

    test('pcignore - reparse on remote update', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        infoMessageStub.resetHistory();

        // wait for .pcignore asset (created async by previous test's deferred queue)
        const asset = await waitForAsset('.pcignore');

        // get sharedb document subscription
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, '.pcignore document subscription should exist');

        // append '*.txt\n' after current content
        const offset = (doc.data as string).length;
        const watcher = watchFilePromise(folderUri, '.pcignore', 'change');
        doc.submitOp([offset, '*.txt\n'], { source: 'remote' });
        await assertResolves(watcher, 'watcher.change');

        // assert reload prompt was shown
        assert.ok(infoMessageStub.calledOnce, 'info message should be shown once');
        const msg = infoMessageStub.getCall(0).args[0] as string;
        assert.ok(msg.includes('Ignore rules updated'), 'message should contain "Ignore rules updated"');

        // write a .txt file and verify it's ignored by the re-parsed rules
        const txtWatcher = watchFilePromise(folderUri, 'test_ignored.txt', 'create');
        const txtUri = vscode.Uri.joinPath(folderUri, 'test_ignored.txt');
        await assertResolves(vscode.workspace.fs.writeFile(txtUri, buffer.from('// IGNORED TXT')), 'fs.writeFile');
        await assertResolves(txtWatcher, 'watcher.create');

        // check no asset was created for the txt file
        const txtAsset = Array.from(assets.values()).find((a) => a.name === 'test_ignored.txt');
        assert.strictEqual(txtAsset, undefined, 'txt file should not exist as asset');
    });

    test('pcignore - path guard', async () => {
        infoMessageStub.resetHistory();

        // non-pcignore file triggers asset:file:create -> _checkIgnoreUpdated path guard
        const asset = await assetCreate({ name: 'dedup_test.js', content: '// test' });
        assert.ok(asset, 'asset should be created');

        // no prompt because URI is not .pcignore
        assert.ok(infoMessageStub.notCalled, 'info message should not be shown for non-pcignore file');
    });

    test('collision - file path remote to local', async () => {
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

        // execute showPathCollisions command to verify collision detected
        warningMessageStub.resetHistory();
        await vscode.commands.executeCommand(`${NAME}.showPathCollisions`);

        // check if warning dialog was shown
        assert.ok(warningMessageStub.called, 'warning dialog should have been shown for collision');

        // verify the warning message mentions collision count
        const warningCall = warningMessageStub.getCall(0);
        assert.ok(warningCall, 'warning message should have been called');
        const message = warningCall.args[0] as string;
        assert.ok(message.includes('collision'), 'warning message should mention collision');
    });

    test('collision - folder skips children', async () => {
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

        // execute showPathCollisions command to verify folder collision detected
        warningMessageStub.resetHistory();
        await vscode.commands.executeCommand(`${NAME}.showPathCollisions`);

        // check if warning dialog was shown for folder collision
        assert.ok(warningMessageStub.called, 'warning dialog should have been shown for folder collision');

        // now add a child file to the collided folder
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

        // child is skipped due to parent collision (not tracked as collision itself)
        // verify child file does not exist on disk
        const childUri = vscode.Uri.joinPath(folderUri, folderName, 'child.js');
        let childExists = false;
        try {
            await vscode.workspace.fs.stat(childUri);
            childExists = true;
        } catch {
            childExists = false;
        }
        assert.strictEqual(childExists, false, 'child file should not exist due to parent collision');
    });

    test('collision - rename remote to local', async () => {
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

        // execute showPathCollisions command to verify collision detected
        warningMessageStub.resetHistory();
        await vscode.commands.executeCommand(`${NAME}.showPathCollisions`);

        // check if warning dialog was shown
        assert.ok(warningMessageStub.called, 'warning dialog should have been shown for rename collision');

        // verify the warning message mentions collision
        const warningCall = warningMessageStub.getCall(0);
        assert.ok(warningCall, 'warning message should have been called');
        const message = warningCall.args[0] as string;
        assert.ok(message.includes('collision'), 'warning message should mention collision');
    });

    test('collision - removed on delete', async () => {
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

        // verify collision exists before delete
        warningMessageStub.resetHistory();
        await vscode.commands.executeCommand(`${NAME}.showPathCollisions`);
        assert.ok(warningMessageStub.called, 'warning should show collision before delete');

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

        // set up warning stub to return "Show Path Collisions" so we can inspect the list
        warningMessageStub.resetHistory();
        quickPickStub.resetHistory();
        warningMessageStub.resolves('Show Path Collisions' as unknown as vscode.MessageItem);

        // execute showPathCollisions command
        await vscode.commands.executeCommand(`${NAME}.showPathCollisions`);

        // give time for .then() callback
        await wait(50);

        // check if our specific collision path is no longer in the list
        if (quickPickStub.called) {
            const quickPickCall = quickPickStub.getCall(0);
            const items = quickPickCall.args[0] as { label: string; description: string }[];
            const deletedCollisionItem = items.find((item) => item.label === name);
            assert.strictEqual(
                deletedCollisionItem,
                undefined,
                'deleted collision path should not appear in collisions list'
            );
        }
        // NOTE: if quickPickStub wasn't called, there are no collisions at all, which is also valid
    });

    test('echo create - local recreate after remote create propagates', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // remote creates file (sets create echo, watcher consumes it)
        const asset = await assetCreate({ name: 'echo_create_test.js', content: '// remote' });
        assert.ok(asset, 'asset should be created');

        // local deletes file
        const deleted = new Promise<void>((resolve) => {
            const ondelete = messenger.on('assets.delete', (data) => {
                if (data.data.assets.includes(`${asset.uniqueId}`)) {
                    messenger.off('assets.delete', ondelete);
                    setTimeout(resolve, 0);
                }
            });
        });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        await assertResolves(vscode.workspace.fs.delete(uri), 'fs.delete');
        await assertResolves(deleted, 'assets.delete');

        // reset spy history
        rest.assetCreate.resetHistory();

        // local creates file at the same path — must propagate, not be suppressed by stale echo
        const recreated = new Promise<void>((resolve) => {
            const onnew = messenger.on('asset.new', (data) => {
                if (data.data.asset.name === asset.name) {
                    messenger.off('asset.new', onnew);
                    setTimeout(resolve, 0);
                }
            });
        });
        await assertResolves(vscode.workspace.fs.writeFile(uri, buffer.from('// local recreate')), 'fs.writeFile');
        await assertResolves(recreated, 'asset.new');

        assert.ok(rest.assetCreate.called, 'local recreate should propagate to remote');
    });

    test('echo delete - local redelete after remote delete propagates', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // remote creates file
        const asset = await assetCreate({ name: 'echo_delete_test.js', content: '// remote' });
        assert.ok(asset, 'asset should be created');

        // remote deletes file (sets delete echo, watcher consumes it)
        const deleteWatcher = watchFilePromise(folderUri, asset.name, 'delete');
        messenger.emit('assets.delete', {
            data: {
                assets: [asset.item_id]
            }
        });
        await assertResolves(deleteWatcher, 'watcher.delete');

        // remote recreates file at same path
        const asset2 = await assetCreate({ name: 'echo_delete_test.js', content: '// remote again' });
        assert.ok(asset2, 'asset should be recreated');

        // reset spy history
        sharedb.sendRaw.resetHistory();

        // local deletes file — must propagate, not be suppressed by stale echo
        const deleted = new Promise<void>((resolve) => {
            const ondelete = messenger.on('assets.delete', (data) => {
                if (data.data.assets.includes(`${asset2.uniqueId}`)) {
                    messenger.off('assets.delete', ondelete);
                    setTimeout(resolve, 0);
                }
            });
        });
        const uri = vscode.Uri.joinPath(folderUri, asset2.name);
        await assertResolves(vscode.workspace.fs.delete(uri), 'fs.delete');
        await assertResolves(deleted, 'assets.delete');

        assert.ok(sharedb.sendRaw.called, 'local redelete should propagate to remote');
    });

    test('undo reverts local edit', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'undo_local.js', content: '// ORIGINAL' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);
        await assertResolves(
            new Promise<void>((resolve) => {
                if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                    resolve();
                    return;
                }
                const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                    if (e.document.uri.toString() !== uri.toString()) {
                        return;
                    }
                    if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                        disposable.dispose();
                        resolve();
                    }
                });
            }),
            'initial document settle'
        );

        // local edit: insert at start
        const localOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['// LOCAL\n']]);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(localOp, 'local op');
        assert.strictEqual(tdoc.getText(), '// LOCAL\n// ORIGINAL');

        // undo
        const undoChanged = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && tdoc.getText() === '// ORIGINAL') {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        await vscode.commands.executeCommand('playcanvas.undo');
        await assertResolves(undoChanged, 'undo change applied');

        assert.strictEqual(tdoc.getText(), '// ORIGINAL', 'buffer should revert to original');
        assert.strictEqual(documents.get(asset.uniqueId), '// ORIGINAL', 'OT doc should match');
    });

    test('redo re-applies undone edit', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'redo_local.js', content: '// ORIGINAL' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);
        await assertResolves(
            new Promise<void>((resolve) => {
                if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                    resolve();
                    return;
                }
                const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                    if (e.document.uri.toString() !== uri.toString()) {
                        return;
                    }
                    if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                        disposable.dispose();
                        resolve();
                    }
                });
            }),
            'initial document settle'
        );

        // local edit
        const localOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['// LOCAL\n']]);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(localOp, 'local op');

        // undo
        const undoChanged = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && tdoc.getText() === '// ORIGINAL') {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        await vscode.commands.executeCommand('playcanvas.undo');
        await assertResolves(undoChanged, 'undo change applied');
        assert.strictEqual(tdoc.getText(), '// ORIGINAL');

        // redo
        const redoChanged = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && tdoc.getText() === '// LOCAL\n// ORIGINAL') {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        await vscode.commands.executeCommand('playcanvas.redo');
        await assertResolves(redoChanged, 'redo change applied');

        assert.strictEqual(tdoc.getText(), '// LOCAL\n// ORIGINAL', 'buffer should have local edit again');
        assert.strictEqual(documents.get(asset.uniqueId), '// LOCAL\n// ORIGINAL', 'OT doc should match');
    });

    test('undo skips remote edits - only reverts local', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'undo_skip_remote.js', content: '// ORIGINAL' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);
        await assertResolves(
            new Promise<void>((resolve) => {
                if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                    resolve();
                    return;
                }
                const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                    if (e.document.uri.toString() !== uri.toString()) {
                        return;
                    }
                    if (!tdoc.isDirty && tdoc.getText() === '// ORIGINAL') {
                        disposable.dispose();
                        resolve();
                    }
                });
            }),
            'initial document settle'
        );

        // local edit: insert "// LOCAL\n" at start
        const localOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['// LOCAL\n']]);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(localOp, 'local op');
        assert.strictEqual(tdoc.getText(), '// LOCAL\n// ORIGINAL');

        // remote edit: insert "// REMOTE\n" at start
        const remoteChanged = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && tdoc.getText().startsWith('// REMOTE\n')) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp(['// REMOTE\n'], { source: 'remote' });
        await assertResolves(remoteChanged, 'remote change applied to buffer');
        assert.strictEqual(tdoc.getText(), '// REMOTE\n// LOCAL\n// ORIGINAL');

        // undo: should only revert local "// LOCAL\n", preserving remote "// REMOTE\n"
        const undoChanged = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && !tdoc.getText().includes('// LOCAL')) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        await vscode.commands.executeCommand('playcanvas.undo');
        await assertResolves(undoChanged, 'undo change applied');

        assert.strictEqual(tdoc.getText(), '// REMOTE\n// ORIGINAL', 'remote edit preserved, local reverted');
        assert.strictEqual(documents.get(asset.uniqueId), '// REMOTE\n// ORIGINAL', 'OT doc should match buffer');
    });
});
