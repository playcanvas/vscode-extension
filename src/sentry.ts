import * as os from 'os';

import { BrowserClient, defaultStackParser, getDefaultIntegrations, makeFetchTransport, Scope } from '@sentry/browser';
import { getIntegrationsToSetup } from '@sentry/core';
import * as vscode from 'vscode';

import packageJson from '../package.json';

import { ENV, SENTRY_DSN } from './config';
import type { FingerprintedError } from './utils/error';
import * as redact from './utils/redact';

const OS_NAMES: Record<string, string> = {
    darwin: 'Mac OS X',
    linux: 'Linux',
    win32: 'Windows'
};

// sentry breadcrumb levels — log.ts maps trace→debug since sentry has no trace
type BreadcrumbLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

const isFingerprintedError = (e: unknown): e is FingerprintedError =>
    e instanceof Error && 'fingerprint' in e && typeof (e as FingerprintedError).fingerprint === 'string';

type GroupingEvent = {
    message?: string;
    extra?: Record<string, unknown>;
    fingerprint?: string[];
    event_id?: string;
};

let _lastEventId: string | undefined;

const client = new BrowserClient({
    dsn: SENTRY_DSN,
    transport: makeFetchTransport,
    stackParser: defaultStackParser,
    environment: `extension_${ENV === 'prod' ? 'live' : ENV}`,
    release: packageJson.version,
    attachStacktrace: true,
    sendDefaultPii: true,
    integrations: getIntegrationsToSetup({
        defaultIntegrations: getDefaultIntegrations({}),
        integrations: []
    }),
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

        if (typedEvent.event_id) {
            _lastEventId = typedEvent.event_id;
        }

        return redact.object(typedEvent) as typeof event;
    }
});

const scope = new Scope();
scope.setClient(client);
scope.setTag('page', 'vscode-extension');
scope.setContext('os', { name: OS_NAMES[process.platform] ?? process.platform, version: os.release() });
scope.setContext('browser', { name: 'VS Code', version: vscode.version });
scope.setContext('device', { family: 'Desktop', arch: os.arch() });
client.init();

export const captureException = (error: Error, source?: string) => {
    const s = source ? scope.clone() : scope;
    if (source) {
        s.setTag('source', source);
    }
    s.captureException(error);
};

export const captureMessage = (message: string, level: 'info' | 'warning' | 'error' = 'error', source?: string) => {
    const s = source ? scope.clone() : scope;
    if (source) {
        s.setTag('source', source);
    }
    return s.captureMessage(message, level);
};

// user-driven report — captureEvent directly so no synthetic stacktrace.
// transaction → big main line (description), message → small top label.
// fingerprint includes the description so distinct descriptions form distinct
// issues (default grouping uses message, which is constant here).
export const captureIssue = (description: string, contexts?: Record<string, Record<string, unknown>>) =>
    scope.captureEvent({
        message: 'User Report',
        level: 'info',
        tags: { kind: 'report' },
        transaction: description,
        fingerprint: ['playcanvas-user-report', description],
        contexts
    });

export const addBreadcrumb = (b: { level: BreadcrumbLevel; category: string; message: string }) => {
    scope.addBreadcrumb({ level: b.level, category: b.category, message: b.message });
};

// caller must redact — attachments bypass beforeSend
export const addAttachment = (a: { filename: string; data: string | Uint8Array; contentType?: string }) => {
    scope.addAttachment(a);
};

export const getLastSentryEventId = () => _lastEventId;

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
