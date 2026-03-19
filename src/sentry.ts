import { BrowserClient, defaultStackParser, makeFetchTransport, Scope } from '@sentry/browser';

import packageJson from '../package.json';

import { DEBUG, ENV, SENTRY_DSN } from './config';

// note: sensitive keys to scrub from event data (matches monorepo sentry-utils.js)
const SANITIZE_KEYS = /password|token|secret|passwd|authorization|api_key|apikey|sentry_dsn|access_token|credentials/i;

const URI_TOKEN = /\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s'"`]+/gi;
const PATH_TOKEN =
    /(?:[A-Za-z]:\\[^\s'"`]+|\/(?=[^\s'"`]*[A-Za-z])[^\s'"`]+|(?:\.\.?\/)?(?=[^\s'"`]*[A-Za-z])[^\s'"`]*\/[^\s'"`]+|\b(?=[^\s'"`]*[A-Za-z])[A-Za-z0-9.-]*_[A-Za-z0-9._-]*\b)/g;
const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CONTEXT_ID_TOKEN = /\b(asset|document|project|branch|user|checkpoint)\s+\d+\b/gi;
const DOCUMENT_ROOM_ID_TOKEN = /\bdocument-(\d+)\b/gi;
const ASSET_ID_TOKEN = /\basset\s+(\d+)\b/gi;
const ASSET_URI_ID_TOKEN = /\bassets\/(\d+)\b/gi;
const TIMESTAMP_TOKEN = /\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/gi;

type SentryMetadata = {
    message: string;
    paths: string[];
    assetIds: string[];
    documentIds: string[];
    timestamps: string[];
};

type GroupingExtra = Record<string, unknown> & {
    metadata?: SentryMetadata;
};

type GroupingEvent = {
    message?: string;
    extra?: GroupingExtra;
    fingerprint?: string[];
};

const sanitize = (obj: unknown, memo = new WeakSet()): unknown => {
    if (Array.isArray(obj)) {
        if (memo.has(obj)) {
            return obj;
        }
        memo.add(obj);
        const result = obj.map((v) => {
            return sanitize(v, memo);
        });
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

const normalizeMessage = (message: string) => {
    const trimToken = (value: string) => {
        return value.replace(/^[('"`]+/, '').replace(/[)"'`,.;!?]+$/, '');
    };
    const collectMatches = (pattern: RegExp, pick: (match: RegExpMatchArray) => string | undefined) => {
        const values = new Set<string>();
        const regex = new RegExp(pattern.source, pattern.flags);
        for (const match of message.matchAll(regex)) {
            const value = pick(match);
            if (value) {
                values.add(value);
            }
        }
        return values;
    };

    // collect path-like values before normalizing so we can keep raw context in event.extra.metadata
    const uriTokens = collectMatches(URI_TOKEN, (match) => {
        return trimToken(match[0]);
    });
    const pathTokens = collectMatches(PATH_TOKEN, (match) => {
        return trimToken(match[0]);
    });
    const paths = new Set<string>();
    for (const token of [...uriTokens, ...pathTokens]) {
        const path = trimToken(token).split(/[?#]/, 1)[0];
        if (path) {
            paths.add(path);
        }
    }

    // only parse asset id formats that our current logs actually emit
    const assetIds = new Set<string>();
    for (const pattern of [ASSET_ID_TOKEN, ASSET_URI_ID_TOKEN]) {
        const ids = collectMatches(pattern, (match) => {
            return match[1];
        });
        for (const id of ids) {
            assetIds.add(id);
        }
    }

    const documentRoomTokens = collectMatches(DOCUMENT_ROOM_ID_TOKEN, (match) => {
        return trimToken(match[0]);
    });
    const documentIds = collectMatches(DOCUMENT_ROOM_ID_TOKEN, (match) => {
        return match[1];
    });

    // collect timing values to reduce retry/backoff cardinality while preserving raw values in metadata
    const timestamps = collectMatches(TIMESTAMP_TOKEN, (match) => {
        return trimToken(match[0]);
    });

    // replace longest tokens first so nested segments don't partially replace
    const replaceTokens = (input: string, tokens: Set<string>, placeholder: string) => {
        let output = input;
        const sorted = Array.from(tokens).sort((a, b) => {
            return b.length - a.length;
        });
        for (const token of sorted) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            output = output.replace(new RegExp(escaped, 'g'), placeholder);
        }
        return output;
    };

    // replace tokens in message
    let normalized = message;
    normalized = replaceTokens(normalized, uriTokens, '{path}');
    normalized = replaceTokens(normalized, pathTokens, '{path}');
    normalized = replaceTokens(normalized, documentRoomTokens, 'document-{id}');
    normalized = replaceTokens(normalized, timestamps, '{timestamp}');
    normalized = normalized.replace(UUID_TOKEN, '{uuid}');
    normalized = normalized.replace(CONTEXT_ID_TOKEN, '$1 {id}');

    return {
        normalized,
        paths: Array.from(paths),
        assetIds: Array.from(assetIds),
        documentIds: Array.from(documentIds),
        timestamps: Array.from(timestamps)
    };
};

const client = new BrowserClient({
    dsn: DEBUG ? '' : SENTRY_DSN,
    transport: makeFetchTransport,
    stackParser: defaultStackParser,
    environment: `extension_${ENV === 'prod' ? 'live' : ENV}`,
    release: packageJson.version,
    integrations: [],
    beforeSend: (event) => {
        // type guard to ensure event has message and extra properties
        const typedEvent = event as typeof event & GroupingEvent;
        // extract raw message from either message events or exception events
        const exceptionValue = typedEvent.exception?.values?.[0];
        const raw = typedEvent.message || exceptionValue?.value;
        if (raw) {
            // note: group by normalized message template while retaining raw debug context
            const { normalized, paths, assetIds, documentIds, timestamps } = normalizeMessage(raw);
            typedEvent.extra = {
                // previous extra data is preserved
                ...(typedEvent.extra || {}),

                // new metadata is added
                metadata: {
                    message: raw,
                    paths,
                    assetIds,
                    documentIds,
                    timestamps
                }
            };
            if (typedEvent.message) {
                typedEvent.message = normalized;
            }
            if (exceptionValue) {
                exceptionValue.value = normalized;
            }
            typedEvent.fingerprint = [normalized];
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
