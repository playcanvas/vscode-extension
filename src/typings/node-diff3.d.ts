declare module 'node-diff3' {
    export type MergeRegion<T> = {
        ok?: T[];
        conflict?: {
            a: T[];
            aIndex: number;
            b: T[];
            bIndex: number;
            o: T[];
            oIndex: number;
        };
    };

    export type IMergeOptions = {
        excludeFalseConflicts?: boolean;
        stringSeparator?: string | RegExp;
    };

    export function diff3Merge<T>(
        a: string | T[],
        o: string | T[],
        b: string | T[],
        options?: IMergeOptions
    ): MergeRegion<T>[];
}
