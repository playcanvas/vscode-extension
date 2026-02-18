import * as vscode from 'vscode';

import { Log } from './log';

const FLUSH_INTERVAL = 5000;

const VALID_KINDS = new Set(['counter', 'timer', 'histogram']);

type MetricKind = 'counter' | 'timer' | 'histogram';

type MetricEvent = {
    type: string;
    kind: MetricKind;
    dimensions?: Record<string, string>;
    value?: number;
};

const isMetricKind = (v: unknown): v is MetricKind => typeof v === 'string' && VALID_KINDS.has(v);

const isStringRecord = (v: unknown): v is Record<string, string> =>
    typeof v === 'object' && v !== null && Object.values(v).every((val) => typeof val === 'string');

// note: implements vscode.TelemetrySender to relay events to editor-server -> graphene
class GrapheneSender implements vscode.TelemetrySender {
    private _log = new Log('GrapheneSender');

    private _buffer: MetricEvent[] = [];

    private _timer: ReturnType<typeof setInterval> | undefined;

    private _url: string;

    constructor(homeUrl: string, accessToken: string) {
        this._url = `${homeUrl}/editor/metrics?access_token=${accessToken}`;
        this._timer = setInterval(() => this._flush(), FLUSH_INTERVAL);
    }

    sendEventData(eventName: string, data?: Record<string, unknown>): void {
        const kind = isMetricKind(data?.kind) ? data.kind : 'counter';
        const dimensions = isStringRecord(data?.dimensions) ? data.dimensions : undefined;
        const value = typeof data?.value === 'number' ? data.value : undefined;
        this._buffer.push({ type: `vscode.${eventName}`, kind, dimensions, value });
    }

    sendErrorData(error: Error, data?: Record<string, unknown>): void {
        const dims = isStringRecord(data?.dimensions) ? data.dimensions : {};
        this._buffer.push({
            type: 'vscode.error',
            kind: 'counter',
            dimensions: { message: error.message, ...dims }
        });
    }

    async flush(): Promise<void> {
        clearInterval(this._timer);
        this._timer = undefined;
        await this._flush();
    }

    private async _flush(): Promise<void> {
        if (!this._buffer.length) {
            return;
        }

        const events = this._buffer.splice(0);
        await fetch(this._url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events })
        }).catch((err) => {
            this._log.debug(`flush failed: ${err.message}`);
        });
    }
}

class Metrics {
    private _logger: vscode.TelemetryLogger;

    constructor(sender: GrapheneSender) {
        this._logger = vscode.env.createTelemetryLogger(sender);
    }

    get disposable(): vscode.Disposable {
        return this._logger;
    }

    increment(type: string, dimensions?: Record<string, string>): void {
        this._logger.logUsage(type, { kind: 'counter', dimensions });
    }

    addTimer(type: string, ms: number, dimensions?: Record<string, string>): void {
        this._logger.logUsage(type, { kind: 'timer', value: ms, dimensions });
    }

    addHistogram(type: string, value: number, dimensions?: Record<string, string>): void {
        this._logger.logUsage(type, { kind: 'histogram', value, dimensions });
    }

    logError(error: Error, dimensions?: Record<string, string>): void {
        this._logger.logError(error, { dimensions });
    }
}

export { GrapheneSender, Metrics };
