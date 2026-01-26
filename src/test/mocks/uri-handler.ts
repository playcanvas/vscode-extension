import type sinon from 'sinon';
import * as vscode from 'vscode';

import { ROOT_FOLDER, ENV } from '../../config';
import { UriHandler } from '../../handlers/uri-handler';

import { user } from './models';
import type { MockRest } from './rest';

class MockUriHandler extends UriHandler {
    handleUri: sinon.SinonSpy<[vscode.Uri], Promise<void>>;

    constructor(sandbox: sinon.SinonSandbox, rest: MockRest) {
        super({
            context: { subscriptions: [] } as Partial<vscode.ExtensionContext> as vscode.ExtensionContext,
            rootUri: vscode.Uri.parse(`${ROOT_FOLDER}/${ENV}`),
            userId: user.id,
            rest
        });

        this.handleUri = sandbox.spy(super.handleUri.bind(this));
    }

    async _openFile(folderUri: vscode.Uri) {
        if (!this._projectManager) {
            return;
        }
        await super._openDocument(folderUri, this._projectManager, { assetId: 1, line: 1, col: 1, error: true });
    }
}

export { MockUriHandler };
