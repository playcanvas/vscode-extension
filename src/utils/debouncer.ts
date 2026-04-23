class Debouncer<T> {
    private _pending = new Map<string, { timeout: NodeJS.Timeout; reject: (err: Error) => void }>();

    constructor(private readonly _delay: number) {}

    debounce(key: string, fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const existing = this._pending.get(key);
            if (existing) {
                clearTimeout(existing.timeout);
                existing.reject(new Error('debounce superseded'));
            }
            this._pending.set(key, {
                timeout: setTimeout(() => {
                    fn()
                        .then(resolve)
                        .catch(reject)
                        .finally(() => this._pending.delete(key));
                }, this._delay),
                reject
            });
        });
    }

    cancel(key: string) {
        const existing = this._pending.get(key);
        if (existing) {
            clearTimeout(existing.timeout);
            existing.reject(new Error('debounce cancelled'));
            this._pending.delete(key);
        }
    }

    has(key: string) {
        return this._pending.has(key);
    }

    clear() {
        for (const [, { timeout, reject }] of this._pending) {
            clearTimeout(timeout);
            reject(new Error('debounce cleared'));
        }
        this._pending.clear();
    }
}

export { Debouncer };
