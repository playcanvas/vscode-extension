class Mutex<T> {
    private _chains = new Map<string, Promise<T | undefined>>();

    async atomic(key: string, fn: () => Promise<T>): Promise<T> {
        const tail = this._chains.get(key) || Promise.resolve();
        const promise = tail.then(() => {
            return fn();
        });
        this._chains.set(
            key,
            promise.catch(() => undefined)
        );
        return promise;
    }
}

export { Mutex };
