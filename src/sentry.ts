import { BrowserClient, defaultStackParser, makeFetchTransport, Scope } from '@sentry/browser';

import packageJson from '../package.json';

import { DEBUG, ENV, SENTRY_DSN } from './config';
import type { FingerprintedError } from './utils/error';

const isFingerprintedError = (e: unknown): e is FingerprintedError =>
    e instanceof Error && 'fingerprint' in e && typeof (e as FingerprintedError).fingerprint === 'string';

// NOTE: sensitive keys to scrub from event data (matches monorepo sentry-utils.js)
const SANITIZE_KEYS = /password|token|secret|passwd|authorization|api_key|apikey|sentry_dsn|access_token|credentials/i;

type GroupingEvent = {
    message?: string;
    extra?: Record<string, unknown>;
    fingerprint?: string[];
};

const sanitize = (obj: unknown, memo = new WeakSet()): unknown => {
    if (Array.isArray(obj)) {
        if (memo.has(obj)) {
            return obj;
        }
        memo.add(obj);
        const result = obj.map((v) => sanitize(v, memo));
        memo.delete(obj);
        return result;
    }
    if (obj && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype) {
        if (memo.has(obj)) {
            return obj;
        }
        memo.add(obj);
        const record = obj as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record)) {
            result[key] = SANITIZE_KEYS.test(key) ? '********' : sanitize(record[key], memo);
        }
        memo.delete(obj);
        return result;
    }
    return obj;
};

const client = new BrowserClient({
    dsn: DEBUG ? '' : SENTRY_DSN,
    transport: makeFetchTransport,
    stackParser: defaultStackParser,
    environment: `extension_${ENV === 'prod' ? 'live' : ENV}`,
    release: packageJson.version,
    integrations: [],
    beforeSend: (event, hint) => {
        const typedEvent = event as typeof event & GroupingEvent;
        const original = hint?.originalException;

        // first-party errors carry their own grouping key via fail tagged template
        if (isFingerprintedError(original)) {
            typedEvent.fingerprint = [original.fingerprint];
            typedEvent.extra = {
                ...(typedEvent.extra || {}),
                metadata: { message: original.message, context: original.context }
            };
        }

        return sanitize(typedEvent) as typeof event;
    }
});

const scope = new Scope();
scope.setClient(client);
scope.setTag('page', 'vscode-extension');
scope.setTag('os', process.platform);
client.init();

export const captureException = (error: Error, source?: string) => {
    const s = source ? scope.clone() : scope;
    if (source) {
        s.setTag('source', source);
    }
    s.captureException(error);
};

export const captureMessage = (message: string, level: 'warning' | 'error' = 'error', source?: string) => {
    const s = source ? scope.clone() : scope;
    if (source) {
        s.setTag('source', source);
    }
    s.captureMessage(message, level);
};

export const setSentryUser = (id: number) => {
    scope.setUser({ id: String(id) });
};

export const setSentryProject = (projectId: number, branchId: string) => {
    scope.setTag('project_id', String(projectId));
    scope.setTag('branch_id', branchId);
};

export const setSentryCollaborators = (same: number, other: number) => {
    scope.setTag('collab_same', String(same));
    scope.setTag('collab_other', String(other));
};

export const closeSentry = async () => {
    await client.close(2000);
};
