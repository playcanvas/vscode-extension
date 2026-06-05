import { hasConflictMarkers } from './markers';

export type SyncState = 'clean' | 'modified' | 'behind' | 'both' | 'conflicted';

// classify a file's content sync state.
// base = last pull, working = disk, remote = current server.
export const classify = (baseHash: string, workingHash: string, remoteHash: string, working: string) => {
    if (hasConflictMarkers(working)) {
        return 'conflicted' as const;
    }
    const ahead = workingHash !== baseHash;
    const behind = remoteHash !== baseHash;
    if (ahead && behind) {
        return 'both' as const;
    }
    if (ahead) {
        return 'modified' as const;
    }
    if (behind) {
        return 'behind' as const;
    }
    return 'clean' as const;
};
