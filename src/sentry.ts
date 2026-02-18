import { BrowserClient, defaultStackParser, makeFetchTransport, Scope } from '@sentry/browser';

import packageJson from '../package.json';

import { DEBUG, ENV, SENTRY_DSN } from './config';

// note: sensitive keys to scrub from event data (matches monorepo sentry-utils.js)
const SANITIZE_KEYS = /password|token|secret|passwd|authorization|api_key|apikey|sentry_dsn|access_token|credentials/i;
const URI_TOKEN = /\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s'"`]+/gi;
const PATH_TOKEN = /(?:[A-Za-z]:\\[^\s'"`]+|\/[^\s'"`]+|(?:\.\.?\/)?[^\s'"`]*\/[^\s'"`]+)/g;
const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CONTEXT_ID_TOKEN = /\b(asset|document|project|branch|user|checkpoint)\s+\d+\b/gi;
const KEY_ID_TOKEN = /\b([a-z_]*id)(\s*[:=]\s*)\d+\b/gi;
const ASSET_ID_TOKEN = /\basset\s+(\d+)\b/gi;
const ASSET_ID_KEY_TOKEN = /\basset[_\s-]?id\s*[:=]\s*(\d+)\b/gi;
const ASSET_URI_ID_TOKEN = /\bassets\/(\d+)\b/gi;

type SentryEventShape = {
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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const trimToken = (value: string) => value.replace(/^[('"`]+/, '').replace(/[)"'`,.;!?]+$/, '');

const normalizePathValue = (value: string) => trimToken(value).split(/[?#]/, 1)[0];

const collectMatches = (input: string, pattern: RegExp, pick: (match: RegExpMatchArray) => string | undefined) => {
    const values = new Set<string>();
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of input.matchAll(regex)) {
        const value = pick(match);
        if (value) {
            values.add(value);
        }
    }
    return values;
};

const replaceTokens = (input: string, tokens: Set<string>, placeholder: string) => {
    let output = input;
    const sorted = Array.from(tokens).sort((a, b) => b.length - a.length);
    for (const token of sorted) {
        output = output.replace(new RegExp(escapeRegExp(token), 'g'), placeholder);
    }
    return output;
};

const normalizeMessage = (message: string) => {
    const uriTokens = collectMatches(message, URI_TOKEN, (match) => trimToken(match[0]));
    const pathTokens = collectMatches(message, PATH_TOKEN, (match) => trimToken(match[0]));
    const paths = new Set<string>();
    for (const token of [...uriTokens, ...pathTokens]) {
        const path = normalizePathValue(token);
        if (path) {
            paths.add(path);
        }
    }

    const assetIds = new Set<string>();
    for (const pattern of [ASSET_ID_TOKEN, ASSET_ID_KEY_TOKEN, ASSET_URI_ID_TOKEN]) {
        const ids = collectMatches(message, pattern, (match) => match[1]);
        for (const id of ids) {
            assetIds.add(id);
        }
    }

    let normalized = message;
    normalized = replaceTokens(normalized, uriTokens, '{path}');
    normalized = replaceTokens(normalized, pathTokens, '{path}');
    normalized = normalized.replace(UUID_TOKEN, '{uuid}');
    normalized = normalized.replace(CONTEXT_ID_TOKEN, '$1 {id}');
    normalized = normalized.replace(KEY_ID_TOKEN, '$1$2{id}');

    return {
        normalized,
        paths: Array.from(paths),
        assetIds: Array.from(assetIds)
    };
};

const withMessageGrouping = <T extends SentryEventShape>(event: T): T => {
    if (!event.message) {
        return event;
    }
    const { normalized, paths, assetIds } = normalizeMessage(event.message);
    const extra = { ...(event.extra || {}) };
    extra.original_message = event.message;
    if (paths.length === 1) {
        extra.path = paths[0];
    } else if (paths.length > 1) {
        extra.paths = paths;
    }
    if (assetIds.length === 1) {
        extra.asset_id = assetIds[0];
    } else if (assetIds.length > 1) {
        extra.asset_ids = assetIds;
    }
    event.extra = extra;
    event.message = normalized;
    event.fingerprint = [normalized];
    return event;
};

const client = new BrowserClient({
    dsn: DEBUG ? '' : SENTRY_DSN,
    transport: makeFetchTransport,
    stackParser: defaultStackParser,
    environment: `extension_${ENV === 'prod' ? 'live' : ENV}`,
    release: packageJson.version,
    integrations: [],
    beforeSend: (event) => sanitize(withMessageGrouping(event)) as typeof event
});

const scope = new Scope();
scope.setClient(client);
scope.setTag('page', 'vscode-extension');
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

export const closeSentry = async () => {
    await client.close(2000);
};
