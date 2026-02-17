import { BrowserClient, defaultStackParser, makeFetchTransport, Scope } from '@sentry/browser';

import packageJson from '../package.json';

import { DEBUG } from './config';

const SENTRY_DSN = 'https://0defef72baf64d99bf53b92a23d5bd14@sentry.sc-prod.net/87';

// note: sensitive keys to scrub from event data (matches monorepo sentry-utils.js)
const SANITIZE_KEYS = /password|token|secret|passwd|authorization|api_key|apikey|sentry_dsn|access_token|credentials/i;

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
    environment: 'extension_live',
    release: packageJson.version,
    integrations: [],
    beforeSend: (event) => sanitize(event) as typeof event
});

const scope = new Scope();
scope.setClient(client);
scope.setTag('page', 'vscode-extension');
client.init();

export const captureException = (error: Error) => {
    scope.captureException(error);
};

export const setSentryUser = (id: number) => {
    scope.setUser({ id: String(id) });
};

export const setSentryProject = (projectId: number, branchId: string) => {
    scope.setTag('project_id', String(projectId));
    scope.setTag('branch_id', branchId);
};

export const closeSentry = async () => {
    await client.close(2000);
};
