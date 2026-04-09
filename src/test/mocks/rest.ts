import assert from 'assert';

import type sinon from 'sinon';

import { Rest } from '../../connections/rest';
import type { Asset, Branch, Project, User } from '../../typings/models';
import { hash } from '../../utils/utils';

import type { MockMessenger } from './messenger';
import { user, project, assets, branches, documents, accessToken, uniqueId } from './models';
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

    constructor(sandbox: sinon.SinonSandbox, messenger: MockMessenger, sharedb: MockShareDb) {
        super({
            url: '',
            origin: '',
            accessToken
        });

        this.id = sandbox.spy(async () => user.id);
        this.user = sandbox.spy(async () => user);
        this.userThumb = sandbox.spy(async () => new ArrayBuffer(0));
        this.userProjects = sandbox.spy(async (_userId: number, _view?: string) => [project]);
        this.projectAssets = sandbox.spy(async (_projectId: number) => Array.from(assets.values()));
        this.projectBranches = sandbox.spy(async (_projectId: number) => Array.from(branches.values()));
        this.branchCheckout = sandbox.spy(async (branchId: string) => branches.get(branchId)!);
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
                // calculate path
                let path: number[] = [];
                if (data.parent) {
                    const asset = assets.get(data.parent);
                    if (!asset) {
                        throw new Error(`parent asset with ID ${data.parent} not found`);
                    }
                    path = asset.path.concat(data.parent);
                }

                // add new asset to assets map
                const id = uniqueId.next().value;
                const document = data.file ? await data.file.text() : '';
                const asset: Asset = {
                    uniqueId: id,
                    item_id: `${id}`,
                    file:
                        data.type === 'folder'
                            ? undefined
                            : {
                                  filename: data.filename || data.name,
                                  hash: hash(document)
                              },
                    type: data.type,
                    path,
                    name: data.name
                };
                assets.set(id, asset);

                // add document to documents map
                documents.set(asset.uniqueId, document);

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

                return asset;
            }
        );
        this.assetRename = sandbox.spy(async (_projectId: number, _branchId: string, assetId: number, name: string) => {
            // find asset and document
            const asset = assets.get(assetId);
            assert(asset, `asset with ID ${assetId} not found`);

            // rename asset
            asset.name = name;
            assets.set(assetId, asset);

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
    }
}

export { MockRest };
