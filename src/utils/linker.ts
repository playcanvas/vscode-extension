import { Log } from '../log';

abstract class Linker<T> {
    protected _log = new Log(this.constructor.name);

    protected _cleanup: (() => Promise<void>)[] = [];

    abstract link(params: T): Promise<void>;

    async unlink() {
        await Promise.all(this._cleanup.map((fn) => fn()));
        this._cleanup.length = 0;

        return {} as T;
    }
}

export { Linker };
