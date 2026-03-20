import { type as ottext } from 'ot-text';
import type { Doc } from 'sharedb';

import { ShareDb } from '../connections/sharedb';
import type { ShareDbTextOp } from '../typings/sharedb';

const SOURCE = ShareDb.SOURCE;

type Listener = (...args: unknown[]) => void;

class OTDocument {
    private _text: string;

    private _doc: Doc;

    private _listeners = new Map<string, Set<Listener>>();

    constructor(doc: Doc) {
        this._text = doc.data as string;
        this._doc = doc;

        doc.on('op', (op: ShareDbTextOp, source: string) => {
            if (source === SOURCE) {
                return;
            }
            this._text = ottext.apply(this._text, op) as string;
            this._emit('op', op);
        });

        doc.on('nothing pending', () => this._emit('nothing pending'));
    }

    get text() {
        return this._text;
    }

    apply(op: ShareDbTextOp) {
        // ot-text checkOp rejects skip=0, so strip leading zero
        const clean = (typeof op[0] === 'number' && op[0] === 0 ? op.slice(1) : op) as ShareDbTextOp;
        this._text = ottext.apply(this._text, clean) as string;
        this._doc.submitOp(clean, { source: SOURCE });
    }

    get pending() {
        return this._doc.hasPending();
    }

    on(event: string, fn: Listener) {
        const set = this._listeners.get(event) ?? new Set();
        set.add(fn);
        this._listeners.set(event, set);
    }

    off(event: string, fn: Listener) {
        this._listeners.get(event)?.delete(fn);
    }

    once(event: string, fn: Listener) {
        const wrapper = (...args: unknown[]) => {
            this.off(event, wrapper);
            fn(...args);
        };
        this.on(event, wrapper);
    }

    get raw() {
        return this._doc;
    }

    private _emit(event: string, ...args: unknown[]) {
        const set = this._listeners.get(event);
        if (!set) {
            return;
        }
        for (const fn of set) {
            fn(...args);
        }
    }
}

export { OTDocument };
