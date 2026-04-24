const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export const from = (data: string): Uint8Array => {
    return encoder.encode(data);
};

export const toString = (data: Uint8Array): string => {
    return decoder.decode(data);
};

export const toBase64 = (data: Uint8Array): string => {
    let binary = '';
    for (const byte of data) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
};
