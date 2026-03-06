type Effect = () => void;

const stack: { effect: Effect; deps: Set<Set<Effect>> }[] = [];

export const signal = <T>(value: T): { get: () => T; set: <U extends T>(setter: (prev: T) => U) => U } => {
    let _value: T = value;

    const subscribers = new Set<Effect>();

    const get = () => {
        const ctx = stack[stack.length - 1];
        if (ctx) {
            subscribers.add(ctx.effect);
            ctx.deps.add(subscribers);
        }
        return _value;
    };

    const set = <U extends T>(setter: (prev: T) => U): U => {
        const newValue = setter(_value);
        if (newValue !== _value) {
            _value = newValue;
            for (const e of [...subscribers]) {
                e();
            }
        }
        return newValue;
    };

    return { get, set };
};

export const computed = <T>(fn: () => T): { get: () => T } => {
    const result = signal<T>(fn());

    const dispose = effect(() => {
        result.set(() => fn());
    });
    void dispose;

    return {
        get: result.get
    };
};

export const effect = (fn: Effect): (() => void) => {
    const deps = new Set<Set<Effect>>();
    const run = () => {
        // clear old deps
        for (const set of deps) {
            set.delete(run);
        }
        deps.clear();
        // track new deps
        const ctx = { effect: run, deps };
        stack.push(ctx);
        fn();
        stack.pop();
    };
    run();
    return () => {
        for (const set of deps) {
            set.delete(run);
        }
        deps.clear();
    };
};
