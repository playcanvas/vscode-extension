import { type as ottext } from 'ot-text';

import type { ShareDbTextOp } from './typings/sharedb';

const MAX_SIZE = 200;
const MERGE_DELAY = 2000;

type Entry = { op: ShareDbTextOp; time: number; ws: boolean; nl: boolean };

// check if op is a no-op (empty or zero-delete)
const noop = (op: ShareDbTextOp) =>
    op.length === 0 || (op.length === 1 && typeof op[0] === 'object' && (op[0] as { d: number }).d === 0);

class UndoManager {
    private _undo: Entry[] = [];

    private _redo: Entry[] = [];

    private _prevLine: number | null = null;

    private _line: number | null = null;

    private _force = false;

    private _timer: ReturnType<typeof setTimeout> | null = null;

    get canUndo() {
        return this._undo.length > 0;
    }

    get canRedo() {
        return this._redo.length > 0;
    }

    private _canConcat(prev: Entry, next: Entry) {
        if (this._force) {
            return true;
        }
        if (prev.op.length === 0 || next.op.length === 0) {
            return true;
        }

        const pd = prev.op.some((c) => typeof c === 'object');
        const nd = next.op.some((c) => typeof c === 'object');
        if (pd !== nd) {
            return false;
        }
        if (next.ws && !prev.ws) {
            return false;
        }

        if (this._line !== this._prevLine) {
            if (prev.ws && !prev.nl) {
                return false;
            }
            if (!next.ws && !prev.ws) {
                return false;
            }
        }

        return true;
    }

    private _setForce() {
        this._force = true;
        if (this._timer !== null) {
            clearTimeout(this._timer);
        }
        this._timer = setTimeout(() => {
            this._force = false;
            this._timer = null;
        });
    }

    // push inverse op to undo stack (mirrors editor addToHistory)
    push(inv: ShareDbTextOp, ws: boolean, nl: boolean, line: number) {
        this._prevLine = this._line;
        this._line = line;

        const entry: Entry = { op: inv, time: Date.now(), ws, nl };
        const prev = this._undo[this._undo.length - 1];
        const elapsed = prev ? entry.time - prev.time : Infinity;

        if ((elapsed <= MERGE_DELAY || this._force) && prev && this._canConcat(prev, entry)) {
            // compose(newer, older): apply newer inverse first, then older
            prev.op = ottext.compose(entry.op, prev.op) as ShareDbTextOp;
            if (!ws) {
                prev.ws = false;
                prev.nl = false;
            } else if (nl) {
                prev.nl = true;
            }
        } else {
            this._undo.push(entry);
            if (this._undo.length > MAX_SIZE) {
                this._undo.shift();
            }
        }

        this._redo.length = 0;
        this._setForce();
    }

    // transform all stack entries against remote op (mirrors editor transformStacks)
    transform(remote: ShareDbTextOp) {
        const initial = remote;
        let r = remote;

        let i = this._undo.length;
        while (i--) {
            const e = this._undo[i];
            const old = e.op;
            e.op = ottext.transform(e.op, r, 'left') as ShareDbTextOp;
            if (noop(e.op)) {
                this._undo.splice(i, 1);
            } else {
                r = ottext.transform(r, old, 'right') as ShareDbTextOp;
            }
        }

        r = initial;
        i = this._redo.length;
        while (i--) {
            const e = this._redo[i];
            const old = e.op;
            e.op = ottext.transform(e.op, r, 'left') as ShareDbTextOp;
            if (noop(e.op)) {
                this._redo.splice(i, 1);
            } else {
                r = ottext.transform(r, old, 'right') as ShareDbTextOp;
            }
        }
    }

    // pop undo, compute redo counterpart, return op to apply
    undo(snapshot: string) {
        const e = this._undo.pop();
        if (!e) {
            return null;
        }
        const inv = ottext.semanticInvert(snapshot, e.op) as ShareDbTextOp;
        this._redo.push({ op: inv, time: e.time, ws: e.ws, nl: e.nl });
        return e.op;
    }

    // pop redo, compute undo counterpart, return op to apply
    redo(snapshot: string) {
        const e = this._redo.pop();
        if (!e) {
            return null;
        }
        const inv = ottext.semanticInvert(snapshot, e.op) as ShareDbTextOp;
        this._undo.push({ op: inv, time: e.time, ws: e.ws, nl: e.nl });
        return e.op;
    }

    clear() {
        this._undo.length = 0;
        this._redo.length = 0;
        this._prevLine = null;
        this._line = null;
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._force = false;
    }
}

export { UndoManager };
