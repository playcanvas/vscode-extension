class Mutex<T> {
    private _chains = new Map<string, Promise<T | undefined>>();

    constructor(private readonly _match: (key1: string, key2: string) => boolean) {}

    async atomic(keys: string[], fn: () => Promise<T>): Promise<T | undefined> {
        // wait for all matching chains to complete
        const wait = Promise.all(
            Array.from(this._chains.entries()).reduce(
                (rest, [path, promise]) => {
                    if (keys.some((key) => this._match(key, path))) {
                        rest.push(promise);
                    }
                    return rest;
                },
                [] as Promise<T | undefined>[]
            )
        );

        // schedule the new operation
        const chain = wait
            .then(() => fn().catch(() => undefined))
            .finally(() => {
                // remove the chain when done
                for (const key of keys) {
                    if (this._chains.get(key) === chain) {
                        this._chains.delete(key);
                    }
                }
            });

        // store the new chain for all keys
        for (const key of keys) {
            this._chains.set(key, chain);
        }

        return chain;
    }

    all() {
        return Promise.all(this._chains.values());
    }

    clear() {
        this._chains.clear();
    }
}

export { Mutex };
