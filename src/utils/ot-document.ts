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
    private _doc: Doc;

    private _stuck = false;

    private _queued?: number;

    private _timer?: ReturnType<typeof setInterval>;

    private _prev?: string;

    constructor(doc: Doc) {
        super();
        this._doc = doc;

        doc.on('before op', (_op: ShareDbTextOp, source: string) => {
            if (source === SOURCE) {
                return;
            }
            this._prev = this.text;
        });

        doc.on('op', (op: ShareDbTextOp, source: string) => {
            if (source === SOURCE) {
                return;
            }
            const prev = this._prev ?? this.text;
            this._prev = undefined;
            this.emit('op', op, prev);
        });

        // silent recovery on ingestSnapshot — matches online IDE. snapshot resyncs are
        // a normal sharedb recovery path (reconnect, version mismatch); not desync.
        doc.on('load', () => {
            if ((this._doc.data as string | null) == null) {
                return;
            }
            this.emit('reload');
        });

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
        return (this._doc.data as string | null) ?? '';
    }

    apply(op: ShareDbTextOp) {
        // ot-text checkOp rejects skip=0, so strip leading zero
        const clean = (typeof op[0] === 'number' && op[0] === 0 ? op.slice(1) : op) as ShareDbTextOp;

        if (this._queued === undefined) {
            this._queued = Date.now();
            this._arm();
        }

        // sharedb handles optimistic apply + rollback on doc.data; text tracks it.
        this._doc.submitOp(clean, { source: SOURCE }, (err) => {
            if (err) {
                // doc.data is rolled back; emit reload so disk._subscribed reverts the buffer.
                this.emit('reload');
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
