declare module 'ot-text' {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    export const type: import('sharedb/lib/sharedb.js').Type & {
        semanticInvert(str: string, op: unknown[]): unknown[];
    };
}
