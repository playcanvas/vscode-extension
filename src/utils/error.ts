export type FingerprintedError = Error & { fingerprint: string; context: unknown[] };

export const fail = (strings: TemplateStringsArray, ...values: unknown[]): FingerprintedError => {
    const e = new Error(String.raw(strings, ...values)) as FingerprintedError;
    e.fingerprint = strings.join('{}');
    e.context = values;
    return e;
};
