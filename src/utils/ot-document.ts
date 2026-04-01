import { type as ottext } from 'ot-text';
import type { Doc } from 'sharedb';

import { ShareDb } from '../connections/sharedb';
import type { ShareDbTextOp } from '../typings/sharedb';

import { EventEmitter } from './event-emitter';

const SOURCE = ShareDb.SOURCE;

type OTDocumentEvents = {
    op: [ShareDbTextOp];
    'nothing pending': [];
};

class OTDocument extends EventEmitter<OTDocumentEvents> {
    private _text: string;

    private _doc: Doc;

    constructor(doc: Doc) {
        super();
        this._text = doc.data as string;
        this._doc = doc;

        doc.on('op', (op: ShareDbTextOp, source: string) => {
            if (source === SOURCE) {
                return;
            }
            this._text = ottext.apply(this._text, op) as string;
            this.emit('op', op);
        });

        doc.on('nothing pending', () => this.emit('nothing pending'));
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

    get raw() {
        return this._doc;
    }
}

export { OTDocument };
