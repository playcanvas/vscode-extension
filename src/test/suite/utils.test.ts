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

    const readFile = async (name: string) =>
        buffer.toString(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(work, name)));

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
        assert.strictEqual(e.remoteText('a.js'), 'hello\nremote\n');
        assert.strictEqual(e.remoteText('missing.js'), undefined);
    });
});
