import { type as ottext } from 'ot-text';
import * as vscode from 'vscode';

import type { ShareDbTextOp } from '../typings/sharedb';

export const norm = (s: string) => s.replace(/\r\n?/g, '\n');

export const diff = (a: string, b: string) => {
    const minLen = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < minLen && a[prefix] === b[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
        suffix++;
    }
    return { prefix, suffix };
};

// build a ShareDbTextOp from the minimal diff between two strings
export const delta = (from: string, to: string): ShareDbTextOp | null => {
    if (from === to) {
        return null;
    }
    const { prefix, suffix } = diff(from, to);
    const del = from.length - prefix - suffix;
    const ins = to.substring(prefix, to.length - suffix);
    return del > 0 && ins.length > 0 ? [prefix, ins, { d: del }] : del > 0 ? [prefix, { d: del }] : [prefix, ins];
};

export const stat = (op: ShareDbTextOp) => {
    let ins = 0;
    let del = 0;
    for (const c of op) {
        if (typeof c === 'string') {
            ins += c.length;
        } else if (typeof c === 'object') {
            del += c.d;
        }
    }
    return `+${ins} -${del}`;
};

// when CRLF, contentChanges offsets are CRLF-based and misalign with
// LF canonical state — fall back to delta for correct offsets
export const vscode2sharedb = (
    document: vscode.TextDocument,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    prev: string
) => {
    if (document.eol === vscode.EndOfLine.CRLF) {
        const op = delta(prev, norm(document.getText()));
        return op ? [op] : [];
    }

    const list: ShareDbTextOp[] = [];

    // contentChanges reference the original doc state, but sharedb applies
    // each op sequentially — adjust offsets by the net effect of prior changes
    const effects: { origOffset: number; deleteLen: number; delta: number }[] = [];

    for (const change of changes) {
        const origOffset = change.rangeOffset;
        const deleteLen = change.rangeLength;
        const text = norm(change.text);

        // adjust offset based on previously processed changes
        let adjusted = origOffset;
        for (const e of effects) {
            if (origOffset >= e.origOffset + e.deleteLen) {
                adjusted += e.delta;
            }
        }

        // atomic replace, delete, or insert
        // note: ot-text checkOp rejects skip=0, so omit leading offset when 0
        if (deleteLen > 0 && text.length > 0) {
            list.push(adjusted ? [adjusted, text, { d: deleteLen }] : [text, { d: deleteLen }]);
        } else if (deleteLen > 0) {
            list.push(adjusted ? [adjusted, { d: deleteLen }] : [{ d: deleteLen }]);
        } else if (text.length > 0) {
            list.push(adjusted ? [adjusted, text] : [text]);
        }

        effects.push({ origOffset, deleteLen, delta: text.length - deleteLen });
    }
    return list;
};

// apply remote op to buffer — derived from custom ot-text
export const sharedb2vscode = (document: vscode.TextDocument, uri: vscode.Uri, ops: ShareDbTextOp[], text: string) => {
    const edit = new vscode.WorkspaceEdit();

    if (document.eol !== vscode.EndOfLine.CRLF) {
        const edits: vscode.TextEdit[] = [];

        const add = (cleanOp: [number, string | { d: number }]) => {
            const [index, data] = cleanOp;
            switch (typeof data) {
                case 'string': {
                    // insert
                    edits.push(vscode.TextEdit.insert(document.positionAt(index), data));
                    break;
                }
                case 'object': {
                    // delete
                    edits.push(
                        vscode.TextEdit.delete(
                            new vscode.Range(document.positionAt(index), document.positionAt(index + data.d))
                        )
                    );
                    break;
                }
            }
        };

        // normalize sharedb ops: [data], [index, data], or [skip, data, ...]
        for (const op of ops) {
            switch (op.length) {
                case 1: {
                    const [data] = op as [string | { d: number }];
                    add([0, data]);
                    break;
                }
                case 2: {
                    const [index, data] = op as [number, string | { d: number }];
                    add([index, data]);
                    break;
                }
                default: {
                    // walk components with a cursor tracking position in the
                    // original doc. handles atomic replaces, line moves, and any
                    // multi-component ot-text op regardless of element ordering.
                    let cursor = 0;
                    for (const component of op) {
                        if (typeof component === 'number') {
                            cursor += component;
                        } else if (typeof component === 'string') {
                            add([cursor, component]);
                        } else {
                            add([cursor, component]);
                            cursor += component.d;
                        }
                    }
                    break;
                }
            }
        }

        edit.set(uri, edits);
        return edit;
    }

    // crlf: apply ops in lf space, convert to crlf, then diff against raw buffer
    const raw = document.getText();
    const target = ops.reduce((value, op) => ottext.apply(value, op) as string, text);
    const next = document.eol === vscode.EndOfLine.CRLF ? target.replace(/\n/g, '\r\n') : target;
    const { prefix, suffix } = diff(raw, next);
    const del = raw.length - prefix - suffix;
    const ins = next.substring(prefix, next.length - suffix);
    edit.replace(uri, new vscode.Range(document.positionAt(prefix), document.positionAt(prefix + del)), ins);
    return edit;
};
