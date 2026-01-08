class Debouncer<T> {
    private _timeouts = new Map<string, NodeJS.Timeout>();

    constructor(private readonly _delay: number) {}

    debounce(key: string, fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve) => {
            if (this._timeouts.get(key)) {
                clearTimeout(this._timeouts.get(key));
            }
            this._timeouts.set(
                key,
                setTimeout(() => {
                    fn()
                        .then(resolve)
                        .finally(() => {
                            this._timeouts.delete(key);
                        });
                }, this._delay)
            );
        });
    }

    cancel(key: string): void {
        const timeout = this._timeouts.get(key);
        if (timeout) {
            clearTimeout(timeout);
            this._timeouts.delete(key);
        }
    }

    clear() {
        for (const [, timeout] of this._timeouts) {
            clearTimeout(timeout);
        }
        this._timeouts.clear();
    }
}

export { Debouncer };
