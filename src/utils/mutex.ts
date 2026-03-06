class Mutex<T> {
    private _chains = new Map<string, Promise<T | undefined>>();

    constructor(
        private readonly _match: (key1: string, key2: string) => boolean,
        private readonly _onError?: (err: unknown) => void
    ) {}

    async atomic(keys: string[], fn: () => Promise<T>): Promise<T | undefined> {
        /* eslint-disable prefer-const -- let avoids TDZ; const throws inside IIFE */
        let chain: Promise<T | undefined>;
        chain = (async () => {
            // wait until no overlapping chains remain
            let deps: Promise<T | undefined>[];
            do {
                deps = Array.from(this._chains.entries())
                    .filter(([path, p]) => p !== chain && keys.some((k) => this._match(k, path)))
                    .map(([, p]) => p);
                if (deps.length) {
                    await Promise.all(deps);
                }
            } while (deps.length);
            return fn().catch((err) => {
                this._onError?.(err);
                return undefined;
            });
        })();

        for (const key of keys) {
            this._chains.set(key, chain);
        }

        chain.finally(() => {
            for (const key of keys) {
                if (this._chains.get(key) === chain) {
                    this._chains.delete(key);
                }
            }
        });

        return chain;
    }

    all() {
        return Promise.all(this._chains.values());
    }

    async clear() {
        await this.all();
        this._chains.clear();
    }
}

export { Mutex };
