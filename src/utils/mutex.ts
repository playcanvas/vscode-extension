class Mutex<T> {
    private _chains = new Map<string, Promise<T | undefined>>();

    async atomic(key: string, fn: () => Promise<T>): Promise<T> {
        const tail = this._chains.get(key) || Promise.resolve();
        const promise = tail.then(() => {
            return fn();
        });
        const cleanup = promise
            .catch(() => undefined)
            .finally(() => {
                if (this._chains.get(key) === cleanup) {
                    this._chains.delete(key);
                }
            });
        this._chains.set(key, cleanup);
        return promise;
    }

    clear() {
        this._chains.clear();
    }
}

export { Mutex };
