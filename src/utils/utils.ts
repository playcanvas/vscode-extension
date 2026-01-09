import crypto from 'crypto';

import * as vscode from 'vscode';

import { ShareDb } from '../connections/sharedb';
import type { Project } from '../typings/models';
import type { ShareDbTextOp } from '../typings/sharedb';

export const hash = (data: string | Uint8Array) => {
    return crypto.createHash('md5').update(data).digest('hex');
};

export const tryCatch = async <T>(promise: Promise<T>): Promise<[Error, null] | [null, T]> => {
    try {
        return [null, await promise];
    } catch (err: unknown) {
        return [err as Error, null];
    }
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
    const list: [ShareDbTextOp, { source: string }][] = [];
    for (const change of changes) {
        const offset = change.rangeOffset;
        const length = change.rangeLength;
        const text = change.text;

        // delete
        if (!change.range.isEmpty) {
            list.push([[offset, { d: length }], { source: ShareDb.SOURCE }]);
        }

        // insert
        if (text.length > 0) {
            list.push([[offset, text], { source: ShareDb.SOURCE }]);
        }
    }
    return list;
};

// derived from custom ot-text
export const sharedb2vscode = (doc: vscode.TextDocument, ops: ShareDbTextOp[], warn: (message: string) => void) => {
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
                const [data] = op;
                add([0, data]);
                break;
            }
            case 2: {
                const [index, data] = op;
                add([index, data]);
                break;
            }
            case 3: {
                const [index, ins, del] = op;
                add([index, del]);
                add([index, ins]);
                break;
            }
            default: {
                warn(`invalid ShareDB text op: ${JSON.stringify(op)}`);
                break;
            }
        }
    }

    return edits;
};

export const projectToName = (project: Project) => {
    return `${project.name} (${project.id})`;
};
