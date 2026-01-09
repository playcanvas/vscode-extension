type Effect = () => void;

let current: Effect | null = null;

export const signal = <T>(value: T): { get: () => T; set: <U extends T>(setter: (prev: T) => U) => U } => {
    let _value: T = value;

    const subscribers = new Set<Effect>();

    const get = () => {
        if (current) {
            subscribers.add(current);
        }
        return _value;
    };

    const set = <U extends T>(setter: (prev: T) => U): U => {
        const newValue = setter(_value);
        if (newValue !== _value) {
            _value = newValue;
            subscribers.forEach((effect) => effect());
        }
        return newValue;
    };

    return { get, set };
};

export const computed = <T>(fn: () => T): { get: () => T } => {
    const result = signal<T>(fn());

    effect(() => {
        result.set(() => fn());
    });

    return {
        get: result.get
    };
};

export const effect = (fn: Effect) => {
    const run = () => {
        current = run;
        fn();
        current = null;
    };
    run();
};
