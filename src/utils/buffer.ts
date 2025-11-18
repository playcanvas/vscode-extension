const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export const from = (data: string): Uint8Array => {
    return encoder.encode(data);
};

export const toString = (data: Uint8Array): string => {
    return decoder.decode(data);
};

export const cmp = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
};
