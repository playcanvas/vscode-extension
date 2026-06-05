import { diff3Merge } from 'node-diff3';

import { norm } from '../utils/text';

import { CONFLICT_END, CONFLICT_SEP, CONFLICT_START } from './markers';

// line-based 3-way merge -> git-style conflict markers.
// base = last pulled ancestor, local = working tree, remote = current server.
export const merge = (base: string, local: string, remote: string) => {
    const regions = diff3Merge<string>(norm(local).split('\n'), norm(base).split('\n'), norm(remote).split('\n'), {
        excludeFalseConflicts: true
    });

    const out: string[] = [];
    let conflicted = false;
    for (const region of regions) {
        if (region.ok) {
            out.push(...region.ok);
        } else if (region.conflict) {
            conflicted = true;
            out.push(CONFLICT_START, ...region.conflict.a, CONFLICT_SEP, ...region.conflict.b, CONFLICT_END);
        }
    }

    return { text: out.join('\n'), conflicted };
};
