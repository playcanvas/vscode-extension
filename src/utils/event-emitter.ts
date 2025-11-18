type EventMap = Record<string, unknown[]>;
type Key<T extends EventMap> = keyof T & string;
type Listener<T extends EventMap, K extends Key<T>> = (...args: T[K]) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class EventEmitter<T extends EventMap = Record<string, any[]>> {
    private _listeners = new Map<Key<T>, Listener<T, Key<T>>[]>();

    on<K extends Key<T>>(event: K, listener: Listener<T, K>) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, []);
        }
        this._listeners.get(event)!.push(listener as Listener<T, Key<T>>);
        return listener;
    }

    off<K extends Key<T>>(event: K, listener: Listener<T, K>) {
        if (!this._listeners.has(event)) {
            return this;
        }
        const index = this._listeners.get(event)!.indexOf(listener as Listener<T, Key<T>>);
        if (index === -1) {
            return this;
        }
        this._listeners.set(
            event,
            this._listeners.get(event)!.filter((l) => l !== listener)
        );
        return this;
    }

    emit<K extends Key<T>>(event: K, ...args: T[K]) {
        if (!this._listeners.has(event)) {
            return false;
        }
        for (const listener of this._listeners.get(event)!) {
            listener(...args);
        }
        return true;
    }

    removeAllListeners() {
        this._listeners.clear();
    }
}

export { EventEmitter };
