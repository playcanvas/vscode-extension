import * as assert from 'assert';

import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { WebSocketServer } from 'ws';

import * as authModule from '../../auth';
import { NAME, PUBLISHER } from '../../config';
import { RESUME_GAP_MS } from '../../connections/constants';
import * as messengerModule from '../../connections/messenger';
import * as relayModule from '../../connections/relay';
import * as restModule from '../../connections/rest';
import * as sharedbModule from '../../connections/sharedb';
import * as uriHandlerModule from '../../handlers/uri-handler';
import { Log } from '../../log';
import * as sentryModule from '../../sentry';
import * as typesModule from '../../type-installer';
import type { Asset } from '../../typings/models';
import * as buffer from '../../utils/buffer';
import { Debouncer } from '../../utils/debouncer';
import { EventEmitter } from '../../utils/event-emitter';
import { Mutex } from '../../utils/mutex';
import { norm } from '../../utils/text';
import { hash, tryCatch, tryCatchSync, withTimeout } from '../../utils/utils';
import { MockAuth } from '../mocks/auth';
import { MockMessenger } from '../mocks/messenger';
import {
    assets,
    documents,
    branches,
    projectSettings,
    project,
    user,
    accessToken,
    engineVersion,
    uniqueId
} from '../mocks/models';
import { MockRelay } from '../mocks/relay';
import { MockRest } from '../mocks/rest';
import { MockShareDb } from '../mocks/sharedb';
import { MockUriHandler } from '../mocks/uri-handler';

const sandbox = sinon.createSandbox();
const guardSandbox = sinon.createSandbox();
const DEFAULT_TIMEOUT = 2500;
const RETRY_TIMEOUT = 4000;
const SAVE_RETRY_TIMEOUT = 12000;
const SAVE_FAILURE_TIMEOUT = 15000;
const WATCHER_TIMEOUT = 1000;

const createRecordChannel = <T extends { settled: Promise<void> }>() => {
    const records: T[] = [];
    const waiters = new Set<() => void>();
    const notify = () => {
        for (const waiter of [...waiters]) {
            waiter();
        }
    };

    return {
        findLast: (predicate: (record: T) => boolean) => {
            for (let i = records.length - 1; i >= 0; i--) {
                const record = records[i];
                if (predicate(record)) {
                    return record;
                }
            }
            return undefined;
        },
        get length() {
            return records.length;
        },
        push: (record: T) => {
            records.push(record);
            notify();
            void record.settled.then(notify, notify);
        },
        settled: () => Promise.all(records.map((record) => record.settled)).then(() => undefined),
        waitFor: (start: number, pick: (records: T[]) => Promise<void> | undefined) => {
            return new Promise<void>((resolve, reject) => {
                const check = () => {
                    const settled = pick(records.slice(start));
                    if (!settled) {
                        return;
                    }
                    waiters.delete(check);
                    void settled.then(resolve, reject);
                };
                waiters.add(check);
                check();
            });
        }
    };
};

const emits = createRecordChannel<{ event: string; args: unknown[]; settled: Promise<void> }>();
const mutexes = createRecordChannel<{ keys: string[]; settled: Promise<void> }>();
const edits = createRecordChannel<{ uris: string[]; settled: Promise<void> }>();
const debounces = createRecordChannel<{ settled: Promise<void> }>();
const originalAtomic = Mutex.prototype.atomic;
const originalDebounce = Debouncer.prototype.debounce;
const originalApplyEdit = vscode.workspace.applyEdit.bind(vscode.workspace);

guardSandbox.stub(EventEmitter.prototype, 'emit').callsFake(function (
    this: unknown,
    event: string,
    ...args: unknown[]
) {
    const listeners = (this as { _listeners?: Map<string, ((...args: unknown[]) => unknown)[]> })._listeners?.get(
        event
    );
    if (!listeners) {
        return false;
    }

    const pending: Promise<unknown>[] = [];
    for (const listener of [...listeners]) {
        const result = listener(...args);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            pending.push(Promise.resolve(result));
        }
    }

    const settled = Promise.all(pending).then(() => undefined);
    emits.push({ event, args, settled });
    return true;
});

guardSandbox.stub(Mutex.prototype, 'atomic').callsFake(function (
    this: unknown,
    keys: string[],
    fn: () => Promise<unknown>
) {
    const result = originalAtomic.call(this, keys, fn);
    const settled = result.then(() => undefined);
    mutexes.push({ keys: keys.slice(), settled });
    return result;
});

guardSandbox.stub(Debouncer.prototype, 'debounce').callsFake(function (
    this: Debouncer<unknown>,
    key: string,
    fn: () => Promise<unknown>
) {
    const result = originalDebounce.call(this, key, fn);
    const settled = result.then(
        () => undefined,
        (err: Error) => {
            if (/debounce/.test(err.message)) {
                return;
            }
            throw err;
        }
    );
    debounces.push({ settled });
    return result;
});

guardSandbox.stub(vscode.workspace, 'applyEdit').callsFake((edit, metadata) => {
    const result = Promise.resolve(originalApplyEdit(edit, metadata));
    const settled = result.then(() => undefined);
    edits.push({
        uris: edit.entries().map(([uri]) => uri.toString()),
        settled
    });
    return result;
});

const assertResolves = <T>(promise: PromiseLike<T>, name: string, timeout = DEFAULT_TIMEOUT) => {
    return withTimeout(Promise.resolve(promise), timeout, `${name} resolution exceeded timeout of ${timeout}ms`);
};

const waitForEmit = (
    event: string,
    predicate: (args: unknown[]) => boolean,
    name: string,
    timeout = DEFAULT_TIMEOUT
) => {
    const start = emits.length;
    return assertResolves(
        emits.waitFor(
            start,
            (records) => records.find((record) => record.event === event && predicate(record.args))?.settled
        ),
        name,
        timeout
    );
};

const findEmit = (event: string, predicate: (args: unknown[]) => boolean) => {
    return emits.findLast((record) => record.event === event && predicate(record.args));
};

const waitForMutex = (predicate: (keys: string[]) => boolean, name: string, timeout = DEFAULT_TIMEOUT) => {
    const start = mutexes.length;
    return assertResolves(
        mutexes.waitFor(start, (records) => records.find((record) => predicate(record.keys))?.settled),
        name,
        timeout
    );
};

const waitForApplyEdit = (uri: vscode.Uri, count: number, name: string, timeout = DEFAULT_TIMEOUT) => {
    const start = edits.length;
    const key = uri.toString();
    return assertResolves(
        edits.waitFor(start, (records) => {
            const matches = records.filter((record) => record.uris.includes(key));
            if (matches.length < count) {
                return undefined;
            }
            return Promise.all(matches.slice(0, count).map((record) => record.settled)).then(() => undefined);
        }),
        name,
        timeout
    );
};

const waitForIdle = async (name: string) => {
    let emitCount = -1;
    let mutexCount = -1;
    let editCount = -1;
    let debounceCount = -1;
    while (
        emitCount !== emits.length ||
        mutexCount !== mutexes.length ||
        editCount !== edits.length ||
        debounceCount !== debounces.length
    ) {
        emitCount = emits.length;
        mutexCount = mutexes.length;
        editCount = edits.length;
        debounceCount = debounces.length;
        await assertResolves(
            Promise.all([emits.settled(), mutexes.settled(), edits.settled(), debounces.settled()]).then(
                () => undefined
            ),
            name
        );
    }
};

const watchFile = (folderUri: vscode.Uri, file: string, action: 'create' | 'change' | 'delete') => {
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folderUri, file),
        action !== 'create',
        action !== 'change',
        action !== 'delete'
    );
    const promise = new Promise<vscode.Uri>((resolve) => {
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
    return {
        dispose: () => watcher.dispose(),
        promise
    };
};

const waitForFileContent = async (uri: vscode.Uri, content: string, name: string, timeout = RETRY_TIMEOUT) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const [err, file] = await tryCatch(vscode.workspace.fs.readFile(uri) as Promise<Uint8Array>);
        if (!err && buffer.toString(file) === content) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`${name} content did not match within ${timeout}ms`);
};

// mock connection classes
const auth = new MockAuth(sandbox);
const messenger = new MockMessenger(sandbox);
const sharedb = new MockShareDb(sandbox, messenger);
const relay = new MockRelay(sandbox);
const rest = new MockRest(sandbox, messenger, sharedb);
const uriHandler = new MockUriHandler(sandbox, rest);
const typeFiles = {
    globals: buffer.from('declare namespace pc { const VERSION: string; }\n'),
    module: buffer.from('declare module "playcanvas" { export = pc; }\n'),
    version: engineVersion,
    fallback: false
};
const typeInstaller = {
    install: sandbox.spy(async (_params: { projectId: number; version: string }) => typeFiles)
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

// stub connection class constructors
sandbox.stub(authModule, 'Auth').returns(auth);
sandbox.stub(restModule, 'Rest').returns(rest);
sandbox.stub(sharedbModule, 'ShareDb').returns(sharedb);
sandbox.stub(messengerModule, 'Messenger').returns(messenger);
sandbox.stub(relayModule, 'Relay').returns(relay);
sandbox.stub(uriHandlerModule, 'UriHandler').returns(uriHandler);
sandbox.stub(typesModule, 'TypeInstaller').returns(typeInstaller as unknown as typesModule.TypeInstaller);

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

// stub error message — handleError surfaces pm.error here
const errorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

// spy vscode methods
const openTextDocumentSpy = sandbox.spy(vscode.workspace, 'openTextDocument');

// stub sentry submission for reportIssue test — keep call args inspectable
const addAttachmentStub = sandbox.stub(sentryModule, 'addAttachment');
const captureIssueStub = sandbox.stub(sentryModule, 'captureIssue').returns('test-event-id');
const inputBoxStub = sandbox.stub(vscode.window, 'showInputBox');

const resetWindowStubs = () => {
    warningMessageStub.resetBehavior();
    warningMessageStub.resolves(undefined);
    infoMessageStub.resetBehavior();
    infoMessageStub.resolves(undefined);
    errorMessageStub.resetBehavior();
    errorMessageStub.resolves(undefined);
    inputBoxStub.resetBehavior();
    inputBoxStub.resolves(undefined);
};

const assetNewName = (args: unknown[], name: string) => {
    const event = args[0] as { data?: { asset?: { name?: string } } };
    return event.data?.asset?.name === name;
};

const assetDeleted = (args: unknown[], id: number) => {
    const event = args[0] as { data?: { assets?: string[] } };
    return event.data?.assets?.includes(`${id}`) === true;
};

const assetCreate = async ({
    name,
    content = '',
    parent,
    disk = true
}: {
    name: string;
    content?: string;
    parent?: number;
    disk?: boolean;
}) => {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(folderUri, 'workspace folder should exist');

    let path: string;
    let uri: vscode.Uri;
    if (parent) {
        const parentAsset = assets.get(parent);
        assert.ok(parentAsset, `parent asset ${parent} should exist`);
        path = `${parentAsset.name}/${name}`;
        uri = vscode.Uri.joinPath(folderUri, parentAsset.name);
    } else {
        path = name;
        uri = folderUri;
    }
    const created = waitForEmit('asset:file:create', (args) => args[0] === path, 'asset:file:create');
    const watcher = disk ? watchFile(uri, name, 'create') : undefined;

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

    await created;
    if (watcher) {
        const [watchErr] = await tryCatch(assertResolves(watcher.promise, 'watcher.create', WATCHER_TIMEOUT));
        if (watchErr) {
            watcher.dispose();
        }
        const fileUri = vscode.Uri.joinPath(uri, name);
        await waitForFileContent(fileUri, content, 'assetCreate file');
        await waitForIdle('assetCreate settle');
    }

    const asset = assets.get(res.uniqueId);
    assert.ok(asset, `asset ${res.uniqueId} should exist`);
    return asset;
};

const markSaved = (asset: Asset, text = documents.get(asset.uniqueId) ?? '') => {
    if (!asset.file) {
        return;
    }
    const next = hash(text);
    if (asset.file.hash === next) {
        return;
    }
    const file = {
        filename: asset.file.filename,
        hash: next
    };
    const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
    if (doc) {
        doc.submitOp([{ p: ['file'], od: asset.file, oi: file }], { source: 'remote' });
    } else {
        asset.file = file;
    }
};

const markAllSaved = async () => {
    for (const asset of assets.values()) {
        markSaved(asset);
    }
    await waitForIdle('mark all saved');
};

const ensurePcignore = async () => {
    await waitForIdle('ensure .pcignore idle');
    const existing = Array.from(assets.values()).find((v) => v.name === '.pcignore');
    if (existing) {
        const record = findEmit('asset.new', (args) => assetNewName(args, '.pcignore'));
        await assertResolves(record?.settled ?? Promise.resolve(), 'ensure .pcignore existing');
        return existing;
    }
    return assetCreate({ name: '.pcignore', content: 'ignored*.js\n' });
};

suite('extension', () => {
    suiteTeardown(async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (workspace) {
            // delete workspace folder after tests
            await vscode.workspace.fs.delete(workspace.uri, { recursive: true });
        }
        await waitForIdle('suite teardown');
        guardSandbox.restore();
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
        resetWindowStubs();
        // clear per-doc test-injection flags (_latency, _rejectNext) so a stuck/desync
        // test in one slot doesn't bleed into the next test's first submit.
        sharedb.resetAdversarial();
        // clear per-method REST failure queues so a failNext from one test doesn't
        // get consumed by the next test's first call.
        rest.resetFailures();
        await waitForIdle('test teardown');
    });

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

        assert.ok(typeInstaller.install.called, 'types installer should run');
        const args = typeInstaller.install.getCall(0).args[0] as { version: string };
        assert.strictEqual(args.version, engineVersion, 'version should match');
    });

    test('project load - playcanvas type files', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const globalsUri = vscode.Uri.joinPath(folderUri, '.pc', 'globals.d.ts');
        const moduleUri = vscode.Uri.joinPath(folderUri, '.pc', 'module.d.ts');
        const globals = await assertResolves(vscode.workspace.fs.readFile(globalsUri), 'globals read');
        const module = await assertResolves(vscode.workspace.fs.readFile(moduleUri), 'module read');

        assert.strictEqual(buffer.toString(globals), buffer.toString(typeFiles.globals), 'globals should match');
        assert.strictEqual(buffer.toString(module), buffer.toString(typeFiles.module), 'module should match');
    });

    test(`command ${NAME}.openProject`, async () => {
        // open a project
        await assertResolves(vscode.commands.executeCommand(`${NAME}.openProject`), `${NAME}.openProject`);

        // check if quick pick was shown
        assert.ok(quickPickStub.called, 'quick pick should have been shown');

        // check if open folder was called
        assert.ok(openFolderStub.called, 'open folder should have been called');
    });

    test(`command ${NAME}.openProject failure surfaces error`, async () => {
        errorMessageStub.resetHistory();
        rest.failNext('userProjects', new Error('mock 500: userProjects refused'));

        await assertResolves(vscode.commands.executeCommand(`${NAME}.openProject`), `${NAME}.openProject`);

        const errorCall = errorMessageStub
            .getCalls()
            .find((c) => String(c.args[0]).includes('mock 500: userProjects refused'));
        assert.ok(errorCall, 'openProject failure should be handled by handleError');
    });

    test('auth caches user id validation', async () => {
        const RealAuth = (authModule.Auth as unknown as sinon.SinonStub)
            .wrappedMethod as unknown as typeof authModule.Auth;
        const secrets = new Map([[`${NAME}.accessToken`, accessToken]]);
        const a = new RealAuth({
            secrets: {
                get: sandbox.spy(async (key: string) => secrets.get(key)),
                store: sandbox.spy(async (key: string, value: string) => {
                    secrets.set(key, value);
                }),
                delete: sandbox.spy(async (key: string) => {
                    secrets.delete(key);
                })
            }
        } as unknown as vscode.ExtensionContext);

        rest.id.resetHistory();
        const clients = await Promise.all([a.getClient(), a.getClient(), a.getClient()]);

        assert.strictEqual(rest.id.callCount, 1, 'id should be validated once');
        assert.deepStrictEqual(
            clients.map((client) => client?.userId),
            [user.id, user.id, user.id],
            'clients should reuse cached user id'
        );
    });

    test('auth dedupes concurrent login', async () => {
        const RealAuth = (authModule.Auth as unknown as sinon.SinonStub)
            .wrappedMethod as unknown as typeof authModule.Auth;
        const secrets = new Map<string, string>();
        const a = new RealAuth({
            secrets: {
                get: sandbox.spy(async (key: string) => secrets.get(key)),
                store: sandbox.spy(async (key: string, value: string) => {
                    secrets.set(key, value);
                }),
                delete: sandbox.spy(async (key: string) => {
                    secrets.delete(key);
                })
            }
        } as unknown as vscode.ExtensionContext);
        const requestTokenStub = sandbox
            .stub(a as unknown as Record<'_requestToken', () => Promise<string>>, '_requestToken')
            .resolves(accessToken);

        rest.id.resetHistory();
        infoMessageStub.resetHistory();
        const tokens = await Promise.all([a.getAccessToken(true, false), a.getAccessToken(true, false)]);

        assert.deepStrictEqual(tokens, [accessToken, accessToken], 'login callers should share token');
        assert.strictEqual(requestTokenStub.callCount, 1, 'external login should start once');
        assert.strictEqual(rest.id.callCount, 1, 'login token should be validated once');
    });

    test('auth parses editor config engine version', () => {
        const parsed = authModule.parseEditorConfig(`
            <script>
                const config = {
                    "accessToken": "${accessToken}",
                    engineVersions: { current: { version: "${engineVersion}" } }
                };
            </script>
        `);

        assert.deepStrictEqual(parsed, { accessToken, engineVersion }, 'editor config should parse');
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

        // fire messenger event for second asset
        const assetProcessed = waitForEmit('asset.new', (args) => assetNewName(args, name), 'asset.new processing');
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

        // check if quick pick was shown after clicking "Show Path Collisions"
        assert.ok(quickPickStub.called, 'quick pick should have been shown after clicking button');

        // verify the quick pick contains collision info
        const quickPickCall = quickPickStub.getCall(0);
        const quickPickOptions = quickPickCall.args[1] as { title: string };
        assert.ok(quickPickOptions.title.includes('Collision'), 'quick pick should have collision title');
    });

    test(`command ${NAME}.reportIssue`, async () => {
        // reset and seed the log buffer with a known trace entry. the channel level
        // may be anything — the buffer captures regardless, which is the point.
        Log.reset();
        const log = new Log('ReportIssueTest');
        const marker = `marker-${Date.now()}`;
        log.trace('seed', marker);

        // reset spies/stubs
        infoMessageStub.resetHistory();
        infoMessageStub.resolves(undefined);
        addAttachmentStub.resetHistory();
        captureIssueStub.resetHistory();
        inputBoxStub.resetHistory();

        // simulate the user typing a description in the prompt
        const description = 'scene fails to load on branch switch';
        inputBoxStub.resolves(description);

        await assertResolves(vscode.commands.executeCommand(`${NAME}.reportIssue`), `${NAME}.reportIssue`);

        // attachment was added with a user-<id>.log filename and plain-text bundle
        assert.ok(addAttachmentStub.calledOnce, 'addAttachment should fire');
        const attachment = addAttachmentStub.getCall(0).args[0] as {
            filename: string;
            data: string;
            contentType?: string;
        };
        assert.match(attachment.filename, /^\d+\.log$/, 'attachment filename should be <id>.log');
        assert.strictEqual(attachment.contentType, 'text/plain');
        // log dump only — env metadata lives in event.contexts.report; no header in the file
        assert.ok(attachment.data.startsWith('['), 'attachment should start with a log line, no header');
        assert.ok(!attachment.data.includes('Extension:'), 'attachment should not include env metadata');
        assert.ok(!attachment.data.includes('user ('), 'attachment should not include a user/project header');
        assert.ok(attachment.data.includes('[trace]'), 'attachment should include trace entries');
        assert.ok(attachment.data.includes(marker), 'attachment should include the seeded marker');

        // captureIssue fired with the description as message and the report context
        assert.ok(captureIssueStub.calledOnce, 'captureIssue should fire');
        const [msg, contexts] = captureIssueStub.getCall(0).args as [string, Record<string, Record<string, unknown>>];
        assert.strictEqual(msg, description, 'first arg should be the user description');
        assert.ok(contexts.report, 'report context should be set');
        assert.ok('extension' in contexts.report, 'report context should include extension version');

        // user saw a notification with the (stubbed) event id
        assert.ok(infoMessageStub.called, 'follow-up info message should be shown');
        const lastMsg = infoMessageStub.getCall(infoMessageStub.callCount - 1).args[0] as string;
        assert.ok(/test-event-id/.test(lastMsg), 'notification should include the event id');
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

    test('uri callback does not authenticate', async () => {
        const RealUriHandler = (uriHandlerModule.UriHandler as unknown as sinon.SinonStub)
            .wrappedMethod as unknown as typeof uriHandlerModule.UriHandler;
        const subscriptions: vscode.Disposable[] = [];
        const getClient = sandbox.spy(async () => undefined);
        const h = new RealUriHandler({
            context: { subscriptions } as unknown as vscode.ExtensionContext,
            rootUri: vscode.Uri.parse('vscode-test://root'),
            auth: { getClient } as unknown as InstanceType<typeof authModule.Auth>
        });
        const uri = vscode.Uri.from({
            scheme: vscode.env.uriScheme,
            authority: `${PUBLISHER}.${NAME}`
        });

        await h.handleUri(uri);

        assert.ok(getClient.notCalled, 'oauth callback uri should not request auth');
        subscriptions.forEach((d) => d.dispose());
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

        // fire messenger event for second asset
        const assetProcessed = waitForEmit('asset.new', (args) => assetNewName(args, name), 'asset.new processing');
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
        const uriCalls = uriHandler.handleUri.callCount;
        await vscode.env.openExternal(externalUri);

        const uriCall = uriHandler.handleUri.getCall(uriCalls);
        assert.ok(uriCall, 'uri handler should have been called');
        await assertResolves(uriCall.returnValue, 'uriHandler.handleUri');

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
        const watcher = watchFile(folderUri, asset.name, 'create').promise;
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
                    resolve();
                }
            });
        });

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        // write the file to disk
        const uri = vscode.Uri.joinPath(folderUri, name);
        await assertResolves(vscode.workspace.fs.writeFile(uri, buffer.from(document)), 'fs.writeFile');

        // wait for remote creation to be detected
        await assertResolves(created, 'asset.new', RETRY_TIMEOUT);

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
        await assertResolves(created, 'asset.new', RETRY_TIMEOUT);

        // check if rest assetCreate was called with correct parameters
        const calls = rest.assetCreate.getCalls();
        assert.strictEqual(calls.length, files.length, 'assetCreate should be called for each file');
        for (const file of files) {
            const call = calls.find((c) => c.args[2].name === file.name);
            assert.ok(call, `assetCreate should be called for ${file.name}`);
            assert.deepStrictEqual(
                call.args,
                [
                    project.id,
                    projectSettings.branch,
                    {
                        type: 'script',
                        name: file.name,
                        parent: undefined,
                        preload: true,
                        filename: `${file.name}.js`,
                        file: new Blob([file.content], { type: 'text/plain' })
                    }
                ],
                `assetCreate args should match for ${file.name}`
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

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        const parentUri = vscode.Uri.joinPath(folderUri, parentName);
        const subfolderUri = vscode.Uri.joinPath(parentUri, subfolderName);
        const fileUri = vscode.Uri.joinPath(subfolderUri, fileName);

        const parentCreated = waitForEmit('asset.new', (args) => assetNewName(args, parentName), 'parent asset.new');
        await vscode.workspace.fs.createDirectory(parentUri);
        await parentCreated;

        const subfolderCreated = waitForEmit(
            'asset.new',
            (args) => assetNewName(args, subfolderName),
            'subfolder asset.new'
        );
        await vscode.workspace.fs.createDirectory(subfolderUri);
        await subfolderCreated;

        const fileCreated = waitForEmit('asset.new', (args) => assetNewName(args, fileName), 'file asset.new');
        await vscode.workspace.fs.writeFile(fileUri, buffer.from(fileContent));
        await fileCreated;
        await waitForIdle('nested local create settle');

        const created = rest.assetCreate
            .getCalls()
            .map((c) => c.args[2].name)
            .filter((name) => [parentName, subfolderName, fileName].includes(name));
        assert.deepStrictEqual(created, [parentName, subfolderName, fileName], 'assets should be created in order');
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

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        const parentUri = vscode.Uri.joinPath(folderUri, parentName);
        const parentCreated = waitForEmit('asset.new', (args) => assetNewName(args, parentName), 'parent asset.new');
        await vscode.workspace.fs.createDirectory(parentUri);
        await parentCreated;

        const siblingAUri = vscode.Uri.joinPath(parentUri, siblingA);
        const siblingBUri = vscode.Uri.joinPath(parentUri, siblingB);

        const siblingACreated = waitForEmit('asset.new', (args) => assetNewName(args, siblingA), 'sibling A asset.new');
        await vscode.workspace.fs.createDirectory(siblingAUri);
        await siblingACreated;

        const fileACreated = waitForEmit('asset.new', (args) => assetNewName(args, fileA), 'file A asset.new');
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(siblingAUri, fileA), buffer.from(fileContent));
        await fileACreated;

        const siblingBCreated = waitForEmit('asset.new', (args) => assetNewName(args, siblingB), 'sibling B asset.new');
        await vscode.workspace.fs.createDirectory(siblingBUri);
        await siblingBCreated;

        const fileBCreated = waitForEmit('asset.new', (args) => assetNewName(args, fileB), 'file B asset.new');
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(siblingBUri, fileB), buffer.from(fileContent));
        await fileBCreated;
        await waitForIdle('sibling local create settle');

        const created = rest.assetCreate
            .getCalls()
            .map((c) => c.args[2].name)
            .filter((name) => [parentName, siblingA, siblingB, fileA, fileB].includes(name));
        assert.deepStrictEqual(
            created,
            [parentName, siblingA, fileA, siblingB, fileB],
            'sibling assets should be created in order'
        );
    });

    test('folder create - similar names local to remote', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // define similar named folders: A and AB (AB should NOT depend on A)
        const parentName = 'test_similar';
        const folderA = 'A';
        const folderAB = 'AB'; // similar prefix but NOT a child of A

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        const parentUri = vscode.Uri.joinPath(folderUri, parentName);
        const parentCreated = waitForEmit('asset.new', (args) => assetNewName(args, parentName), 'parent asset.new');
        await vscode.workspace.fs.createDirectory(parentUri);
        await parentCreated;

        const folderAUri = vscode.Uri.joinPath(parentUri, folderA);
        const folderABUri = vscode.Uri.joinPath(parentUri, folderAB);

        const folderACreated = waitForEmit('asset.new', (args) => assetNewName(args, folderA), 'folder A asset.new');
        await vscode.workspace.fs.createDirectory(folderAUri);
        await folderACreated;

        const folderABCreated = waitForEmit('asset.new', (args) => assetNewName(args, folderAB), 'folder AB asset.new');
        await vscode.workspace.fs.createDirectory(folderABUri);
        await folderABCreated;
        await waitForIdle('similar local create settle');

        const created = rest.assetCreate
            .getCalls()
            .map((c) => c.args[2].name)
            .filter((name) => [parentName, folderA, folderAB].includes(name));
        assert.deepStrictEqual(created, [parentName, folderA, folderAB], 'similar assets should be created in order');
    });

    test('folder create - copy tree local to remote', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // define expected asset names
        const topName = 'test_race_copy';
        const subfolderName = 'race_sub';
        const fileName = 'race_child.js';

        // reset asset create spy call history
        rest.assetCreate.resetHistory();

        // create a nested tree with recursive directory creation, then write the child.
        // this exercises the ancestor-ensure path without relying on fs.copy watcher shape.
        const targetUri = vscode.Uri.joinPath(folderUri, topName);
        const targetSubUri = vscode.Uri.joinPath(targetUri, subfolderName);
        const topCreated = waitForEmit('asset.new', (args) => assetNewName(args, topName), 'top asset.new');
        const subfolderCreated = waitForEmit(
            'asset.new',
            (args) => assetNewName(args, subfolderName),
            'subfolder asset.new'
        );
        await assertResolves(vscode.workspace.fs.createDirectory(targetSubUri), 'fs.createDirectory');
        await topCreated;
        await subfolderCreated;

        const fileCreated = waitForEmit('asset.new', (args) => assetNewName(args, fileName), 'file asset.new');
        await assertResolves(
            vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(targetSubUri, fileName),
                buffer.from('// RACE CONDITION TEST')
            ),
            'fs.writeFile'
        );
        await fileCreated;
        await waitForIdle('copy tree local create settle');

        const created = rest.assetCreate
            .getCalls()
            .map((c) => c.args[2].name)
            .filter((name) => [topName, subfolderName, fileName].includes(name));
        assert.deepStrictEqual(
            created,
            [topName, subfolderName, fileName],
            'copy tree assets should be created in order'
        );
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

    test('file change - sharedb reload resyncs buffer', async () => {
        // sharedb ingestSnapshot (hard rollback / version mismatch / stale resume)
        // silently replaces doc.data and emits 'load' without any 'op' events.
        // without the resync, OTDocument._text stays stale and subsequent local
        // keystrokes / remote ops apply to the wrong offset (observed symptom:
        // random code chunks landing at the top of large .js files).

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'reload_resync.js', content: '// OLD CONTENT\n' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);

        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');

        // wait for buffer to reconcile to the new data
        const changed = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString()) {
                    disposable.dispose();
                    resolve();
                }
            });
        });

        // simulate sharedb replacing doc.data wholesale (ingestSnapshot)
        const replaced = '// NEW HEADER FROM SERVER\n// OLD CONTENT\n';
        doc.reload(replaced);
        documents.set(asset.uniqueId, replaced);

        await assertResolves(changed, 'vscode.onDidChangeTextDocument');
        assert.strictEqual(tdoc.getText(), replaced, 'buffer should match reloaded snapshot');

        // canonical OT text must also resync (the pre-fix bug: _text stayed stale).
        // assertion via sharedb doc + projectManager file: file.doc.text drives all
        // downstream offset math in _update / vscode2sharedb.
        assert.strictEqual(doc.data, replaced, 'sharedb doc.data should match');
    });

    test('file change - sharedb reload null skip', async () => {
        // server nullifies inactive doc data after hard reset; reload must skip
        // rather than crash downstream (hash / norm would throw on null).
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'reload_null.js', content: '// KEEP\n' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);

        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');

        // should not throw; buffer should remain unchanged
        doc.reload(null);
        assert.strictEqual(tdoc.getText(), '// KEEP\n', 'buffer should be untouched on null reload');
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
        const watcher = watchFile(folderUri, asset.name, 'change').promise;

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
        const processed = waitForMutex((keys) => keys.includes(asset.name), 'atomic write noop');
        await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });

        await processed;

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
        const processed = waitForMutex((keys) => keys.includes(asset.name), 'external closed file change');
        await vscode.workspace.fs.writeFile(uri, buffer.from(newContent));

        // wait for remote update to be detected
        await assertResolves(updated, 'sharedb.op');
        await processed;

        // verify no doc:save was sent (no auto-save on external change)
        const saveCalls = sharedb.sendRaw.getCalls().filter((c) => `${c.args[0]}`.startsWith('doc:save:'));
        assert.strictEqual(saveCalls.length, 0, 'should not send doc:save for external closed file change');
    });

    test('file open - typing before subscribe reverts without OT submit', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'blocked_subscribe_edit.js', content: '// ORIG\n' });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const original = '// ORIG\n';

        await markAllSaved();
        const reloaded = waitForEmit('asset:file:create', (args) => args[0] === asset.name, 'blocked subscribe reload');
        await assertResolves(vscode.commands.executeCommand(`${NAME}.reloadProject`) as Promise<unknown>, 'reload');
        await reloaded;
        await waitForIdle('blocked subscribe reload settle');
        await waitForFileContent(uri, original, 'blocked subscribe file');

        sharedb.documentSubscribeDelay = 1000;
        warningMessageStub.resetHistory();
        const subscribed = waitForEmit(
            'asset:file:subscribed',
            (args) => args[0] === asset.name,
            'delayed subscribe',
            RETRY_TIMEOUT
        );
        const opened = waitForEmit('asset:doc:open', (args) => args[0] === asset.name, 'document open');

        const tdoc = await vscode.workspace.openTextDocument(uri);
        await opened;

        let changed = false;
        const reverted = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() !== uri.toString()) {
                    return;
                }
                if (e.document.getText().startsWith('X')) {
                    changed = true;
                    return;
                }
                if (changed && e.document.getText() === original) {
                    disposable.dispose();
                    resolve();
                }
            });
        });

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), 'X');
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true, 'blocked edit should apply before revert');
        await assertResolves(reverted, 'blocked edit revert');
        await vscode.window.showTextDocument(tdoc);
        await subscribed;
        await waitForIdle('blocked edit settle');

        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'document should be subscribed after delay');
        assert.strictEqual(tdoc.getText(), original, 'blocked edit should be reverted to disk content');
        assert.strictEqual(doc.submitOp.callCount, 0, 'blocked edit should not submit OT');
        assert.ok(warningMessageStub.calledWith(sinon.match(/still loading/i)), 'loading warning should be shown');
    });

    test('file close - discard after first-keystroke does not roll back doc', async () => {
        // regression #278: first onChange after open fires with isDirty=false
        // (transient), so external=true was a false positive. _dirtyReload then
        // stomped _diskHash to hash(buffer+keystroke), and a later close-discard
        // failed the discard guard and submitted rollback ops.

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({
            name: 'discard_after_first_keystroke.js',
            content: '// ORIGINAL CONTENT'
        });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        // first keystroke — fires onChange with isDirty=false (false positive external)
        const firstSettled = waitForApplyEdit(uri, 2, 'first dirty reload');
        const firstOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['X']]);
        const first = new vscode.WorkspaceEdit();
        first.insert(uri, new vscode.Position(0, 0), 'X');
        await vscode.workspace.applyEdit(first);
        await assertResolves(firstOp, 'first local op');
        await firstSettled;

        // more edits to grow the dirty state
        const secondOp = assertOpsPromise(`documents:${asset.uniqueId}`, [[1, 'YZ']]);
        const second = new vscode.WorkspaceEdit();
        second.insert(uri, new vscode.Position(0, 1), 'YZ');
        await vscode.workspace.applyEdit(second);
        await assertResolves(secondOp, 'second local op');
        await waitForIdle('second local edit settle');

        const before = documents.get(asset.uniqueId);
        assert.ok(before?.startsWith('XYZ'), 'doc state should reflect edits');

        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'subscription should exist');
        doc.submitOp.resetHistory();

        // close with discard — fires onChange (revert to disk) then onDidCloseTextDocument
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await waitForIdle('revert close');

        assert.strictEqual(documents.get(asset.uniqueId), before, 'doc state should not roll back on dirty close');

        const ops = doc.submitOp.getCalls();
        assert.strictEqual(ops.length, 0, 'should not submit rollback ops on dirty close');
    });

    test('file close - discard while still dirty does not roll back collaborator edits', async () => {
        // regression #315: a collaborator's remote op lands in an inactive tab and marks
        // it dirty. closing + "Don't Save" reverts the buffer to the stale on-disk bytes,
        // firing onChange with no reason while isDirty is still true (the native close
        // dialog fires before the dirty flag clears). the old guard gated on !isDirty, so
        // it pushed that revert upstream as a rollback op, wiping the collaborator's edits
        // for everyone. open-file remote ops never touch disk, so _diskHash stays at the
        // last-saved hash and the revert lands exactly on it.

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'discard_dirty_collab.js', content: '// ORIGINAL' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);
        await waitForIdle('initial open settle');

        // collaborator edit arrives as a remote op on the open (inactive) tab
        const collab = '// COLLAB B EDIT\n// ORIGINAL';
        const changed = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && e.document.getText() === collab) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb document should exist');
        doc.submitOp(['// COLLAB B EDIT\n'], { source: 'remote' });
        await assertResolves(changed, 'collaborator edit buffer apply');
        await waitForIdle('remote op settle');

        assert.strictEqual(tdoc.getText(), collab, 'buffer should hold collaborator edit');
        assert.strictEqual(tdoc.isDirty, true, 'remote op into open tab should mark it dirty');
        assert.strictEqual(documents.get(asset.uniqueId), collab, 'OT doc should hold collaborator edit');

        // capture dirty state when the revert fires — proves we exercise the isDirty=true
        // path (the native-dialog timing), not the trivially-skipped isDirty=false path
        let dirtyAtRevert: boolean | undefined;
        const reverted = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && e.document.getText() === '// ORIGINAL') {
                    dirtyAtRevert = e.document.isDirty;
                    disposable.dispose();
                    resolve();
                }
            });
        });

        doc.submitOp.resetHistory();

        // simulate "Don't Save": buffer reverts to on-disk content as a forward edit, so
        // isDirty stays true (the revert command would clear it — that path is covered by
        // the discard-after-first-keystroke test above)
        const revert = new vscode.WorkspaceEdit();
        revert.delete(uri, new vscode.Range(0, 0, 1, 0));
        await vscode.workspace.applyEdit(revert);
        await assertResolves(reverted, 'revert to disk change');
        await waitForIdle('revert settle');

        assert.strictEqual(dirtyAtRevert, true, 'revert must fire while still dirty to exercise #315');
        assert.strictEqual(doc.submitOp.callCount, 0, 'discard revert must not submit a rollback op (#315)');
        assert.strictEqual(
            documents.get(asset.uniqueId),
            collab,
            'server doc must retain collaborator edit, not roll back'
        );
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
        const baselineSettled = waitForApplyEdit(uri, 2, 'saved baseline dirty reload');
        const baselineOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['// SAVED\n']]);
        const edit1 = new vscode.WorkspaceEdit();
        edit1.insert(uri, new vscode.Position(0, 0), '// SAVED\n');
        await vscode.workspace.applyEdit(edit1);
        await assertResolves(baselineOp, 'saved baseline op');
        await baselineSettled;
        await waitForIdle('saved baseline edit');
        await tdoc.save();
        await waitForIdle('saved baseline save');

        const saved = tdoc.getText();
        assert.strictEqual(saved, '// SAVED\n// ORIGINAL', 'saved content should match');

        // edit after save (line 1 to prevent UndoManager composing with SAVED)
        const edit2 = new vscode.WorkspaceEdit();
        edit2.insert(uri, new vscode.Position(1, 0), '// TEMP\n');
        await vscode.workspace.applyEdit(edit2);
        await waitForIdle('temp edit settle');
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
        await waitForIdle('undo to saved settle');

        assert.strictEqual(tdoc.getText(), saved, 'buffer should match saved content after undo');

        // edit again — this must apply against correct OT base
        const updated = assertOpsPromise(`documents:${asset.uniqueId}`, [
            ['// FINAL\n'] // insert at start
        ]);
        const edit3 = new vscode.WorkspaceEdit();
        edit3.insert(uri, new vscode.Position(0, 0), '// FINAL\n');
        await vscode.workspace.applyEdit(edit3);
        await assertResolves(updated, 'sharedb.op after undo');
        await waitForIdle('final edit after undo');

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
        const saved = waitForEmit(
            'doc:save',
            (args) => args[0] === 'success' && args[1] === asset.uniqueId,
            'doc save success'
        );
        sharedb.emit('doc:save', 'success', asset.uniqueId);

        // _save() is a no-op for open files — document stays dirty
        await saved;
        assert.strictEqual(tdoc.isDirty, true, 'document should stay dirty after doc:save:success');

        // verify no redundant server save was triggered
        const saveCalls = sharedb.sendRaw.getCalls().filter((c) => `${c.args[0]}`.startsWith('doc:save:'));
        assert.strictEqual(saveCalls.length, 0, 'should not send redundant doc:save to server');
    });

    test('file save - matching asset hash clears failed save state', async function () {
        this.timeout(SAVE_FAILURE_TIMEOUT);

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        await markAllSaved();

        const asset = await assetCreate({ name: 'save_failed_then_hash.js', content: '// ORIG\n' });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// EDIT\n');
        await vscode.workspace.applyEdit(edit);
        await waitForIdle('failed save edit');

        sharedb.failNextSave(asset.uniqueId, 6);
        warningMessageStub.resetHistory();
        const failed = waitForEmit(
            'asset:file:dirty',
            (args) => args[0] === asset.name,
            'save failure dirty',
            SAVE_FAILURE_TIMEOUT
        );
        await tdoc.save();
        await failed;
        await waitForIdle('failed save settle');

        assert.strictEqual(tdoc.isDirty, true, 'failed save should re-dirty the open document');
        assert.ok(
            warningMessageStub.calledWith(sinon.match(/could not save/i)),
            'save failure warning should be shown'
        );

        warningMessageStub.resetHistory();
        await assertResolves(
            vscode.commands.executeCommand(`${NAME}.reloadProject`) as Promise<unknown>,
            'reload block'
        );
        assert.ok(
            warningMessageStub.calledWith(sinon.match(/changes are not saved/i)),
            'reload should be blocked while save failed'
        );

        const saved = waitForEmit('asset:file:save', (args) => args[0] === asset.name, 'matching hash save');
        markSaved(asset, tdoc.getText());
        await saved;
        await waitForIdle('matching hash settle');

        warningMessageStub.resetHistory();
        rest.branchCheckout.resetHistory();
        await assertResolves(
            vscode.commands.executeCommand(`${NAME}.switchBranch`) as Promise<unknown>,
            'switch branch'
        );
        assert.strictEqual(rest.branchCheckout.callCount, 1, 'switch branch should be unblocked after matching hash');
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
        const watcher = watchFile(folderUri, asset.name, 'delete').promise;

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

        // reset sharedb sendRaw spy call history
        sharedb.sendRaw.resetHistory();

        // delete local file
        const delete_ = waitForEmit('assets.delete', (args) => assetDeleted(args, asset.uniqueId), 'assets.delete');
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
        const deleteWatcher = watchFile(folderUri, asset.name, 'delete').promise;
        const createWatcher = watchFile(folderUri, newName, 'create').promise;

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
        const deleteWatcher = watchFile(folderUri, asset.name, 'delete').promise;
        const createWatcher = watchFile(folderUri, `${folderAsset.name}/${asset.name}`, 'create').promise;

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
        const parsed = waitForEmit(
            'asset:file:create',
            (args) => args[0] === '.pcignore',
            '.pcignore asset:file:create'
        );
        await assertResolves(vscode.workspace.fs.writeFile(ignoreUri, buffer.from(ignoreContent)), 'fs.writeFile');
        await parsed;

        // create file to be ignored
        const ignoredFileUri = vscode.Uri.joinPath(folderUri, 'ignored_file.js');
        await assertResolves(
            vscode.workspace.fs.writeFile(ignoredFileUri, buffer.from('// IGNORED FILE')),
            'fs.writeFile'
        );
        const ignoredFile = await assertResolves(vscode.workspace.fs.readFile(ignoredFileUri), 'ignored file read');
        assert.strictEqual(buffer.toString(ignoredFile), '// IGNORED FILE', 'ignored file should exist on disk');

        // check ignored file and folder do not exist as assets
        const ignoredFileAsset = Array.from(assets.values()).find((a) => a.name === 'ignored_file.js');
        assert.strictEqual(ignoredFileAsset, undefined, 'ignored file should not exist as asset');
    });

    test('pcignore - reparse on remote update', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await ensurePcignore();
        infoMessageStub.resetHistory();

        // get sharedb document subscription
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, '.pcignore document subscription should exist');

        // append '*.txt\n' after current content
        const offset = (doc.data as string).length;
        const updated = waitForEmit(
            'asset:file:update',
            (args) => args[0] === '.pcignore',
            '.pcignore asset:file:update'
        );
        doc.submitOp([offset, '*.txt\n'], { source: 'remote' });
        await updated;
        await waitForIdle('.pcignore update settle');
        const ignoreUri = vscode.Uri.joinPath(folderUri, '.pcignore');
        const ignoreContent = await assertResolves(vscode.workspace.fs.readFile(ignoreUri), '.pcignore read');
        assert.strictEqual(buffer.toString(ignoreContent), `${doc.data}`, '.pcignore content should update');

        // assert reload prompt was shown
        assert.ok(infoMessageStub.calledOnce, 'info message should be shown once');
        const msg = infoMessageStub.getCall(0).args[0] as string;
        assert.ok(msg.includes('Ignore rules updated'), 'message should contain "Ignore rules updated"');

        // write a .txt file and verify it's ignored by the re-parsed rules
        const txtUri = vscode.Uri.joinPath(folderUri, 'test_ignored.txt');
        await assertResolves(vscode.workspace.fs.writeFile(txtUri, buffer.from('// IGNORED TXT')), 'fs.writeFile');
        const txtFile = await assertResolves(vscode.workspace.fs.readFile(txtUri), 'ignored txt read');
        assert.strictEqual(buffer.toString(txtFile), '// IGNORED TXT', 'txt file should exist on disk');

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

    test('vcs exclusion - .git not synced', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const gitDir = vscode.Uri.joinPath(folderUri, '.git');
        await assertResolves(vscode.workspace.fs.createDirectory(gitDir), 'fs.createDirectory');

        const head = `HEAD_${Date.now()}`;
        const watcher = watchFile(folderUri, `.git/${head}`, 'create').promise;
        const headUri = vscode.Uri.joinPath(gitDir, head);
        await assertResolves(
            vscode.workspace.fs.writeFile(headUri, buffer.from('ref: refs/heads/main\n')),
            'fs.writeFile'
        );
        await assertResolves(watcher, 'watcher.create');

        assert.strictEqual(
            Array.from(assets.values()).find((a) => a.name === head),
            undefined,
            `.git/${head} should not exist as asset`
        );
        assert.strictEqual(
            Array.from(assets.values()).find((a) => a.name === '.git'),
            undefined,
            '.git folder should not exist as asset'
        );
    });

    test('vcs exclusion - .git survives re-link cleanup', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        await markAllSaved();

        // ensure .git/ and a child file exist on disk before reload
        const gitDir = vscode.Uri.joinPath(folderUri, '.git');
        const headUri = vscode.Uri.joinPath(gitDir, 'HEAD');
        await assertResolves(vscode.workspace.fs.createDirectory(gitDir), 'fs.createDirectory');
        await assertResolves(
            vscode.workspace.fs.writeFile(headUri, buffer.from('ref: refs/heads/main\n')),
            'fs.writeFile'
        );

        // full unlink + link cycle
        await assertResolves(
            vscode.commands.executeCommand(`${NAME}.reloadProject`) as Promise<unknown>,
            'reloadProject'
        );

        // .git/ and its contents must survive the cleanup loop
        const [gitErr] = await tryCatch(vscode.workspace.fs.stat(gitDir) as Promise<vscode.FileStat>);
        assert.ok(!gitErr, '.git/ should still exist after re-link');

        const [headErr] = await tryCatch(vscode.workspace.fs.stat(headUri) as Promise<vscode.FileStat>);
        assert.ok(!headErr, '.git/HEAD should still exist after re-link');
    });

    test('vcs exclusion - inbound .git/index not written', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // inject a fake .git folder asset at the root
        const gitFolderId = uniqueId.next().value as number;
        const gitFolder: Asset = {
            uniqueId: gitFolderId,
            item_id: `${gitFolderId}`,
            name: '.git',
            type: 'folder',
            path: []
        };
        assets.set(gitFolderId, gitFolder);
        const gitFolderProcessed = waitForEmit('asset.new', (args) => assetNewName(args, '.git'), '.git asset.new');
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: gitFolder.item_id,
                    name: gitFolder.name,
                    type: gitFolder.type,
                    branchId: projectSettings.branch
                }
            }
        });
        await gitFolderProcessed;

        // inject a child "index" file — so _assetPath() resolves to ".git/index"
        const indexId = uniqueId.next().value as number;
        const indexDoc = 'binary-junk';
        const indexAsset: Asset = {
            uniqueId: indexId,
            item_id: `${indexId}`,
            name: 'index',
            type: 'script',
            path: [gitFolderId],
            file: { filename: 'index', hash: hash(indexDoc) }
        };
        assets.set(indexId, indexAsset);
        documents.set(indexId, indexDoc);
        const indexProcessed = waitForEmit('asset.new', (args) => assetNewName(args, 'index'), 'index asset.new');
        messenger.emit('asset.new', {
            data: {
                asset: {
                    id: indexAsset.item_id,
                    name: indexAsset.name,
                    type: indexAsset.type,
                    branchId: projectSettings.branch
                }
            }
        });
        await indexProcessed;

        // .git/index must not be written to disk by the extension
        const gitIndexUri = vscode.Uri.joinPath(folderUri, '.git', 'index');
        const [indexErr] = await tryCatch(vscode.workspace.fs.stat(gitIndexUri) as Promise<vscode.FileStat>);
        assert.ok(indexErr, '.git/index should not be written to disk');
    });

    test('echo create - local recreate after remote create propagates', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // remote creates file (sets create echo, watcher consumes it)
        const id = uniqueId.next().value;
        const name = `echo_create_test_${id}.js`;
        const asset = await assetCreate({ name, content: '// remote', disk: false });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const [seedErr] = await tryCatch(waitForFileContent(uri, '// remote', 'remote create file', WATCHER_TIMEOUT));
        if (seedErr) {
            const seeded = watchFile(folderUri, name, 'create');
            await assertResolves(vscode.workspace.fs.writeFile(uri, buffer.from('// remote')), 'seed remote file');
            const [watchErr] = await tryCatch(assertResolves(seeded.promise, 'seed watcher.create', WATCHER_TIMEOUT));
            if (watchErr) {
                seeded.dispose();
            }
        }

        const deleted = waitForEmit('assets.delete', (args) => assetDeleted(args, asset.uniqueId), 'assets.delete');
        const fileDeleted = waitForEmit('asset:file:delete', (args) => args[0] === asset.name, 'asset:file:delete');
        await assertResolves(vscode.workspace.fs.delete(uri), 'fs.delete');
        await assertResolves(deleted, 'assets.delete');
        await assertResolves(fileDeleted, 'asset:file:delete');

        // reset spy history
        rest.assetCreate.resetHistory();

        // local creates file at the same path — must propagate, not be suppressed by stale echo
        const recreated = waitForEmit('asset.new', (args) => assetNewName(args, asset.name), 'asset.new');
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
        const deleteWatcher = watchFile(folderUri, asset.name, 'delete').promise;
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
        const deleted = waitForEmit('assets.delete', (args) => assetDeleted(args, asset2.uniqueId), 'assets.delete');
        const uri = vscode.Uri.joinPath(folderUri, asset2.name);
        await assertResolves(vscode.workspace.fs.delete(uri), 'fs.delete');
        await assertResolves(deleted, 'assets.delete');

        assert.ok(sharedb.sendRaw.called, 'local redelete should propagate to remote');
    });

    test('collision - file path remote to local', async () => {
        // get folder uri
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        // create first asset
        const name = 'collision_test.js';
        const document = `console.log('first file');\n`;
        const asset1 = await assetCreate({ name, content: document, disk: false });
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

        // fire messenger event for second asset with same name
        const assetProcessed = waitForEmit('asset.new', (args) => assetNewName(args, name), 'asset.new processing');
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
        const created = waitForEmit(
            'asset:file:create',
            (args) => args[0] === folderName && args[1] === 'folder',
            'folder asset:file:create'
        );

        // create folder asset via rest
        await assertResolves(
            rest.assetCreate(project.id, projectSettings.branch, {
                type: 'folder',
                name: folderName,
                preload: false
            }),
            'rest.assetCreate folder'
        );
        await created;

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

        // fire messenger event for second folder with same name
        const folderProcessed = waitForEmit(
            'asset.new',
            (args) => assetNewName(args, folderName),
            'folder.new processing'
        );
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

        // fire messenger event for child
        const childProcessed = waitForEmit(
            'asset.new',
            (args) => assetNewName(args, childAsset.name),
            'child.new processing'
        );
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
        const [childErr] = await tryCatch(vscode.workspace.fs.stat(childUri) as Promise<vscode.FileStat>);
        assert.ok(childErr, 'child file should not exist due to parent collision');
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

        const asset1 = await assetCreate({ name: name1, content: document1, disk: false });
        assert.ok(asset1, 'target asset should be created');

        const asset2 = await assetCreate({ name: name2, content: document2, disk: false });
        assert.ok(asset2, 'source asset should be created');

        // reset warning message stub
        warningMessageStub.resetHistory();

        // watch for source removal when it becomes a collision
        const deleteWatcher = waitForEmit('asset:file:delete', (args) => args[0] === name2, 'asset:file:delete');

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
        await assertResolves(deleteWatcher, 'asset:file:delete');

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
        const asset1 = await assetCreate({ name, content: document, disk: false });
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

        // fire messenger event for second asset (will be collision)
        const assetProcessed = waitForEmit('asset.new', (args) => assetNewName(args, name), 'asset.new processing');
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

        // fire messenger event for deletion of collided asset
        const deleteProcessed = waitForEmit(
            'assets.delete',
            (args) => assetDeleted(args, asset2.uniqueId),
            'assets.delete processing'
        );
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
        const localSettled = waitForApplyEdit(uri, 2, 'undo first dirty reload');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(localOp, 'local op');
        await localSettled;
        await waitForIdle('undo local edit settle');
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
        await waitForIdle('undo local settle');

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
        const localSettled = waitForApplyEdit(uri, 2, 'redo first dirty reload');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(localOp, 'local op');
        await localSettled;
        await waitForIdle('redo local edit settle');

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
        await waitForIdle('redo undo settle');
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
        await waitForIdle('redo settle');

        assert.strictEqual(tdoc.getText(), '// LOCAL\n// ORIGINAL', 'buffer should have local edit again');
        assert.strictEqual(documents.get(asset.uniqueId), '// LOCAL\n// ORIGINAL', 'OT doc should match');
    });

    test('native undo/redo after CRLF whole-buffer paste stays synced', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'crlf_native_undo.js', content: 'CCC' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(tdoc);
        await assertResolves(
            new Promise<void>((resolve) => {
                if (!tdoc.isDirty && tdoc.getText() === 'CCC') {
                    resolve();
                    return;
                }
                const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                    if (e.document.uri.toString() !== uri.toString()) {
                        return;
                    }
                    if (!tdoc.isDirty && tdoc.getText() === 'CCC') {
                        disposable.dispose();
                        resolve();
                    }
                });
            }),
            'initial document settle'
        );

        await editor.edit((edit) => {
            edit.setEndOfLine(vscode.EndOfLine.CRLF);
        });
        assert.strictEqual(tdoc.eol, vscode.EndOfLine.CRLF, 'document should use CRLF for this regression');

        const pasteOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['AAA\nBBB', { d: 3 }]]);
        await editor.edit(
            (edit) => {
                edit.replace(
                    new vscode.Range(tdoc.positionAt(0), tdoc.positionAt(tdoc.getText().length)),
                    'AAA\r\nBBB'
                );
            },
            { undoStopBefore: true, undoStopAfter: true }
        );
        await assertResolves(pasteOp, 'CRLF whole-buffer paste op');
        await waitForIdle('CRLF paste settle');

        assert.strictEqual(norm(tdoc.getText()), 'AAA\nBBB', 'buffer should contain pasted text');
        assert.strictEqual(documents.get(asset.uniqueId), 'AAA\nBBB', 'OT doc should match pasted buffer');

        const undoOp = assertOpsPromise(`documents:${asset.uniqueId}`, [[{ d: 7 }, 'CCC']]);
        await vscode.commands.executeCommand('undo');
        await assertResolves(undoOp, 'native undo op');
        await waitForIdle('native undo settle');

        assert.strictEqual(norm(tdoc.getText()), 'CCC', 'native undo should revert the buffer');
        assert.strictEqual(documents.get(asset.uniqueId), 'CCC', 'native undo should sync OT doc');

        const redoOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['AAA\nBBB', { d: 3 }]]);
        await vscode.commands.executeCommand('redo');
        await assertResolves(redoOp, 'native redo op');
        await waitForIdle('native redo settle');

        assert.strictEqual(norm(tdoc.getText()), 'AAA\nBBB', 'native redo should restore pasted text');
        assert.strictEqual(documents.get(asset.uniqueId), 'AAA\nBBB', 'native redo should sync OT doc');
    });

    test('playcanvas.undo/redo command after CRLF shared-prefix paste stays synced', async () => {
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'crlf_cmd_undo.js', content: 'AAA\nBBB\nCCC' });
        assert.ok(asset, 'asset should be created');

        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(tdoc);
        await assertResolves(
            new Promise<void>((resolve) => {
                if (!tdoc.isDirty && norm(tdoc.getText()) === 'AAA\nBBB\nCCC') {
                    resolve();
                    return;
                }
                const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                    if (e.document.uri.toString() !== uri.toString()) {
                        return;
                    }
                    if (!tdoc.isDirty && norm(tdoc.getText()) === 'AAA\nBBB\nCCC') {
                        disposable.dispose();
                        resolve();
                    }
                });
            }),
            'initial document settle'
        );

        await editor.edit((edit) => {
            edit.setEndOfLine(vscode.EndOfLine.CRLF);
        });
        assert.strictEqual(tdoc.eol, vscode.EndOfLine.CRLF, 'document should use CRLF for this regression');

        // whole-buffer paste that SHARES a prefix (prefix>0 -> no leading-0 op,
        // so this exercises the applyOp path, not the #318 leading-0 fix)
        const pasteOp = assertOpsPromise(`documents:${asset.uniqueId}`, [[4, 'XXX', { d: 3 }]]);
        await editor.edit(
            (edit) => {
                edit.replace(
                    new vscode.Range(tdoc.positionAt(0), tdoc.positionAt(tdoc.getText().length)),
                    'AAA\r\nXXX\r\nCCC'
                );
            },
            { undoStopBefore: true, undoStopAfter: true }
        );
        await assertResolves(pasteOp, 'CRLF shared-prefix paste op');
        await waitForIdle('CRLF paste settle');

        assert.strictEqual(norm(tdoc.getText()), 'AAA\nXXX\nCCC', 'buffer should contain pasted text');
        assert.strictEqual(documents.get(asset.uniqueId), 'AAA\nXXX\nCCC', 'OT doc should match pasted buffer');

        // undo via the command path (applyOp) — buffer + OT must both revert.
        // semanticInvert mirrors structure: the insert-first paste op inverts to
        // a delete-first undo op.
        const undoOp = assertOpsPromise(`documents:${asset.uniqueId}`, [[4, { d: 3 }, 'BBB']]);
        await vscode.commands.executeCommand('playcanvas.undo');
        await assertResolves(undoOp, 'command undo op');
        await waitForIdle('command undo settle');
        assert.strictEqual(norm(tdoc.getText()), 'AAA\nBBB\nCCC', 'undo should revert the buffer');
        assert.strictEqual(documents.get(asset.uniqueId), 'AAA\nBBB\nCCC', 'undo should sync OT doc');

        const redoOp = assertOpsPromise(`documents:${asset.uniqueId}`, [[4, 'XXX', { d: 3 }]]);
        await vscode.commands.executeCommand('playcanvas.redo');
        await assertResolves(redoOp, 'command redo op');
        await waitForIdle('command redo settle');
        assert.strictEqual(norm(tdoc.getText()), 'AAA\nXXX\nCCC', 'redo should restore pasted text');
        assert.strictEqual(documents.get(asset.uniqueId), 'AAA\nXXX\nCCC', 'redo should sync OT doc');

        // second undo must revert cleanly — no duplication / offset corruption
        const undoOp2 = assertOpsPromise(`documents:${asset.uniqueId}`, [[4, { d: 3 }, 'BBB']]);
        await vscode.commands.executeCommand('playcanvas.undo');
        await assertResolves(undoOp2, 'command second undo op');
        await waitForIdle('command second undo settle');
        assert.strictEqual(norm(tdoc.getText()), 'AAA\nBBB\nCCC', 'second undo should revert again');
        assert.strictEqual(documents.get(asset.uniqueId), 'AAA\nBBB\nCCC', 'second undo should sync OT doc');
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
        const localSettled = waitForApplyEdit(uri, 2, 'undo skip first dirty reload');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(localOp, 'local op');
        await localSettled;
        await waitForIdle('undo skip local edit settle');
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
        await waitForIdle('undo skip remote edit settle');
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
        await waitForIdle('undo skip settle');

        assert.strictEqual(tdoc.getText(), '// REMOTE\n// ORIGINAL', 'remote edit preserved, local reverted');
        assert.strictEqual(documents.get(asset.uniqueId), '// REMOTE\n// ORIGINAL', 'OT doc should match buffer');
    });

    test('mock fidelity - sharedb doc is LF-canonicalized on subscribe', async () => {
        // production server (collab-server/lib/documents.js) replaces \r\n and \r with \n
        // before storing, and the client's norm() in src/utils/text.ts mirrors this on the
        // outbound side. without this normalization the buffer would diverge from doc.text
        // on any disk↔server crossing — the mock must match or assertions about doc.data
        // drift from production.
        const id = 9999;
        documents.set(id, 'a\r\nb\rc\n');
        assets.set(id, { uniqueId: id, item_id: `${id}`, name: 'crlf.txt', path: [], type: 'script' });
        try {
            const doc = await sharedb.subscribe('documents', `${id}`);
            assert.strictEqual(doc.data, 'a\nb\nc\n', 'sharedb-loaded doc must be LF-canonical');
        } finally {
            await sharedb.unsubscribe('documents', `${id}`);
            documents.delete(id);
            assets.delete(id);
        }
    });

    test('undo stack cleared after server-driven reload', async () => {
        // sharedb ingestSnapshot (hard rollback / version mismatch) replaces doc.data
        // wholesale; the inverse ops on the undo stack reference offsets in the
        // pre-reload buffer and would corrupt content if applied. Disk._dirtyReload
        // clears the per-uri UndoManager — verify that running undo after a reload
        // is a no-op (does not resurrect content, does not crash).
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'undo_after_reload.js', content: '// ORIG\n' });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        // local edit so undo has something to revert
        const localOp = assertOpsPromise(`documents:${asset.uniqueId}`, [['// LOCAL\n']]);
        const localSettled = waitForApplyEdit(uri, 2, 'undo reload first dirty reload');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// LOCAL\n');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(localOp, 'local op');
        await localSettled;
        await waitForIdle('undo reload local edit settle');
        assert.strictEqual(tdoc.getText(), '// LOCAL\n// ORIG\n');

        // server ingestSnapshot replaces buffer; undo must drop its inverses
        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb doc should exist');
        const replaced = '// SERVER REPLACED\n';
        const reloaded = new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === uri.toString() && tdoc.getText() === replaced) {
                    disposable.dispose();
                    resolve();
                }
            });
        });
        doc.reload(replaced);
        documents.set(asset.uniqueId, replaced);
        await assertResolves(reloaded, 'reload applied');
        await waitForIdle('undo reload settle');

        // undo should be a no-op now — stack was cleared. buffer must stay at server snapshot.
        await vscode.commands.executeCommand('playcanvas.undo');
        assert.strictEqual(tdoc.getText(), replaced, 'undo after reload must not resurrect pre-reload content');
    });

    test('submit rejection surfaces stuck → desync', async () => {
        // production: collab-server middleware/submit.js rejects ops with strings like
        // `forbidden(N)` or `invalid:path`. OTDocument's submit callback calls _stick
        // on err, which surfaces ProjectManager.desync, which lights the status-bar
        // item and fires a one-shot toast. without async/reject hooks in the mock this
        // entire surface was unreachable from tests.
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'stuck_rejection.js', content: '// ORIG\n' });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        const doc = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(doc, 'sharedb doc should exist');
        warningMessageStub.resetHistory();
        doc._rejectNext = 'forbidden(5)';

        // local edit triggers submit; mock callback fires err → OTDocument._stick → desync
        const stuck = waitForEmit('stuck', () => true, 'ot stuck');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// REJECTED\n');
        await vscode.workspace.applyEdit(edit);
        await stuck;

        assert.ok(
            warningMessageStub.calledWith(sinon.match(/out of sync/i)),
            'desync toast must fire after submit rejection'
        );
    });

    test('save retry runs when doc:save ack is missing', async function () {
        this.timeout(SAVE_RETRY_TIMEOUT);

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'save_missing_ack.js', content: '// ORIG\n' });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// EDIT\n');
        await vscode.workspace.applyEdit(edit);

        sharedb.saveResponses.set(asset.uniqueId, ['timeout', 'success']);
        sharedb.sendRaw.resetHistory();
        const saved = waitForEmit(
            'doc:save',
            (args) => args[0] === 'success' && args[1] === asset.uniqueId,
            'doc save timeout retry',
            SAVE_RETRY_TIMEOUT
        );
        await tdoc.save();
        await saved;

        const calls = sharedb.sendRaw.getCalls().map((c) => `${c.args[0]}`);
        const docSaves = calls.filter((c) => c === `doc:save:${asset.uniqueId}`);
        const reconnects = calls.filter((c) => c === `doc:reconnect:${asset.uniqueId}`);
        assert.strictEqual(docSaves.length, 2, 'expected timed-out doc:save + retry doc:save');
        assert.strictEqual(reconnects.length, 1, 'expected one doc:reconnect after missing ack');
    });

    test('multi-edit batch offsets cumulate correctly', async () => {
        // CLAUDE.md OT-compliance invariant: vscode2sharedb adjusts each contentChange
        // offset by the cumulative insertLength − deleteLength of preceding changes in
        // the same batch — raw contentChanges offsets are pre-batch-relative. without
        // this adjustment the second/third edit lands at the wrong offset on the wire.
        // Drive a single applyEdit with three inserts and verify each op resolves to a
        // pre-batch offset that, when applied in order, reproduces the final buffer.
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'multi_edit_batch.js', content: 'AAA\nBBB\nCCC\n' });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        // expected ops: each prefixed by a skip equal to where the insertion lands in the
        // server's buffer at the moment that op is applied. Three inserts at original
        // positions [0,0], [1,0], [2,0] of the pre-batch buffer (lines AAA / BBB / CCC).
        // Server-side, the inserts apply sequentially, so each offset is relative to the
        // already-mutated buffer — the cumulative-adjust logic in vscode2sharedb turns
        // VS Code's pre-batch offsets into the post-batch-cumulative offsets ot-text wants.
        const collected: unknown[] = [];
        const docMock = sharedb.subscriptions.get(`documents:${asset.uniqueId}`);
        assert.ok(docMock, 'sharedb doc should exist');
        const ops = new Promise<void>((resolve) => {
            const onop = (args: unknown) => {
                collected.push(args);
                if (collected.length === 3) {
                    docMock.off('op', onop);
                    resolve();
                }
            };
            docMock.on('op', onop);
        });

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '1');
        edit.insert(uri, new vscode.Position(1, 0), '2');
        edit.insert(uri, new vscode.Position(2, 0), '3');
        await vscode.workspace.applyEdit(edit);
        await assertResolves(ops, 'multi-edit ops');

        // final document must match what VS Code rendered locally — confirms the wire
        // ops, when applied in their submitted order, reproduce the buffer state.
        assert.strictEqual(tdoc.getText(), '1AAA\n2BBB\n3CCC\n', 'buffer content sanity');
        assert.strictEqual(documents.get(asset.uniqueId), '1AAA\n2BBB\n3CCC\n', 'mock-applied ops must match buffer');
    });

    test('mock fidelity - asset doc op mutates snapshot (rename)', async () => {
        // production handler at src/project-manager.ts:212-216 applies oi/od/li/ld
        // against an internal snapshot when the asset doc emits an 'op' event. mock
        // must mirror this so doc.data and assets.get(id) stay in lockstep — without
        // the applier, an asset rename test would only pass because MockRest.assetRename
        // mutates the assets map directly, masking real op-handler regressions.
        const asset = await assetCreate({ name: 'rename_via_op.js', content: '// X\n' });
        const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
        assert.ok(doc, 'asset doc should exist');

        doc.submitOp([{ p: ['name'], oi: 'renamed_via_op.js' }], { source: 'remote' });

        const data = doc.data as { name: string };
        assert.strictEqual(data.name, 'renamed_via_op.js', 'doc.data should reflect oi');
        assert.strictEqual(assets.get(asset.uniqueId)?.name, 'renamed_via_op.js', 'assets map shares the reference');
    });

    test('mock fidelity - asset doc op updates path on folder move', async () => {
        // exercises the loose splice semantics: [{p:['path'], li: folderId}] lands
        // li at index parseInt('path',10)||0 === 0 — same as production's _addAsset
        // handler at src/project-manager.ts:227-231.
        const folder = await assetCreate({ name: 'move_target_folder' });
        const file = await assetCreate({ name: 'move_subject.js', content: '// X\n' });
        const doc = sharedb.subscriptions.get(`assets:${file.uniqueId}`);
        assert.ok(doc, 'asset doc should exist');

        doc.submitOp([{ p: ['path'], li: folder.uniqueId }], { source: 'remote' });

        const data = doc.data as { path: number[] };
        assert.deepStrictEqual(data.path, [folder.uniqueId], 'path array should have the folder id appended at idx 0');
    });

    test('mock fidelity - settings doc remote op mutates singleton', async () => {
        // settings doc.data is a reference to the projectSettings singleton
        // (src/test/mocks/sharedb.ts:195) — mutation must land on the same object so
        // production-style settings consumers (none today, but forward-insurance) see
        // the change. use an unused field so other tests reading projectSettings.branch
        // are unaffected.
        const doc = sharedb.subscriptions.get(`settings:project_${project.id}_${user.id}`);
        assert.ok(doc, 'settings doc should exist');

        doc.submitOp([{ p: ['_p2_marker'], oi: 'x' }], { source: 'remote' });

        const data = doc.data as Record<string, unknown>;
        assert.strictEqual(data._p2_marker, 'x', 'doc.data should reflect oi');
        assert.strictEqual(
            (projectSettings as Record<string, unknown>)._p2_marker,
            'x',
            'projectSettings singleton should be mutated in place'
        );
        // cleanup so the marker doesn't leak into a downstream test
        delete (projectSettings as Record<string, unknown>)._p2_marker;
    });

    test('save retry recovers after single doc:save:error', async () => {
        // collab-server may respond doc:save:error:N (e.g. transient S3 hiccup).
        // ProjectManager._verifySave (src/project-manager.ts:399-422) schedules a
        // retry after SAVE_RETRY_DELAY_MS (2000ms): doc:reconnect:N then doc:save:N.
        // without P2.3's failNextSave hook this branch was unreachable from tests.
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        const asset = await assetCreate({ name: 'save_retry.js', content: '// ORIG\n' });
        const uri = vscode.Uri.joinPath(folderUri, asset.name);
        const tdoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(tdoc);

        // dirty the doc so a save actually rounds the server
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '// EDIT\n');
        await vscode.workspace.applyEdit(edit);

        sharedb.failNextSave(asset.uniqueId, 1);
        sharedb.sendRaw.resetHistory();
        const saved = waitForEmit(
            'doc:save',
            (args) => args[0] === 'success' && args[1] === asset.uniqueId,
            'doc save retry',
            RETRY_TIMEOUT
        );
        await tdoc.save();
        await saved;

        const calls = sharedb.sendRaw.getCalls().map((c) => `${c.args[0]}`);
        const docSaves = calls.filter((c) => c === `doc:save:${asset.uniqueId}`);
        const reconnects = calls.filter((c) => c === `doc:reconnect:${asset.uniqueId}`);
        assert.strictEqual(docSaves.length, 2, 'expected initial doc:save + retry doc:save');
        assert.strictEqual(reconnects.length, 1, 'expected one doc:reconnect during retry');
    });

    test('rest assetCreate failure surfaces error to user', async () => {
        // production: pm.create wraps rest.assetCreate in guard() (project-manager.ts:939)
        // which sets pm.error on throw; the extension error effect calls handleError
        // which posts via vscode.window.showErrorMessage. without P2.4's failNext hook
        // this entire user-visible path was unreachable from tests.
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(folderUri, 'workspace folder should exist');

        errorMessageStub.resetHistory();
        rest.failNext('assetCreate', new Error('mock 500: assetCreate refused'));

        const fileUri = vscode.Uri.joinPath(folderUri, 'rest_fail_create.js');
        const processed = waitForMutex(
            (keys) => keys.includes('rest_fail_create.js'),
            'rest assetCreate failure',
            3000
        );
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode('// LOCAL\n'));
        await processed;

        const errorCall = errorMessageStub
            .getCalls()
            .find((c) => `${c.args[0]}`.includes('mock 500: assetCreate refused'));
        assert.ok(errorCall, 'showErrorMessage must surface the rest failure');
    });
});

// regression: after an OS suspend (windows lock for hours) the websocket can
// return as a half-open zombie whose buffered traffic keeps refreshing ShareDb._lastPong,
// so the pong-timeout never trips, the doc never re-syncs, and resumed edits roll back
// collaborators. the resume guard fires on the wall-clock jump regardless of inbound
// traffic. exercises the real ShareDb (not the mock) against a local ws server; the
// identical guard is mirrored in Messenger and Relay.
suite('connections - suspend recovery', () => {
    // MockShareDb extends the real class, so its prototype is the unstubbed ShareDb
    const RealShareDb = Object.getPrototypeOf(MockShareDb) as typeof sharedbModule.ShareDb;
    const clock = sinon.createSandbox();
    let server: WebSocketServer;
    let port = 0;
    let connections = 0;
    let keepalives: NodeJS.Timeout[] = [];
    let sb: InstanceType<typeof sharedbModule.ShareDb> | undefined;

    suiteSetup(async () => {
        await new Promise<void>((resolve) => {
            server = new WebSocketServer({ port: 0 }, () => {
                port = (server.address() as { port: number }).port;
                resolve();
            });
        });
        server.on('connection', (ws) => {
            connections++;
            ws.on('message', (raw) => {
                const str = raw.toString();
                if (str.startsWith('auth')) {
                    ws.send(`auth${JSON.stringify({ id: 1 })}`);
                    // simulate buffered server traffic delivered on resume — any inbound
                    // message refreshes ShareDb._lastPong, masking the dead socket
                    keepalives.push(setInterval(() => ws.readyState === ws.OPEN && ws.send('hb:0'), 200));
                    return;
                }
                // complete the sharedb protocol handshake so Connection.ping() can send
                const [, msg] = tryCatchSync(() => JSON.parse(str));
                if (msg?.a === 'hs') {
                    ws.send(JSON.stringify({ a: 'hs', protocol: 1, protocolMinor: 1, id: '1', type: 'json0' }));
                }
            });
        });
    });

    suiteTeardown(async () => {
        keepalives.forEach(clearInterval);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    setup(() => {
        connections = 0;
        keepalives = [];
    });

    teardown(() => {
        clock.restore();
        keepalives.forEach(clearInterval);
        sb?.disconnect();
        sb = undefined;
    });

    test('forces a reconnect on wall-clock jump even while traffic keeps the socket alive', async function () {
        this.timeout(20000);

        sb = new RealShareDb({ url: `ws://127.0.0.1:${port}`, origin: 'http://localhost' });
        await sb.connect(async () => 'token');
        assert.strictEqual(connections, 1, 'should connect once');

        // simulate resume from suspend: wall-clock jumps past the resume gap while the
        // server keeps sending traffic, so the pong-timeout never trips on its own.
        // compute target before stubbing — Date.now() in the arg would hit the new stub
        const jumped = Date.now() + RESUME_GAP_MS + 5000;
        clock.stub(Date, 'now').returns(jumped);

        // the next heartbeat tick should detect the gap and force-close → reconnect.
        // poll on iteration count, not Date.now (stubbed) — ~15s real ceiling
        for (let i = 0; i < 150 && connections < 2; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.strictEqual(connections, 2, 'resume guard should force exactly one reconnect');
    });
});
