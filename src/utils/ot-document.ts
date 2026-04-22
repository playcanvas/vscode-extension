import { type as ottext } from 'ot-text';
import type { Doc } from 'sharedb';

import { ShareDb } from '../connections/sharedb';
import type { ShareDbTextOp } from '../typings/sharedb';

import { EventEmitter } from './event-emitter';

const SOURCE = ShareDb.SOURCE;
const PENDING_TIMEOUT_MS = 30 * 1000; // max potential timeout

type OTDocumentEvents = {
    op: [ShareDbTextOp, string];
    reload: [];
    stuck: [];
};

class OTDocument extends EventEmitter<OTDocumentEvents> {
    private _text: string;

    private _doc: Doc;

    private _timers = new Set<NodeJS.Timeout>();

    private _stuck = false;

    constructor(doc: Doc) {
        super();
        this._text = doc.data as string;
        this._doc = doc;

        doc.on('op', (op: ShareDbTextOp, source: string) => {
            if (source === SOURCE) {
                return;
            }
            const prev = this._text;
            this._text = ottext.apply(this._text, op) as string;
            this.emit('op', op, prev);
        });

        // sharedb emits 'load' on ingestSnapshot (hard rollback, version mismatch,
        // or stale reconnect). doc.data is replaced without any 'op' events, so
        // resync _text here or downstream reconcilers will drift.
        doc.on('load', () => {
            // server nullifies inactive doc data — skip; re-subscribe will repopulate
            const next = doc.data as string | null;
            if (next == null || next === this._text) {
                return;
            }
            this._text = next;
            this.emit('reload');
        });

        // ops drained — allow future stalls to be re-detected. project-level
        // desync stays sticky until unlink, so this only re-arms the doc-local
        // one-shot guard.
        doc.on('no write pending', () => {
            this._stuck = false;
        });

        doc.on('destroy', () => {
            for (const t of this._timers) {
                clearTimeout(t);
            }
            this._timers.clear();
        });
    }

    get text() {
        return this._text;
    }

    apply(op: ShareDbTextOp) {
        // ot-text checkOp rejects skip=0, so strip leading zero
        const clean = (typeof op[0] === 'number' && op[0] === 0 ? op.slice(1) : op) as ShareDbTextOp;
        this._text = ottext.apply(this._text, clean) as string;

        // already stuck — submit without arming a redundant timer
        if (this._stuck) {
            this._doc.submitOp(clean, { source: SOURCE });
            return;
        }

        const timer = setTimeout(() => {
            this._timers.delete(timer);
            if (!this._stuck) {
                this._stuck = true;
                this.emit('stuck');
            }
        }, PENDING_TIMEOUT_MS);
        this._timers.add(timer);

        this._doc.submitOp(clean, { source: SOURCE }, (err) => {
            clearTimeout(timer);
            this._timers.delete(timer);

            // explicit server rejection is a strictly stronger signal timeout
            if (err && !this._stuck) {
                this._stuck = true;
                this.emit('stuck');
            }
        });
    }

    get pending() {
        return this._doc.hasPending();
    }

    whenNothingPending(fn: () => void) {
        this._doc.whenNothingPending(fn);
    }
}

export { OTDocument };
