import * as assert from 'assert';
import * as os from 'os';

import { type as ottext } from 'ot-text';
import * as vscode from 'vscode';

import type { ProjectManager } from '../../project-manager';
import { BaseStore } from '../../sync/base-store';
import { hasConflictMarkers } from '../../sync/markers';
import { merge } from '../../sync/merge';
import { classify } from '../../sync/status';
import { NativeSyncEngine } from '../../sync/sync-engine';
import type { EventMap } from '../../typings/event-map';
import type { Project } from '../../typings/models';
import * as buffer from '../../utils/buffer';
import { EventEmitter } from '../../utils/event-emitter';
import { delta } from '../../utils/text';
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

    test('delete removes entry', () => {
        const store = new BaseStore({ storageUri: dir });
        store.set(1, 'x');
        store.delete(1);
        assert.strictEqual(store.get(1), undefined);
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

    const engine = () => new NativeSyncEngine({ events: new EventEmitter<EventMap>(), storageUri: storage });

    const pmWith = (doc: { text: string }) => {
        const files = new Map([['a.js', { type: 'file', uniqueId: 1, doc, dirty: false }]]);
        return { files } as unknown as ProjectManager;
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
});
