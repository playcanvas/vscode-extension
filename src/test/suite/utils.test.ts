import * as assert from 'assert';
import * as os from 'os';

import { type as ottext } from 'ot-text';
import * as vscode from 'vscode';

import type { ProjectManager } from '../../project-manager';
import { BaseStore } from '../../sync/base-store';
import { hasConflictMarkers } from '../../sync/markers';
import { merge } from '../../sync/merge';
import { scmDecoration } from '../../sync/scm';
import { classify } from '../../sync/status';
import { NativeSyncEngine } from '../../sync/sync-engine';
import type { EventMap } from '../../typings/event-map';
import type { Project } from '../../typings/models';
import type { ShareDbTextOp } from '../../typings/sharedb';
import * as buffer from '../../utils/buffer';
import { EventEmitter } from '../../utils/event-emitter';
import { delta, norm } from '../../utils/text';
import { sanitizeName, projectToName, hash, tryCatch } from '../../utils/utils';

suite('utils', () => {
    test('sanitize name - preserves spaces', () => {
        assert.strictEqual(sanitizeName('hello world'), 'hello world');
    });

    test('sanitize name - replaces slash', () => {
        assert.strictEqual(sanitizeName('foo/bar'), 'foo_bar');
    });

    test('sanitize name - replaces illegal chars', () => {
        assert.strictEqual(sanitizeName('a<>:"|?*b'), 'a_______b');
    });

    test('sanitize name - preserves leading dots', () => {
        assert.strictEqual(sanitizeName('...hidden'), '...hidden');
    });

    test('sanitize name - trims trailing dots and spaces', () => {
        assert.strictEqual(sanitizeName('trailing. '), 'trailing');
    });

    test('sanitize name - preserves legal special chars', () => {
        assert.strictEqual(sanitizeName('My Project!'), 'My Project!');
    });

    test('sanitize name - preserves emoji', () => {
        assert.strictEqual(sanitizeName('Cool 😀 Project'), 'Cool 😀 Project');
    });

    test('sanitize name - prefixes windows reserved names', () => {
        assert.strictEqual(sanitizeName('CON'), '_CON');
    });

    test('sanitize name - empty fallback', () => {
        assert.strictEqual(sanitizeName('///'), '___');
    });

    test('project to name - encoded', () => {
        assert.strictEqual(projectToName({ name: 'My Project!', id: 42 } as Project), 'My Project! (42)');
    });

    test('project to name - raw', () => {
        assert.strictEqual(projectToName({ name: 'foo/bar', id: 1 } as Project, false), 'foo/bar (1)');
    });
});

suite('delta', () => {
    // #318: delta must not emit a leading 0 skip — ot-text checkOp rejects it
    // (threw in semanticInvert on a crlf select-all+paste, desyncing the doc)

    test('full replace at offset 0 - valid op, no leading 0 skip', () => {
        const op = delta('CCC', 'AAA\nBBB');
        assert.ok(op);
        assert.doesNotThrow(() => ottext.semanticInvert('CCC', op));
        assert.strictEqual(ottext.apply('CCC', op), 'AAA\nBBB');
    });

    test('insert at offset 0 - valid op, no leading 0 skip', () => {
        const op = delta('BC', 'ABC');
        assert.ok(op);
        assert.doesNotThrow(() => ottext.semanticInvert('BC', op));
        assert.strictEqual(ottext.apply('BC', op), 'ABC');
    });

    test('delete at offset 0 - valid op, no leading 0 skip', () => {
        const op = delta('ABC', 'BC');
        assert.ok(op);
        assert.doesNotThrow(() => ottext.semanticInvert('ABC', op));
        assert.strictEqual(ottext.apply('ABC', op), 'BC');
    });
});

suite('sync/markers', () => {
    test('detects start marker', () => {
        assert.strictEqual(hasConflictMarkers('foo\n<<<<<<< Working (your changes)\nbar'), true);
    });

    test('detects separator and end markers', () => {
        assert.strictEqual(hasConflictMarkers('a\n=======\nb'), true);
        assert.strictEqual(hasConflictMarkers('a\n>>>>>>> Server (origin)'), true);
    });

    test('clean text has no markers', () => {
        assert.strictEqual(hasConflictMarkers('const x = 1;\n// a <= b comparison\n'), false);
    });

    test('does not false-positive on shorter runs', () => {
        assert.strictEqual(hasConflictMarkers('a <<<< b\n====\n'), false);
    });
});

suite('sync/merge', () => {
    test('no changes returns base, not conflicted', () => {
        const r = merge('a\nb\n', 'a\nb\n', 'a\nb\n');
        assert.strictEqual(r.conflicted, false);
        assert.strictEqual(r.text, 'a\nb\n');
    });

    test('local-only change is kept (remote unchanged)', () => {
        const r = merge('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n');
        assert.strictEqual(r.conflicted, false);
        assert.strictEqual(r.text, 'a\nB\nc\n');
    });

    test('remote-only change is kept (local unchanged)', () => {
        const r = merge('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nC\n');
        assert.strictEqual(r.conflicted, false);
        assert.strictEqual(r.text, 'a\nb\nC\n');
    });

    test('non-overlapping changes merge cleanly', () => {
        const r = merge('one\ntwo\nthree\nfour\n', 'ONE\ntwo\nthree\nfour\n', 'one\ntwo\nthree\nFOUR\n');
        assert.strictEqual(r.conflicted, false);
        assert.strictEqual(r.text, 'ONE\ntwo\nthree\nFOUR\n');
    });

    test('identical changes converge without conflict', () => {
        const r = merge('a\nb\n', 'a\nX\n', 'a\nX\n');
        assert.strictEqual(r.conflicted, false);
        assert.strictEqual(r.text, 'a\nX\n');
    });

    test('overlapping changes produce conflict markers', () => {
        const r = merge('a\nb\nc\n', 'a\nLOCAL\nc\n', 'a\nREMOTE\nc\n');
        assert.strictEqual(r.conflicted, true);
        assert.ok(r.text.includes('<<<<<<< Working (your changes)'), 'has start marker');
        assert.ok(r.text.includes('LOCAL'), 'has local side');
        assert.ok(r.text.includes('======='), 'has separator');
        assert.ok(r.text.includes('REMOTE'), 'has remote side');
        assert.ok(r.text.includes('>>>>>>> Server (origin)'), 'has end marker');
    });

    test('normalizes CRLF before merging', () => {
        const r = merge('a\r\nb\r\n', 'a\r\nb\r\n', 'a\r\nB\r\n');
        assert.strictEqual(r.conflicted, false);
        assert.strictEqual(r.text, 'a\nB\n');
    });
});

suite('sync/status', () => {
    const B = hash('base');
    const W = hash('work');
    const R = hash('remote');

    test('clean when all equal', () => {
        assert.strictEqual(classify(B, B, B, 'base'), 'clean');
    });

    test('modified when only working differs', () => {
        assert.strictEqual(classify(B, W, B, 'work'), 'modified');
    });

    test('behind when only remote differs', () => {
        assert.strictEqual(classify(B, B, R, 'base'), 'behind');
    });

    test('both when working and remote differ', () => {
        assert.strictEqual(classify(B, W, R, 'work'), 'both');
    });

    test('conflicted overrides when markers present', () => {
        assert.strictEqual(classify(B, W, R, 'a\n<<<<<<< Working (your changes)\nb'), 'conflicted');
    });
});

suite('sync/scm', () => {
    test('uses git-style letters for resource states', () => {
        assert.strictEqual(scmDecoration('modified').letter, 'M');
        assert.strictEqual(scmDecoration('behind').letter, 'M');
        assert.strictEqual(scmDecoration('both').letter, 'M');
        assert.strictEqual(scmDecoration('added').letter, 'A');
        assert.strictEqual(scmDecoration('deleted').letter, 'D');
        assert.strictEqual(scmDecoration('renamed').letter, 'R');
        assert.strictEqual(scmDecoration('conflicted').letter, '!');
        assert.strictEqual(scmDecoration('deleted').decorations.strikeThrough, true);
    });
});

suite('sync/base-store', () => {
    const dir = vscode.Uri.joinPath(vscode.Uri.file(os.tmpdir()), 'pc-base-store-test');

    const clean = async () => {
        await tryCatch(async () => vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }));
    };

    setup(clean);
    suiteTeardown(clean);

    test('set and get round-trip with hash', () => {
        const store = new BaseStore({ storageUri: dir });
        store.set(1, 'hello\nworld\n');
        const entry = store.get(1);
        assert.ok(entry);
        assert.strictEqual(entry.text, 'hello\nworld\n');
        assert.strictEqual(entry.hash, hash('hello\nworld\n'));
    });

    test('set normalizes CRLF before hashing', () => {
        const store = new BaseStore({ storageUri: dir });
        store.set(1, 'a\r\nb');
        assert.strictEqual(store.get(1)?.text, 'a\nb');
        assert.strictEqual(store.get(1)?.hash, hash('a\nb'));
    });

    test('persists across reload', async () => {
        const a = new BaseStore({ storageUri: dir });
        await a.load(7, 'main');
        a.set(1, 'first');
        a.set(2, 'second');
        await a.flush();

        const b = new BaseStore({ storageUri: dir });
        await b.load(7, 'main');
        assert.strictEqual(b.get(1)?.text, 'first');
        assert.strictEqual(b.get(2)?.text, 'second');
    });

    test('load clears entries when no file exists', async () => {
        const store = new BaseStore({ storageUri: dir });
        store.set(99, 'stale');
        await store.load(123, 'branch-x');
        assert.strictEqual(store.get(99), undefined);
    });

    test('separate project+branch keys are isolated', async () => {
        const a = new BaseStore({ storageUri: dir });
        await a.load(1, 'main');
        a.set(1, 'on-main');
        await a.flush();

        const b = new BaseStore({ storageUri: dir });
        await b.load(1, 'dev');
        assert.strictEqual(b.get(1), undefined);
    });
});

suite('sync/sync-engine', () => {
    const root = vscode.Uri.joinPath(vscode.Uri.file(os.tmpdir()), 'pc-sync-engine-test');
    const storage = vscode.Uri.joinPath(root, 'storage');
    const work = vscode.Uri.joinPath(root, 'work');

    const clean = async () => {
        await tryCatch(async () => vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }));
    };

    setup(clean);
    suiteTeardown(clean);

    const writeFile = async (name: string, text: string) => {
        await vscode.workspace.fs.createDirectory(work);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(work, name), buffer.from(text));
    };

    const readFile = async (name: string) =>
        buffer.toString(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(work, name)));

    const exists = async (name: string) => {
        const [err] = await tryCatch(async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(work, name)));
        return !err;
    };

    const engine = () => new NativeSyncEngine({ events: new EventEmitter<EventMap>(), storageUri: storage });

    const pmWith = (doc: { text: string }) => {
        const files = new Map([['a.js', { type: 'file', uniqueId: 1, doc, dirty: false }]]);
        return { files } as unknown as ProjectManager;
    };

    // pm whose doc records submitted ops and applies them (simulating the server)
    const pushPm = () => {
        const applied: ShareDbTextOp[] = [];
        const saved: string[] = [];
        const doc = {
            text: 'x\n',
            apply(op: ShareDbTextOp) {
                applied.push(op);
                doc.text = ottext.apply(doc.text, op) as string;
            }
        };
        const file = { type: 'file', uniqueId: 1, doc, dirty: false };
        const files = new Map([['a.js', file]]);
        const pm = {
            files,
            // mirrors ProjectManager.write: delta vs live doc, mark dirty
            write: async (_p: string, content: Uint8Array) => {
                const op = delta(doc.text, norm(buffer.toString(content)));
                if (!op) {
                    return;
                }
                doc.apply(op);
                file.dirty = true;
            },
            save: (p: string) => saved.push(p)
        } as unknown as ProjectManager;
        return { pm, doc, applied, saved };
    };

    test('clean when working equals remote', async () => {
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith({ text: 'x\n' }), projectId: 1, branchId: 'main' });
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('modified when working diverges from base', async () => {
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith({ text: 'x\n' }), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'modified');
    });

    test('behind when remote advances past base', async () => {
        await writeFile('a.js', 'x\n');
        const doc = { text: 'x\n' };
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith(doc), projectId: 1, branchId: 'main' });
        doc.text = 'x\nremote\n';
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'behind');
    });

    test('both when working and remote diverge', async () => {
        await writeFile('a.js', 'x\n');
        const doc = { text: 'x\n' };
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith(doc), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        doc.text = 'x\nremote\n';
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'both');
    });

    test('conflicted when working has markers', async () => {
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith({ text: 'x\n' }), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\n<<<<<<< Working (your changes)\na\n=======\nb\n>>>>>>> Server (origin)\n');
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'conflicted');
    });

    test('base persists across relink', async () => {
        await writeFile('a.js', 'x\n');
        const e1 = engine();
        await e1.link({ folderUri: work, projectManager: pmWith({ text: 'x\n' }), projectId: 1, branchId: 'main' });
        await e1.unlink();

        await writeFile('a.js', 'x\nlocal\n');
        const e2 = engine();
        await e2.link({ folderUri: work, projectManager: pmWith({ text: 'x\n' }), projectId: 1, branchId: 'main' });
        assert.strictEqual(e2.status('a.js'), 'modified');
    });

    test('pull - fast-forward when no local edits', async () => {
        await writeFile('a.js', 'x\n');
        const doc = { text: 'x\n' };
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith(doc), projectId: 1, branchId: 'main' });
        doc.text = 'x\ny\n';
        await e.pull();
        assert.strictEqual(await readFile('a.js'), 'x\ny\n');
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('pull - leaves local edits when remote unchanged', async () => {
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith({ text: 'x\n' }), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        await e.pull();
        assert.strictEqual(await readFile('a.js'), 'x\nlocal\n');
        assert.strictEqual(e.status('a.js'), 'modified');
    });

    test('pull - clean 3-way merge of non-overlapping edits', async () => {
        await writeFile('a.js', 'a\nb\nc\n');
        const doc = { text: 'a\nb\nc\n' };
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith(doc), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'A\nb\nc\n');
        doc.text = 'a\nb\nC\n';
        await e.pull();
        assert.strictEqual(await readFile('a.js'), 'A\nb\nC\n');
        assert.strictEqual(e.status('a.js'), 'modified');
    });

    test('pull - conflict writes markers and stays conflicted', async () => {
        await writeFile('a.js', 'a\nb\nc\n');
        const doc = { text: 'a\nb\nc\n' };
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith(doc), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'a\nLOCAL\nc\n');
        doc.text = 'a\nREMOTE\nc\n';
        await e.pull();
        assert.ok((await readFile('a.js')).includes('<<<<<<< Working (your changes)'), 'has markers');
        assert.strictEqual(e.status('a.js'), 'conflicted');
    });

    test('pull - applies remote create only when pulled', async () => {
        const events = new EventEmitter<EventMap>();
        const files = new Map<string, unknown>();
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });

        files.set('new.js', { type: 'file', uniqueId: 10, doc: { text: 'remote\n' }, dirty: false });
        events.emit('asset:file:create', 'new.js', 'file', buffer.from('remote\n'));
        assert.strictEqual(await exists('new.js'), false);
        assert.strictEqual(e.status('new.js'), 'behind');

        events.on('sync:file:apply:create', async (path, _type, content, done) => {
            await writeFile(path, norm(buffer.toString(content)));
            done();
        });
        await e.pull();
        assert.strictEqual(await readFile('new.js'), 'remote\n');
        assert.strictEqual(e.status('new.js'), 'clean');
    });

    test('pull - applies remote delete only when pulled', async () => {
        await writeFile('a.js', 'x\n');
        const events = new EventEmitter<EventMap>();
        const files = new Map<string, unknown>([
            ['a.js', { type: 'file', uniqueId: 1, doc: { text: 'x\n' }, dirty: false }]
        ]);
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });

        files.delete('a.js');
        events.emit('asset:file:delete', 'a.js');
        assert.strictEqual(await exists('a.js'), true);
        assert.strictEqual(e.status('a.js'), 'behind');

        events.on('sync:file:apply:delete', async (path, done) => {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(work, path), { recursive: false, useTrash: false });
            done();
        });
        await e.pull();
        assert.strictEqual(await exists('a.js'), false);
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('pull - applies remote rename only when pulled', async () => {
        await writeFile('a.js', 'x\n');
        const events = new EventEmitter<EventMap>();
        const file = { type: 'file', uniqueId: 1, doc: { text: 'x\n' }, dirty: false };
        const files = new Map<string, unknown>([['a.js', file]]);
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });

        files.delete('a.js');
        files.set('b.js', file);
        events.emit('asset:file:rename', 'a.js', 'b.js');
        assert.strictEqual(await exists('a.js'), true);
        assert.strictEqual(await exists('b.js'), false);
        assert.strictEqual(e.status('b.js'), 'behind');

        events.on('sync:file:apply:rename', async (from, to, done) => {
            await vscode.workspace.fs.rename(vscode.Uri.joinPath(work, from), vscode.Uri.joinPath(work, to));
            done();
        });
        await e.pull();
        assert.strictEqual(await exists('a.js'), false);
        assert.strictEqual(await readFile('b.js'), 'x\n');
        assert.strictEqual(e.status('b.js'), 'clean');
    });

    test('pull - applies remote rename over local edit as modified', async () => {
        await writeFile('a.js', 'x\n');
        const events = new EventEmitter<EventMap>();
        const file = { type: 'file', uniqueId: 1, doc: { text: 'x\n' }, dirty: false };
        const files = new Map<string, unknown>([['a.js', file]]);
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'local\n');
        await e.refresh();

        files.delete('a.js');
        files.set('b.js', file);
        events.emit('asset:file:rename', 'a.js', 'b.js');
        assert.strictEqual(e.status('b.js'), 'behind');

        events.on('sync:file:apply:rename', async (from, to, done) => {
            await vscode.workspace.fs.rename(vscode.Uri.joinPath(work, from), vscode.Uri.joinPath(work, to));
            done();
        });
        await e.pull();
        assert.strictEqual(await exists('a.js'), false);
        assert.strictEqual(await readFile('b.js'), 'local\n');
        assert.strictEqual(e.status('b.js'), 'modified');
    });

    test('pull - blocks remote delete over local edit', async () => {
        await writeFile('a.js', 'x\n');
        const events = new EventEmitter<EventMap>();
        const files = new Map<string, unknown>([
            ['a.js', { type: 'file', uniqueId: 1, doc: { text: 'x\n' }, dirty: false }]
        ]);
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'local\n');
        await e.refresh();

        files.delete('a.js');
        events.emit('asset:file:delete', 'a.js');
        assert.strictEqual(e.status('a.js'), 'conflicted');
        const [err] = await tryCatch(() => e.pull());
        assert.ok(err, 'pull should be blocked');
        assert.strictEqual(await readFile('a.js'), 'local\n');
    });

    test('pull - blocks remote create over local add', async () => {
        const events = new EventEmitter<EventMap>();
        const files = new Map<string, unknown>();
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('new.js', 'local\n');
        events.emit('sync:file:create', 'new.js', 'file');

        files.set('new.js', { type: 'file', uniqueId: 10, doc: { text: 'remote\n' }, dirty: false });
        events.emit('asset:file:create', 'new.js', 'file', buffer.from('remote\n'));
        assert.strictEqual(e.status('new.js'), 'conflicted');
        const [err] = await tryCatch(() => e.pull());
        assert.ok(err, 'pull should be blocked');
        assert.strictEqual(await readFile('new.js'), 'local\n');
    });

    test('structural conflict - keep current add becomes modified against remote create', async () => {
        const events = new EventEmitter<EventMap>();
        const file = { type: 'file', uniqueId: 10, doc: { text: 'remote\n' }, dirty: false };
        const files = new Map<string, unknown>();
        const written: string[] = [];
        const saved: string[] = [];
        const pm = {
            files,
            write: async (_p: string, content: Uint8Array) => {
                const op = delta(file.doc.text, norm(buffer.toString(content)));
                if (op) {
                    file.doc.text = ottext.apply(file.doc.text, op) as string;
                    written.push(file.doc.text);
                }
            },
            save: (p: string) => saved.push(p)
        } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('new.js', 'local\n');
        events.emit('sync:file:create', 'new.js', 'file');

        files.set('new.js', file);
        events.emit('asset:file:create', 'new.js', 'file', buffer.from('remote\n'));
        assert.ok(e.structuralConflict('new.js'));

        await e.keepCurrent(vscode.Uri.joinPath(work, 'new.js'));
        assert.strictEqual(e.status('new.js'), 'modified');
        await e.push();
        assert.deepStrictEqual(written, ['local\n']);
        assert.deepStrictEqual(saved, ['new.js']);
    });

    test('structural conflict - accept incoming create overwrites local add', async () => {
        const events = new EventEmitter<EventMap>();
        const files = new Map<string, unknown>();
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('new.js', 'local\n');
        events.emit('sync:file:create', 'new.js', 'file');

        files.set('new.js', { type: 'file', uniqueId: 10, doc: { text: 'remote\n' }, dirty: false });
        events.emit('asset:file:create', 'new.js', 'file', buffer.from('remote\n'));
        events.on('sync:file:apply:delete', async (path, done) => {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(work, path), { recursive: false, useTrash: false });
            done();
        });
        events.on('sync:file:apply:create', async (path, _type, content, done) => {
            await writeFile(path, norm(buffer.toString(content)));
            done();
        });

        await e.acceptIncoming(vscode.Uri.joinPath(work, 'new.js'));
        assert.strictEqual(await readFile('new.js'), 'remote\n');
        assert.strictEqual(e.status('new.js'), 'clean');
    });

    test('structural conflict - accept incoming delete removes local edit', async () => {
        await writeFile('a.js', 'local\n');
        const events = new EventEmitter<EventMap>();
        const files = new Map<string, unknown>([
            ['a.js', { type: 'file', uniqueId: 1, doc: { text: 'x\n' }, dirty: false }]
        ]);
        const pm = { files } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await e.refresh();
        files.delete('a.js');
        events.emit('asset:file:delete', 'a.js');
        events.on('sync:file:apply:delete', async (path, done) => {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(work, path), { recursive: false, useTrash: false });
            done();
        });

        await e.acceptIncoming(vscode.Uri.joinPath(work, 'a.js'));
        assert.strictEqual(await exists('a.js'), false);
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('push - submits delta, flushes, advances base', async () => {
        const { pm, applied, saved } = pushPm();
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'modified');
        await e.push();
        assert.strictEqual(applied.length, 1, 'one op submitted');
        assert.deepStrictEqual(applied[0], delta('x\n', 'x\nlocal\n'));
        assert.deepStrictEqual(saved, ['a.js'], 'flushed to server');
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('push - no-op when nothing modified', async () => {
        const { pm, applied, saved } = pushPm();
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await e.push();
        assert.strictEqual(applied.length, 0);
        assert.strictEqual(saved.length, 0);
    });

    test('push - rejected when behind (no force push)', async () => {
        const { pm, doc, applied } = pushPm();
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        doc.text = 'x\nremote\n';
        const [err] = await tryCatch(() => e.push());
        assert.ok(err, 'push should be rejected');
        assert.strictEqual(applied.length, 0, 'must not submit when behind');
    });

    test('baseText returns the seeded base for a tracked file', async () => {
        await writeFile('a.js', 'hello\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith({ text: 'hello\n' }), projectId: 1, branchId: 'main' });
        assert.strictEqual(e.baseText('a.js'), 'hello\n');
        assert.strictEqual(e.baseText('missing.js'), undefined);
    });

    test('remoteText returns the live doc text', async () => {
        await writeFile('a.js', 'hello\n');
        const doc = { text: 'hello\n' };
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith(doc), projectId: 1, branchId: 'main' });
        doc.text = 'hello\nremote\n';
        assert.strictEqual(await e.remoteText('a.js'), 'hello\nremote\n');
        assert.strictEqual(await e.remoteText('missing.js'), undefined);
    });

    test('remoteText subscribes stub to read realtime doc', async () => {
        await writeFile('a.js', 'x\n');
        let subscribed = 0;
        const file = { type: 'file', uniqueId: 1, doc: { text: 'x\nremote\n' }, dirty: false };
        const files = new Map<string, unknown>([['a.js', { type: 'stub', uniqueId: 1, dirty: false }]]);
        const pm = {
            files,
            subscribe: async (p: string) => {
                subscribed++;
                files.set(p, file);
                return file;
            },
            unsubscribe: async (p: string) => {
                files.set(p, { type: 'stub', uniqueId: 1, dirty: false });
            }
        } as unknown as ProjectManager;
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        assert.strictEqual(await e.remoteText('a.js'), 'x\nremote\n');
        assert.strictEqual(subscribed, 1);
        assert.strictEqual((files.get('a.js') as { type: string }).type, 'stub');
    });

    test('stub - ignores s3 hash until realtime doc is subscribed', async () => {
        await writeFile('a.js', 'x\n');
        let remoteHash = hash('x\n');
        const files = new Map([['a.js', { type: 'stub', uniqueId: 1, dirty: false }]]);
        const pm = { files, fileHash: () => remoteHash } as unknown as ProjectManager;
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        assert.strictEqual(e.status('a.js'), 'clean');
        remoteHash = hash('x\nremote\n');
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('pull - subscribes an unloaded stub and fast-forwards from realtime doc', async () => {
        await writeFile('a.js', 'x\n');
        const doc = { text: 'x\nremote\n' };
        const files = new Map<string, unknown>([['a.js', { type: 'stub', uniqueId: 1, dirty: false }]]);
        const pm = {
            files,
            // mirrors ProjectManager.subscribe: promotes the stub in place
            subscribe: async (p: string) => {
                const promoted = { type: 'file', uniqueId: 1, doc, dirty: false };
                files.set(p, promoted);
                return promoted;
            },
            // mirrors ProjectManager.unsubscribe: demotes back to a stub
            unsubscribe: async (p: string) => {
                files.set(p, { type: 'stub', uniqueId: 1, dirty: false });
            }
        } as unknown as ProjectManager;
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await e.pull();
        assert.strictEqual(await readFile('a.js'), 'x\nremote\n');
        assert.strictEqual(e.status('a.js'), 'clean');
        assert.strictEqual((files.get('a.js') as { type: string }).type, 'stub', 'released after pull');
    });

    test('subscribe upgrades stub status to the live doc', async () => {
        await writeFile('a.js', 'x\n');
        const files = new Map<string, unknown>([['a.js', { type: 'stub', uniqueId: 1, dirty: false }]]);
        const pm = { files } as unknown as ProjectManager;
        const events = new EventEmitter<EventMap>();
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        assert.strictEqual(e.status('a.js'), 'clean');
        // editor open promotes the stub; the doc carries unflushed remote edits
        files.set('a.js', { type: 'file', uniqueId: 1, doc: { text: 'x\nremote\n' }, dirty: true });
        events.emit('asset:file:subscribed', 'a.js', 'x\nremote\n', true);
        for (let i = 0; i < 50 && e.status('a.js') !== 'behind'; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.strictEqual(e.status('a.js'), 'behind');
    });

    test('push - releases the promoted doc once the flush lands', async () => {
        await writeFile('a.js', 'x\n');
        const doc = {
            text: 'x\n',
            apply(op: ShareDbTextOp) {
                doc.text = ottext.apply(doc.text, op) as string;
            }
        };
        const file = { type: 'file', uniqueId: 1, doc, dirty: false };
        const files = new Map<string, unknown>([['a.js', { type: 'stub', uniqueId: 1, dirty: false }]]);
        const pm = {
            files,
            subscribe: async (p: string) => {
                files.set(p, file);
                return file;
            },
            write: async (_p: string, content: Uint8Array) => {
                const op = delta(doc.text, norm(buffer.toString(content)));
                if (op) {
                    doc.apply(op);
                }
            },
            save: () => undefined,
            unsubscribe: async (p: string) => {
                files.set(p, { type: 'stub', uniqueId: 1, dirty: file.dirty });
            }
        } as unknown as ProjectManager;
        const events = new EventEmitter<EventMap>();
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        await e.refresh();
        await e.push();
        assert.strictEqual((files.get('a.js') as { type: string }).type, 'file', 'subscribed until flush ack');
        events.emit('asset:file:save', 'a.js');
        for (let i = 0; i < 50 && (files.get('a.js') as { type: string }).type !== 'stub'; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.strictEqual((files.get('a.js') as { type: string }).type, 'stub', 'released after flush ack');
    });

    test('push - subscribes a modified stub and submits', async () => {
        await writeFile('a.js', 'x\n');
        const applied: ShareDbTextOp[] = [];
        const saved: string[] = [];
        const doc = {
            text: 'x\n',
            apply(op: ShareDbTextOp) {
                applied.push(op);
                doc.text = ottext.apply(doc.text, op) as string;
            }
        };
        const file = { type: 'file', uniqueId: 1, doc, dirty: false };
        const files = new Map<string, unknown>([['a.js', { type: 'stub', uniqueId: 1, dirty: false }]]);
        const pm = {
            files,
            subscribe: async (p: string) => {
                files.set(p, file);
                return file;
            },
            // mirrors ProjectManager.write: delta vs live doc, mark dirty
            write: async (_p: string, content: Uint8Array) => {
                const op = delta(doc.text, norm(buffer.toString(content)));
                if (!op) {
                    return;
                }
                doc.apply(op);
                file.dirty = true;
            },
            save: (p: string) => saved.push(p)
        } as unknown as ProjectManager;
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'modified');
        await e.push();
        assert.strictEqual(applied.length, 1, 'one op submitted');
        assert.strictEqual(doc.text, 'x\nlocal\n');
        assert.deepStrictEqual(saved, ['a.js'], 'flushed to server');
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('push - rejects modified stub when realtime doc moved', async () => {
        await writeFile('a.js', 'x\n');
        const applied: ShareDbTextOp[] = [];
        const doc = {
            text: 'x\nremote\n',
            apply(op: ShareDbTextOp) {
                applied.push(op);
                doc.text = ottext.apply(doc.text, op) as string;
            }
        };
        const file = { type: 'file', uniqueId: 1, doc, dirty: false };
        const files = new Map<string, unknown>([['a.js', { type: 'stub', uniqueId: 1, dirty: false }]]);
        const pm = {
            files,
            subscribe: async (p: string) => {
                files.set(p, file);
                return file;
            },
            write: async (_p: string, content: Uint8Array) => {
                const op = delta(doc.text, norm(buffer.toString(content)));
                if (op) {
                    doc.apply(op);
                }
            },
            save: () => undefined,
            unsubscribe: async (p: string) => {
                files.set(p, { type: 'stub', uniqueId: 1, dirty: false });
            }
        } as unknown as ProjectManager;
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        await e.refresh();
        const [err] = await tryCatch(() => e.push());
        assert.ok(err, 'push should be rejected');
        assert.strictEqual(applied.length, 0);
    });

    test('push - creates local-only file', async () => {
        const events = new EventEmitter<EventMap>();
        const created: [string, 'file' | 'folder', string][] = [];
        const files = new Map<string, unknown>();
        const pm = {
            files,
            create: async (p: string, t: 'file' | 'folder', content?: Uint8Array) => {
                created.push([p, t, content ? norm(buffer.toString(content)) : '']);
                files.set(p, {
                    type: t,
                    uniqueId: 10,
                    doc: { text: content ? norm(buffer.toString(content)) : '' },
                    dirty: false
                });
            }
        } as unknown as ProjectManager;
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        await writeFile('new.js', 'new\n');
        events.emit('sync:file:create', 'new.js', 'file');

        assert.strictEqual(e.status('new.js'), 'added');
        await e.push();
        assert.deepStrictEqual(created, [['new.js', 'file', 'new\n']]);
        assert.strictEqual(e.status('new.js'), 'clean');
    });

    test('push - deletes local-only file removal', async () => {
        const events = new EventEmitter<EventMap>();
        const deleted: [string, 'file' | 'folder'][] = [];
        const files = new Map<string, unknown>([
            ['a.js', { type: 'file', uniqueId: 1, doc: { text: 'x\n' }, dirty: false }]
        ]);
        const pm = {
            files,
            delete: async (p: string, t: 'file' | 'folder') => {
                deleted.push([p, t]);
                files.delete(p);
            }
        } as unknown as ProjectManager;
        await writeFile('a.js', 'x\n');
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        events.emit('sync:file:delete', 'a.js', 'file');

        assert.strictEqual(e.status('a.js'), 'deleted');
        await e.push();
        assert.deepStrictEqual(deleted, [['a.js', 'file']]);
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('push - renames local-only path', async () => {
        const events = new EventEmitter<EventMap>();
        const renamed: [string, string][] = [];
        const files = new Map<string, unknown>([
            ['a.js', { type: 'file', uniqueId: 1, doc: { text: 'x\n' }, dirty: false }]
        ]);
        const pm = {
            files,
            rename: async (from: string, to: string) => {
                renamed.push([from, to]);
                files.set(to, files.get(from));
                files.delete(from);
            }
        } as unknown as ProjectManager;
        await writeFile('a.js', 'x\n');
        const e = new NativeSyncEngine({ events, storageUri: storage });
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });
        events.emit('sync:file:rename', 'a.js', 'b.js', 'file');

        assert.strictEqual(e.status('b.js'), 'renamed');
        await e.push();
        assert.deepStrictEqual(renamed, [['a.js', 'b.js']]);
        assert.strictEqual(e.status('b.js'), 'clean');
    });

    test('discard reverts the working file to base', async () => {
        await writeFile('a.js', 'x\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith({ text: 'x\n' }), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'x\nlocal\n');
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'modified');
        await e.discard(vscode.Uri.joinPath(work, 'a.js'));
        assert.strictEqual(await readFile('a.js'), 'x\n');
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('resolve after conflict makes the file pushable (not stuck)', async () => {
        const { pm, doc, applied } = pushPm();
        await writeFile('a.js', 'a\nb\nc\n');
        doc.text = 'a\nb\nc\n';
        const e = engine();
        await e.link({ folderUri: work, projectManager: pm, projectId: 1, branchId: 'main' });

        // local + remote change the same line -> conflict on pull
        await writeFile('a.js', 'a\nLOCAL\nc\n');
        doc.text = 'a\nREMOTE\nc\n';
        await e.pull();
        assert.strictEqual(e.status('a.js'), 'conflicted');

        // resolve: remove markers, keep a resolution
        await writeFile('a.js', 'a\nRESOLVED\nc\n');
        await e.refresh();
        assert.strictEqual(e.status('a.js'), 'modified', 'resolved file must be pushable, not stuck in both');

        await e.push();
        assert.ok(applied.length >= 1, 'resolution is pushed');
        assert.strictEqual(e.status('a.js'), 'clean');
    });

    test('mergeInputs exposes ancestor/local/remote during conflict, cleared on resolve', async () => {
        const doc = { text: 'a\nb\nc\n' };
        await writeFile('a.js', 'a\nb\nc\n');
        const e = engine();
        await e.link({ folderUri: work, projectManager: pmWith(doc), projectId: 1, branchId: 'main' });
        await writeFile('a.js', 'a\nLOCAL\nc\n');
        doc.text = 'a\nREMOTE\nc\n';
        await e.pull();

        const m = e.mergeInputs('a.js');
        assert.ok(m, 'merge inputs present during conflict');
        assert.strictEqual(m.base, 'a\nb\nc\n');
        assert.strictEqual(m.local, 'a\nLOCAL\nc\n');
        assert.strictEqual(m.remote, 'a\nREMOTE\nc\n');

        await writeFile('a.js', 'a\nRESOLVED\nc\n');
        await e.refresh();
        assert.strictEqual(e.mergeInputs('a.js'), undefined, 'cleared after resolve');
    });
});
