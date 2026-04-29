// NOTE: sensitive keys to scrub from event data (matches monorepo sentry-utils.js)
const SECRETS_RE = /password|token|secret|passwd|authorization|api_key|apikey|sentry_dsn|access_token|credentials/i;

const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._+/=-]+/gi;
const AUTH_HEADER_RE = /\b(Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\s,;]+/gi;
const QUERY_TOKEN_RE = /\b(access_token|token|api_key|apikey|password|secret|sentry_dsn)\s*=\s*[^\s&"']+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

export const object = (obj: unknown, memo = new WeakSet()): unknown => {
    if (Array.isArray(obj)) {
        if (memo.has(obj)) {
            return obj;
        }
        memo.add(obj);
        const result = obj.map((v) => object(v, memo));
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
        for (const k of Object.keys(record)) {
            result[k] = SECRETS_RE.test(k) ? '********' : object(record[k], memo);
        }
        memo.delete(obj);
        return result;
    }
    return obj;
};

export const text = (s: string) =>
    s
        .replace(JWT_RE, '<jwt>')
        .replace(BEARER_RE, '$1 <redacted>')
        .replace(AUTH_HEADER_RE, '$1: <redacted>')
        .replace(QUERY_TOKEN_RE, '$1=<redacted>');

// JSON.stringify replacer — covers any shape (class instances, mixed prototypes)
// that JSON.stringify walks into; redact.object only recurses Object.prototype.
export const key = (k: string, value: unknown) => (SECRETS_RE.test(k) ? '********' : value);
