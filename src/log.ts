import * as vscode from 'vscode';

import { captureException } from './sentry';

class Log {
    static channel = vscode.window.createOutputChannel('PlayCanvas', { log: true });

    private _source: string;

    constructor(source: string) {
        this._source = source;
    }

    trace(...args: unknown[]) {
        Log.channel.trace(`[${this._source}]`, ...args);
    }

    debug(...args: unknown[]) {
        Log.channel.debug(`[${this._source}]`, ...args);
    }

    info(...args: unknown[]) {
        Log.channel.info(`[${this._source}]`, ...args);
    }

    warn(...args: unknown[]) {
        Log.channel.warn(`[${this._source}]`, ...args);
    }

    error(...args: unknown[]) {
        Log.channel.error(`[${this._source}]`, ...args);
        const err = args[0] instanceof Error ? args[0] : new Error(args.map(String).join(' '));
        captureException(err, this._source);
    }
}

export { Log };
