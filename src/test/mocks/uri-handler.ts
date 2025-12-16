import type sinon from 'sinon';
import * as vscode from 'vscode';

import { ROOT_FOLDER, ENV } from '../../config';
import { UriHandler } from '../../handlers/uri-handler';

import { assets, user } from './models';
import type { MockRest } from './rest';

class MockUriHandler extends UriHandler {
    openFilePath: string | undefined = assets.get(1)?.name;

    handleUri: sinon.SinonSpy<[vscode.Uri], Promise<void>>;

    constructor(sandbox: sinon.SinonSandbox, rest: MockRest) {
        super({
            context: {} as vscode.ExtensionContext,
            rootUri: vscode.Uri.parse(`${ROOT_FOLDER}/${ENV}`),
            userId: user.id,
            rest
        });

        this.handleUri = sandbox.spy(super.handleUri.bind(this));
    }

    getOpenFilePath() {
        const openFilePath = this.openFilePath;
        this.openFilePath = undefined;
        return Promise.resolve(openFilePath);
    }
}

export { MockUriHandler };
