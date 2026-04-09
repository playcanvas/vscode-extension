class Mutex<T> {
    private _match: (key1: string, key2: string) => boolean;

    private _onerror: (err: unknown) => void;

    private _chains = new Map<string, Promise<T | undefined>>();

    constructor(match = (k1: string, k2: string) => k1 === k2, onerror: (err: unknown) => void = () => void 0) {
        this._match = match;
        this._onerror = onerror;
    }

    async atomic(keys: string[], fn: () => Promise<T>): Promise<T | undefined> {
        // snapshot dependencies before registering this chain to avoid deadlocks
        const deps = Array.from(
            new Set(
                Array.from(this._chains.entries())
                    .filter(([path]) => keys.some((k) => this._match(k, path)))
                    .map(([, p]) => p)
            )
        );
        const chain = Promise.allSettled(deps).then(() =>
            fn().catch((err) => {
                this._onerror(err);
                return undefined;
            })
        );

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
