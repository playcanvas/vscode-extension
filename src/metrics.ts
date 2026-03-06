import * as vscode from 'vscode';

import { HOME_URL, NAME, PUBLISHER } from './config.js';
import { FETCH_TIMEOUT_MS } from './connections/constants';
import { Log } from './log';

const FLUSH_INTERVAL = 5000;
const MAX_BATCH_EVENTS = 50;
const MAX_BUFFER_EVENTS = 500;
const MAX_PAYLOAD_BYTES = 80 * 1024;
const MAX_DIMENSION_VALUE_LENGTH = 200;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const VALID_KINDS = new Set(['counter', 'timer', 'histogram']);

type MetricKind = 'counter' | 'timer' | 'histogram';

type MetricEvent = {
    type: string;
    kind: MetricKind;
    dimensions?: Record<string, string>;
    value?: number;
};

type PostBatchResult = 'ok' | 'retry' | 'too-large' | 'drop';

const isStringRecord = (v: unknown): v is Record<string, string> => {
    if (typeof v !== 'object' || v === null) {
        return false;
    }
    for (const value of Object.values(v)) {
        if (typeof value !== 'string') {
            return false;
        }
    }
    return true;
};

const trimAndTruncate = (value: string, maxLength: number) => {
    const trimmed = value.trim();
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

// sanitize dimensions to avoid invalid keys and oversized payload values.
const sanitizeDimensions = (dimensions?: Record<string, string>) => {
    if (!dimensions) {
        return undefined;
    }
    const sanitized: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(dimensions)) {
        const key = rawKey.trim();
        const value = trimAndTruncate(rawValue, MAX_DIMENSION_VALUE_LENGTH);
        if (!key || !value) {
            continue;
        }
        sanitized[key] = value;
    }
    return Object.keys(sanitized).length ? sanitized : undefined;
};

const payloadByteSize = (events: MetricEvent[]) => {
    return new TextEncoder().encode(JSON.stringify({ events })).length;
};

// implements vscode.TelemetrySender to relay events to editor-server -> graphene.
class GrapheneSender implements vscode.TelemetrySender {
    static readonly METRIC_PREFIX = 'vscode-extension';

    private _log = new Log('GrapheneSender');

    private _buffer: MetricEvent[] = [];

    private _timer: ReturnType<typeof setInterval> | undefined;

    private _flushPromise: Promise<void> | undefined;

    private _closing = false;

    private _url: string;

    private _accessToken: string;

    constructor(accessToken: string) {
        this._url = `${HOME_URL}/editor/metrics`;
        this._accessToken = accessToken;
        this._timer = setInterval(() => {
            void this._flush();
        }, FLUSH_INTERVAL);
    }

    sendEventData(eventName: string, data?: Record<string, unknown>): void {
        let kind: MetricKind = 'counter';
        const rawKind = data?.kind;
        if (typeof rawKind === 'string' && VALID_KINDS.has(rawKind)) {
            kind = rawKind as MetricKind;
        }
        const dimensions = sanitizeDimensions(isStringRecord(data?.dimensions) ? data.dimensions : undefined);
        const value = typeof data?.value === 'number' ? data.value : undefined;
        const type = eventName.toLowerCase().replace(`${PUBLISHER}.${NAME}/`, '');
        this._enqueue({
            type: `${GrapheneSender.METRIC_PREFIX}.${type}`,
            kind,
            dimensions,
            value
        });
    }

    sendErrorData(error: Error, data?: Record<string, unknown>): void {
        const dims = sanitizeDimensions(isStringRecord(data?.dimensions) ? data.dimensions : undefined);
        const message =
            trimAndTruncate(error.message || 'unknown error', MAX_DIMENSION_VALUE_LENGTH) || 'unknown error';
        this._enqueue({
            type: `${GrapheneSender.METRIC_PREFIX}.error`,
            kind: 'counter',
            dimensions: { ...(dims || {}), message }
        });
    }

    async flush(): Promise<void> {
        this._closing = true;
        if (this._timer) {
            clearInterval(this._timer);
        }
        this._timer = undefined;
        await this._flush();
    }

    private async _flush(): Promise<void> {
        if (this._flushPromise) {
            await this._flushPromise;
            return;
        }
        if (!this._buffer.length) {
            return;
        }

        this._flushPromise = new Promise<void>((resolve, reject) => {
            const run = async () => {
                // build bounded batches from the current buffer snapshot.
                const queue: MetricEvent[][] = [];
                let batch: MetricEvent[] = [];
                for (const event of this._buffer.splice(0)) {
                    if (payloadByteSize([event]) > MAX_PAYLOAD_BYTES) {
                        this._log.warn(`dropping oversized metric event: ${event.type}`);
                        continue;
                    }

                    const nextBatch = [...batch, event];
                    if (batch.length >= MAX_BATCH_EVENTS || payloadByteSize(nextBatch) > MAX_PAYLOAD_BYTES) {
                        if (batch.length) {
                            queue.push(batch);
                        }
                        batch = [event];
                        continue;
                    }
                    batch = nextBatch;
                }
                if (batch.length) {
                    queue.push(batch);
                }

                let flushedEvents = 0;
                for (let i = 0; i < queue.length; i++) {
                    const events = queue[i];
                    const result = await this._postBatch(events);

                    // handle successful batch flush.
                    if (result === 'ok') {
                        flushedEvents += events.length;
                        continue;
                    }

                    // handle oversized batch.
                    if (result === 'too-large') {
                        if (events.length === 1) {
                            this._log.warn(`dropping oversized metric event: ${events[0].type}`);
                            continue;
                        }
                        // split and retry progressively smaller chunks for 413 responses.
                        const splitAt = Math.ceil(events.length / 2);
                        queue.splice(i, 1, events.slice(0, splitAt), events.slice(splitAt));
                        i--;
                        continue;
                    }

                    // handle retryable error.
                    if (result === 'retry') {
                        const unsent = queue.slice(i).flat();
                        this._buffer = [...unsent, ...this._buffer];
                        if (this._buffer.length > MAX_BUFFER_EVENTS) {
                            const dropped = this._buffer.length - MAX_BUFFER_EVENTS;
                            this._buffer.splice(MAX_BUFFER_EVENTS);
                            this._log.warn(`metrics retry overflow, dropped ${dropped} events`);
                        }
                        return;
                    }
                }

                if (flushedEvents) {
                    this._log.debug(`flushed ${flushedEvents} events`);
                }
            };

            void run().then(resolve).catch(reject);
        });

        await this._flushPromise.finally(() => {
            this._flushPromise = undefined;
        });
    }

    private async _postBatch(events: MetricEvent[]): Promise<PostBatchResult> {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(this._url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this._accessToken}` },
            body: JSON.stringify({ events }),
            signal: ctrl.signal
        }).catch((err) => {
            this._log.debug(`flush failed: ${err.message}`);
            return null;
        });
        clearTimeout(timer);
        if (!res) {
            return 'retry';
        }
        if (!res.ok) {
            if (res.status === 413) {
                return 'too-large';
            }
            if (RETRYABLE_STATUS.has(res.status)) {
                this._log.debug(`flush failed: ${res.status} ${res.statusText}`);
                return 'retry';
            }
            if (!this._closing) {
                this._log.warn(`flush failed: ${res.status} ${res.statusText}`);
            }
            return 'drop';
        }
        return 'ok';
    }

    private _enqueue(event: MetricEvent) {
        this._buffer.push(event);
        if (this._buffer.length > MAX_BUFFER_EVENTS) {
            const dropped = this._buffer.length - MAX_BUFFER_EVENTS;
            this._buffer.splice(0, dropped);
            this._log.warn(`metrics buffer overflow, dropped ${dropped} oldest events`);
        }
        if (this._buffer.length >= MAX_BATCH_EVENTS) {
            void this._flush();
        }
    }
}

class Metrics {
    private _logger: vscode.TelemetryLogger;

    constructor(accessToken: string) {
        this._logger = vscode.env.createTelemetryLogger(new GrapheneSender(accessToken));
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

export { Metrics };
