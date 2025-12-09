class Mutex<T> {
    private _chains = new Map<string, Promise<T | undefined>>();

    async atomic(key: string, fn: () => Promise<T>): Promise<T> {
        const tail = this._chains.get(key) || Promise.resolve();
        const promise = tail.then(() => {
            return fn();
        });
        this._chains.set(
            key,
            promise
                .catch(() => undefined)
                .finally(() => {
                    if (this._chains.get(key) === promise) {
                        this._chains.delete(key);
                    }
                })
        );
        return promise;
    }

    clear() {
        this._chains.clear();
    }
}

export { Mutex };
