import crypto from 'crypto';

import * as vscode from 'vscode';

import type { Project } from '../typings/models';

import type { signal } from './signal';

// eslint-disable-next-line no-control-regex
const ILLEGAL_FS_CHARS = /[<>:"/\\|?*\x00-\x1F\x7F]/g;

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export const wait = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

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

export const tryCatch = async <T>(task: Promise<T> | (() => Promise<T>)): Promise<[Error, null] | [null, T]> => {
    try {
        return [null, await (typeof task === 'function' ? task() : task)];
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
