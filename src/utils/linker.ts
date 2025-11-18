abstract class Linker<T> {
    private _debug: boolean;

    protected _cleanup: (() => Promise<void>)[] = [];

    constructor(debug = false) {
        this._debug = debug;
    }

    protected _log(...args: unknown[]) {
        if (!this._debug) {
            return;
        }
        console.log(`[${this.constructor.name}]`, ...args);
    }

    abstract link(params: T): Promise<void>;

    async unlink() {
        await Promise.all(this._cleanup.map((fn) => fn()));
        this._cleanup.length = 0;

        return {} as T;
    }
}

export { Linker };
