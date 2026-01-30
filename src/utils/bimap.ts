class Bimap<T1, T2> {
    private _forward = new Map<T1, T2>();

    private _backward = new Map<T2, T1>();

    set(keyL: T1, keyR: T2) {
        this._forward.set(keyL, keyR);
        this._backward.set(keyR, keyL);
    }

    delete(keyL: T1, keyR: T2) {
        this._forward.delete(keyL);
        this._backward.delete(keyR);
    }

    getL(keyL: T1): T2 | undefined {
        return this._forward.get(keyL);
    }

    getR(keyR: T2): T1 | undefined {
        return this._backward.get(keyR);
    }

    entries() {
        return this._forward.entries();
    }

    clear() {
        this._forward.clear();
        this._backward.clear();
    }
}

export { Bimap };
