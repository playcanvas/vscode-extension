import assert from 'assert';

import type sinon from 'sinon';

import { Rest } from '../../connections/rest';
import type { Asset, Branch, Project, User } from '../../typings/models';
import { hash } from '../../utils/utils';

import type { MockMessenger } from './messenger';
import { user, project, assets, branches, documents, accessToken, nextAssetIds, projectSettings } from './models';
import type { MockShareDb } from './sharedb';

class MockRest extends Rest {
    id: sinon.SinonSpy<[], Promise<number>>;

    user: sinon.SinonSpy<[], Promise<User>>;

    userThumb: sinon.SinonSpy<[], Promise<ArrayBuffer>>;

    userProjects: sinon.SinonSpy<[number, string?], Promise<Project[]>>;

    projectAssets: sinon.SinonSpy<[number], Promise<Asset[]>>;

    branchCheckout: sinon.SinonSpy<[string], Promise<Branch>>;

    assetCreate: sinon.SinonSpy<
        [
            number,
            string,
            {
                type: string;
                name: string;
                preload: boolean;
                parent?: number;
                filename?: string;
                file?: Blob;
            }
        ],
        Promise<Asset>
    >;

    assetRename: sinon.SinonSpy<[number, string, number, string], Promise<Asset>>;

    assetFile: sinon.SinonSpy<[number, string, string], Promise<ArrayBuffer>>;

    delayAssetFiles = false;

    assetFileDelay = 0;

    emitBranchSwitch = false;

    branchSwitchDelay = 0;

    distinctAssetIds = false;

    assetEndpointsUseItemIds = false;

    // FIFO of errors to throw on the next N calls of a given method. mirrors a final
    // post-retry failure from src/connections/rest.ts (MAX_RETRIES=3) — exercises the
    // ProjectManager error/guard path without simulating the retry loop itself.
    private _failures = new Map<string, Error[]>();

    failNext(
        method:
            | 'id'
            | 'user'
            | 'userThumb'
            | 'userProjects'
            | 'projectAssets'
            | 'projectBranches'
            | 'branchCheckout'
            | 'assetCreate'
            | 'assetRename'
            | 'assetFile',
        err: Error = new Error(`HTTP 500 (mock): ${method}`)
    ) {
        const q = this._failures.get(method) ?? [];
        q.push(err);
        this._failures.set(method, q);
    }

    resetFailures() {
        this._failures.clear();
        this.delayAssetFiles = false;
        this.assetFileDelay = 0;
        this.emitBranchSwitch = false;
        this.branchSwitchDelay = 0;
        this.distinctAssetIds = false;
        this.assetEndpointsUseItemIds = false;
    }

    private _maybeFail(method: string) {
        const err = this._failures.get(method)?.shift();
        if (err) {
            throw err;
        }
    }

    private _asset(id: number) {
        if (this.assetEndpointsUseItemIds) {
            return Array.from(assets.values()).find((asset) => parseInt(asset.item_id, 10) === id);
        }
        return assets.get(id) ?? Array.from(assets.values()).find((asset) => parseInt(asset.item_id, 10) === id);
    }

    constructor(sandbox: sinon.SinonSandbox, messenger: MockMessenger, sharedb: MockShareDb) {
        super({
            url: '',
            origin: '',
            accessToken
        });

        this.id = sandbox.spy(async () => {
            this._maybeFail('id');
            return user.id;
        });
        this.user = sandbox.spy(async () => {
            this._maybeFail('user');
            return user;
        });
        this.userThumb = sandbox.spy(async () => {
            this._maybeFail('userThumb');
            return new ArrayBuffer(0);
        });
        this.userProjects = sandbox.spy(async (_userId: number, _view?: string) => {
            this._maybeFail('userProjects');
            return [project];
        });
        this.projectAssets = sandbox.spy(async (_projectId: number) => {
            this._maybeFail('projectAssets');
            return Array.from(assets.values());
        });
        this.projectBranches = sandbox.spy(async (_projectId: number) => {
            this._maybeFail('projectBranches');
            return Array.from(branches.values());
        });
        this.branchCheckout = sandbox.spy(async (branchId: string) => {
            this._maybeFail('branchCheckout');
            const branch = branches.get(branchId)!;
            if (this.emitBranchSwitch) {
                projectSettings.branch = branch.id;
                setTimeout(() => {
                    messenger.emit('branch.switch', {
                        data: {
                            branch_id: branch.id,
                            project_id: branch.projectId,
                            name: branch.name
                        }
                    });
                }, this.branchSwitchDelay);
            }
            return branch;
        });
        this.assetCreate = sandbox.spy(
            async (
                _projectId: number,
                _branchId: string,
                data: {
                    type: string;
                    name: string;
                    preload: boolean;
                    parent?: number;
                    filename?: string;
                    file?: Blob;
                }
            ) => {
                this._maybeFail('assetCreate');
                // calculate path
                let path: number[] = [];
                if (data.parent) {
                    const asset = this._asset(data.parent);
                    if (!asset) {
                        throw new Error(`parent asset with ID ${data.parent} not found`);
                    }
                    path = asset.path.concat(parseInt(asset.item_id, 10));
                }

                // add new asset to assets map
                const ids = nextAssetIds(this.distinctAssetIds);
                const document = data.file ? await data.file.text() : '';
                const file =
                    data.type === 'folder'
                        ? undefined
                        : {
                              filename: data.filename || data.name,
                              hash: hash(document)
                          };
                const asset: Asset = {
                    uniqueId: ids.uniqueId,
                    item_id: `${ids.itemId}`,
                    file: this.delayAssetFiles ? undefined : file,
                    type: data.type,
                    path,
                    name: data.name
                };
                assets.set(asset.uniqueId, asset);

                // add document to documents map
                if (!this.delayAssetFiles) {
                    documents.set(asset.uniqueId, document);
                }

                // call messenger assetCreated signal
                messenger.emit('asset.new', {
                    data: {
                        asset: {
                            id: asset.item_id,
                            name: asset.name,
                            type: asset.type,
                            branchId: _branchId
                        }
                    }
                });

                if (this.delayAssetFiles && file) {
                    setTimeout(() => {
                        documents.set(asset.uniqueId, document);
                        const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
                        if (doc) {
                            doc.submitOp([{ p: ['file'], od: null, oi: file }], { source: 'remote' });
                        } else {
                            asset.file = file;
                        }
                    }, this.assetFileDelay);
                }

                return asset;
            }
        );
        this.assetRename = sandbox.spy(async (_projectId: number, _branchId: string, assetId: number, name: string) => {
            this._maybeFail('assetRename');
            // find asset and document
            const asset = this._asset(assetId);
            assert(asset, `asset with ID ${assetId} not found`);

            // rename asset
            asset.name = name;
            assets.set(asset.uniqueId, asset);

            // fire sharedb op on document
            const doc = sharedb.subscriptions.get(`assets:${asset.uniqueId}`);
            if (doc) {
                doc.submitOp(
                    [
                        {
                            p: ['name'],
                            oi: name
                        }
                    ],
                    { source: 'source' }
                );
            }

            return asset;
        });
        this.assetFile = sandbox.spy(async (assetId: number, _branchId: string, _filename: string) => {
            this._maybeFail('assetFile');
            const asset = this._asset(assetId);
            const content = documents.get(asset?.uniqueId ?? assetId) ?? '';
            return new TextEncoder().encode(content).buffer;
        });
    }
}

export { MockRest };
