import * as vscode from 'vscode';

import { captureException, captureMessage } from './sentry';

class Log {
    static channel = vscode.window.createOutputChannel('PlayCanvas', { log: true });

    private _source: string;

    constructor(source: string) {
        this._source = source;
    }

    debug(...args: unknown[]) {
        Log.channel.debug(`[${this._source}]`, ...args);
    }

    info(...args: unknown[]) {
        Log.channel.info(`[${this._source}]`, ...args);
    }

    warn(...args: unknown[]) {
        Log.channel.warn(`[${this._source}]`, ...args);
        captureMessage(args.map(String).join(' '), 'warning', this._source);
    }

    error(...args: unknown[]) {
        Log.channel.error(`[${this._source}]`, ...args);
        if (args[0] instanceof Error) {
            captureException(args[0], this._source);
        } else {
            captureMessage(args.map(String).join(' '), 'error', this._source);
        }
    }
}

export { Log };
