import type { Log } from './log';
import { signal } from './utils/signal';

type CollisionFile = {
    uniqueId: number;
};

type PathOverride = {
    path?: number[];
    name?: string;
};

class CollisionManager {
    private _files: Map<string, CollisionFile>;

    private _assetPath: (uniqueId: number, override?: PathOverride) => string;

    private _assetId: (uniqueId: number) => number | undefined;

    private _log: Log;

    private _collided = new Map<number, string>();

    private _collidedByPath = new Map<string, Set<number>>();

    count = signal(0);

    constructor({
        files,
        assetPath,
        assetId,
        log
    }: {
        files: Map<string, CollisionFile>;
        assetPath: (uniqueId: number, override?: PathOverride) => string;
        assetId: (uniqueId: number) => number | undefined;
        log: Log;
    }) {
        this._files = files;
        this._assetPath = assetPath;
        this._assetId = assetId;
        this._log = log;
    }

    private _add(uniqueId: number, filePath: string) {
        const old = this._collided.get(uniqueId);
        if (old && old !== filePath) {
            const set = this._collidedByPath.get(old);
            if (set) {
                set.delete(uniqueId);
                if (set.size === 0) {
                    this._collidedByPath.delete(old);
                }
            }
        }
        this._collided.set(uniqueId, filePath);
        const set = this._collidedByPath.get(filePath) ?? new Set<number>();
        set.add(uniqueId);
        this._collidedByPath.set(filePath, set);
    }

    remove(uniqueId: number) {
        const filePath = this._collided.get(uniqueId);
        if (!filePath) {
            return false;
        }
        this._collided.delete(uniqueId);
        const set = this._collidedByPath.get(filePath);
        if (set) {
            set.delete(uniqueId);
            if (set.size === 0) {
                this._collidedByPath.delete(filePath);
            }
        }
        return true;
    }

    check(uniqueId: number, override: PathOverride = {}) {
        const filePath = this._assetPath(uniqueId, override);
        const file = this._files.get(filePath);

        if (file) {
            this._log.warn(`skipping loading asset ${uniqueId} as path already exists: ${filePath}`);
            this._add(file.uniqueId, filePath);
            this._add(uniqueId, filePath);
            return { skip: true, changed: true };
        }

        if (this._collidedByPath.has(filePath)) {
            this._log.warn(`skipping loading asset ${uniqueId} as path already exists: ${filePath}`);
            this._add(uniqueId, filePath);
            return { skip: true, changed: true };
        }

        for (const collidedPath of this._collidedByPath.keys()) {
            if (filePath.startsWith(`${collidedPath}/`)) {
                this._log.warn(
                    `skipping loading of asset ${uniqueId} as ancestor path ${collidedPath} has a collision`
                );
                return { skip: true, changed: false };
            }
        }

        return { skip: false, changed: false };
    }

    refresh() {
        const counts = new Map<string, number>();
        for (const path of this._collided.values()) {
            counts.set(path, (counts.get(path) ?? 0) + 1);
        }

        const remove: number[] = [];
        for (const [uniqueId, path] of this._collided) {
            if ((counts.get(path) ?? 0) < 2) {
                remove.push(uniqueId);
            }
        }

        for (const uniqueId of remove) {
            this.remove(uniqueId);
        }

        this.count.set(() => this._collidedByPath.size);
    }

    snapshot() {
        const result = new Map<string, number[]>();
        for (const [uniqueId, path] of this._collided) {
            const id = this._assetId(uniqueId);
            if (!id) {
                continue;
            }
            const array = result.get(path) ?? [];
            array.push(id);
            result.set(path, array);
        }
        return result;
    }

    clear() {
        this._collided.clear();
        this._collidedByPath.clear();
        this.count.set(() => 0);
    }
}

export { CollisionManager };
