import crypto from 'crypto';

import * as vscode from 'vscode';

import type { Project } from '../typings/models';
import type { ShareDbTextOp } from '../typings/sharedb';

import type { signal } from './signal';

// eslint-disable-next-line no-control-regex
const ILLEGAL_FS_CHARS = /[<>:"/\\|?*\x00-\x1F\x7F]/g;

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export const hash = (data: string | Uint8Array) => {
    return crypto.createHash('md5').update(data).digest('hex');
};

export const withTimeout = <T>(promise: Promise<T>, ms: number, msg: string) => {
    let id: ReturnType<typeof setTimeout>;
    const timer = new Promise<never>((_, reject) => {
        id = setTimeout(() => reject(new Error(msg)), ms);
    });
    return Promise.race([promise, timer]).finally(() => clearTimeout(id));
};

export const tryCatch = async <T>(promise: Promise<T>): Promise<[Error, null] | [null, T]> => {
    try {
        return [null, await promise];
    } catch (err: unknown) {
        return [err as Error, null];
    }
};

export const guard = <T>(promise: Promise<T>, error: ReturnType<typeof signal<Error | undefined>>) => {
    return promise.catch((err: Error) => {
        error.set(() => err);
        throw err;
    });
};

export const fileExists = async (uri: vscode.Uri) => {
    try {
        await vscode.workspace.fs.stat(uri);
    } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            return false;
        }
        throw err;
    }
    return true;
};

export const relativePath = (uri: vscode.Uri, folder: vscode.Uri) => {
    return uri.path.substring(folder.path.length + 1);
};

export const uriStartsWith = (uri: vscode.Uri, folder: vscode.Uri) => {
    return uri.scheme === folder.scheme && uri.path.toLowerCase().startsWith(folder.path.toLowerCase());
};

export const parsePath = (path: string) => {
    const i = path.lastIndexOf('/');
    const name = path.substring(i + 1);
    const folder = path.substring(0, i) || '';
    return [folder, name];
};

export const vscode2sharedb = (changes: readonly vscode.TextDocumentContentChangeEvent[]) => {
    const list: ShareDbTextOp[] = [];

    // note: all contentChanges reference the original doc state, but apply
    // updates canonical state after each call, so we adjust subsequent offsets
    // based on the net effect of previously processed changes.
    const effects: { origOffset: number; deleteLen: number; delta: number }[] = [];

    for (const change of changes) {
        const origOffset = change.rangeOffset;
        const deleteLen = change.rangeLength;
        const text = change.text;

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

// derived from custom ot-text
export const sharedb2vscode = (doc: vscode.TextDocument, ops: ShareDbTextOp[]) => {
    const edits: vscode.TextEdit[] = [];

    const add = (cleanOp: [number, string | { d: number }]) => {
        const [index, data] = cleanOp;
        switch (typeof data) {
            case 'string': {
                // insert
                edits.push(vscode.TextEdit.insert(doc.positionAt(index), data));
                break;
            }
            case 'object': {
                // delete
                edits.push(
                    vscode.TextEdit.delete(new vscode.Range(doc.positionAt(index), doc.positionAt(index + data.d)))
                );
                break;
            }
        }
    };
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
                // note: walk components with a cursor tracking position in the
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

    return edits;
};

export const opdiff = (op: ShareDbTextOp) => {
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

export const minimalDiff = (a: string, b: string) => {
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
export const diffOp = (from: string, to: string): ShareDbTextOp | null => {
    if (from === to) {
        return null;
    }
    const { prefix, suffix } = minimalDiff(from, to);
    const del = from.length - prefix - suffix;
    const ins = to.substring(prefix, to.length - suffix);
    return del > 0 && ins.length > 0 ? [prefix, ins, { d: del }] : del > 0 ? [prefix, { d: del }] : [prefix, ins];
};

export const sanitizeName = (name: string) => {
    let result = name.replace(ILLEGAL_FS_CHARS, '_').replace(/^ +|[. ]+$/g, '');
    if (WINDOWS_RESERVED.test(result)) {
        result = `_${result}`;
    }
    return result || '_';
};

export const projectToName = (project: Project, encode = true) => {
    const name = encode ? sanitizeName(project.name) : project.name;
    return `${name} (${project.id})`;
};

export const summarize = (data: unknown): string => {
    if (data instanceof ArrayBuffer) {
        return `[Buffer(${data.byteLength})]`;
    }
    if (Array.isArray(data)) {
        return `[Array(${data.length})]`;
    }
    if (data && typeof data === 'object') {
        const keys = Object.keys(data);
        if (keys.length > 5) {
            return `{${keys.slice(0, 5).join(', ')}, ... +${keys.length - 5} more}`;
        }
        return `{${keys.join(', ')}}`;
    }
    return String(data);
};

export const retry = async <T>(
    fn: () => Promise<T>,
    opts: {
        retries: number;
        delay: (attempt: number) => number;
        warn?: (err: Error, attempt: number) => void;
    }
) => {
    for (let i = 0; i <= opts.retries; i++) {
        const [err, result] = await tryCatch(fn());
        if (!err) {
            return result!;
        }
        opts.warn?.(err, i + 1);
        if (i < opts.retries) {
            const d = opts.delay(i);
            await new Promise((resolve) => setTimeout(resolve, d));
        } else {
            throw err;
        }
    }
    throw new Error('unreachable');
};
