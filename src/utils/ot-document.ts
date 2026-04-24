import { type as ottext } from 'ot-text';
import type { Doc } from 'sharedb';

import { ShareDb } from '../connections/sharedb';
import type { ShareDbTextOp } from '../typings/sharedb';

import { EventEmitter } from './event-emitter';

const SOURCE = ShareDb.SOURCE;
const STALL_MS = 30 * 1000;
const TICK_MS = 2 * 1000;

type OTDocumentEvents = {
    op: [ShareDbTextOp, string];
    reload: [];
    stuck: [];
    drained: [];
};

class OTDocument extends EventEmitter<OTDocumentEvents> {
    private _text: string;

    private _doc: Doc;

    private _stuck = false;

    private _queued?: number;

    private _timer?: ReturnType<typeof setInterval>;

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
            // server resync replaced local state — unacked ops from before the swap
            // are lost. surface desync via stuck; otherwise dirty-tracking based on
            // hash(_text) would falsely flip clean once the server snapshot matches S3.
            const pending = this._doc.hasPending();
            this._text = next;
            this.emit('reload');
            if (pending) {
                this._stick();
            }
        });

        // queue drained — reset stuck guard and emit 'drained' so listeners can
        // clear any desync state they surfaced earlier.
        doc.on('no write pending', () => {
            this._stuck = false;
            this._queued = undefined;
            this._disarm();
            this.emit('drained');
        });

        doc.on('destroy', () => {
            this._disarm();
        });
    }

    get text() {
        return this._text;
    }

    apply(op: ShareDbTextOp) {
        // ot-text checkOp rejects skip=0, so strip leading zero
        const clean = (typeof op[0] === 'number' && op[0] === 0 ? op.slice(1) : op) as ShareDbTextOp;
        this._text = ottext.apply(this._text, clean) as string;

        if (this._queued === undefined) {
            this._queued = Date.now();
            this._arm();
        }

        this._doc.submitOp(clean, { source: SOURCE }, (err) => {
            // explicit server rejection is a strictly stronger signal than timeout
            if (err) {
                this._stick();
            }
        });
    }

    get pending() {
        return this._doc.hasPending();
    }

    whenNothingPending(fn: () => void) {
        this._doc.whenNothingPending(fn);
    }

    // single interval per doc — checks queue-age while pending. subsumes the old
    // per-op setTimeout approach, which missed stalls when callbacks fired piecemeal.
    private _arm() {
        if (this._timer) {
            return;
        }
        this._timer = setInterval(() => {
            if (this._queued === undefined) {
                this._disarm();
                return;
            }
            if (!this._stuck && Date.now() - this._queued >= STALL_MS) {
                this._stick();
            }
        }, TICK_MS);
    }

    private _disarm() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }

    private _stick() {
        if (this._stuck) {
            return;
        }
        this._stuck = true;
        this.emit('stuck');
    }
}

export { OTDocument };
