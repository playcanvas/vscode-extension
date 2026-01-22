import * as vscode from 'vscode';

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
    }

    error(...args: unknown[]) {
        Log.channel.error(`[${this._source}]`, ...args);
    }
}

export { Log };
