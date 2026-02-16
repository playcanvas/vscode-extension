export type ShareDbTextOp =
    | [string | { d: number }]
    | [number, string | { d: number }]
    | [number, string, { d: number }]
    | [number, { d: number }, number, string]
    | [number, string, number, { d: number }];

export type ShareDbOp = {
    p: string[]; // path
    oi?: unknown; // object insert
    od?: unknown; // object delete
    li?: unknown; // list insert
    ld?: unknown; // list delete
};
