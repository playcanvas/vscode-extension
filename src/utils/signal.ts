type Effect = () => void;

let current: Effect | null = null;

export const signal = <T>(value: T): { get: () => T; set: (setter: (prev: T) => T) => void } => {
    let _value: T = value;

    const subscribers = new Set<Effect>();

    const get = () => {
        if (current) {
            subscribers.add(current);
        }
        return _value;
    };

    const set = (setter: (prev: T) => T) => {
        const newValue = setter(_value);
        if (newValue !== _value) {
            _value = newValue;
            subscribers.forEach((effect) => effect());
        }
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
