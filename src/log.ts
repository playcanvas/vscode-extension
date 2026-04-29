import * as vscode from 'vscode';

import { addBreadcrumb, captureException } from './sentry';
import * as redact from './utils/redact';
import { tryCatchSync } from './utils/utils';

// keep enough history to cover a typical bug repro window. each entry caps at
// MAX_MSG_LEN so worst-case memory is ~5MB regardless of caller arg sizes.
const MAX_LOG_BUFFER = 5000;
const MAX_MSG_LEN = 1024;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
    ts: number;
    level: LogLevel;
    source: string;
    message: string;
};

const LEVEL_TO_BREADCRUMB: Record<LogLevel, 'debug' | 'info' | 'warning' | 'error'> = {
    trace: 'debug',
    debug: 'debug',
    info: 'info',
    warn: 'warning',
    error: 'error'
};

class Log {
    static channel = vscode.window.createOutputChannel('PlayCanvas', { log: true });

    // ring buffer — O(1) writes regardless of buffer size. _cursor points to
    // the next slot to write; _filled flips true after the first wrap-around.
    private static _buffer: (LogEntry | undefined)[] = new Array(MAX_LOG_BUFFER);

    private static _cursor = 0;

    private static _filled = false;

    private _source: string;

    constructor(source: string) {
        this._source = source;
    }

    private _record(level: LogLevel, args: unknown[]) {
        const s = args
            .map((a) => {
                if (a instanceof Error) {
                    return a.stack || `${a.name}: ${a.message}`;
                }
                if (typeof a === 'string') {
                    return a;
                }
                if (a === null || a === undefined || typeof a !== 'object') {
                    return String(a);
                }
                const [err, json] = tryCatchSync(() => JSON.stringify(a, redact.key));
                return err ? String(a) : json;
            })
            .join(' ');
        const message = s.length > MAX_MSG_LEN ? `${s.slice(0, MAX_MSG_LEN)}...` : s;

        Log._buffer[Log._cursor] = { ts: Date.now(), level, source: this._source, message };
        Log._cursor = (Log._cursor + 1) % MAX_LOG_BUFFER;
        if (Log._cursor === 0) {
            Log._filled = true;
        }
        addBreadcrumb({ level: LEVEL_TO_BREADCRUMB[level], category: this._source, message });
    }

    static dump(): LogEntry[] {
        if (!Log._filled) {
            return Log._buffer.slice(0, Log._cursor) as LogEntry[];
        }
        return [...Log._buffer.slice(Log._cursor), ...Log._buffer.slice(0, Log._cursor)] as LogEntry[];
    }

    // test-only — clear the ring buffer so tests have deterministic state
    static reset() {
        Log._buffer = new Array(MAX_LOG_BUFFER);
        Log._cursor = 0;
        Log._filled = false;
    }

    trace(...args: unknown[]) {
        Log.channel.trace(`[${this._source}]`, ...args);
        this._record('trace', args);
    }

    debug(...args: unknown[]) {
        Log.channel.debug(`[${this._source}]`, ...args);
        this._record('debug', args);
    }

    info(...args: unknown[]) {
        Log.channel.info(`[${this._source}]`, ...args);
        this._record('info', args);
    }

    warn(...args: unknown[]) {
        Log.channel.warn(`[${this._source}]`, ...args);
        this._record('warn', args);
    }

    error(...args: unknown[]) {
        Log.channel.error(`[${this._source}]`, ...args);
        this._record('error', args);
        const err = args[0] instanceof Error ? args[0] : new Error(args.map(String).join(' '));
        captureException(err, this._source);
    }
}

export { Log };
