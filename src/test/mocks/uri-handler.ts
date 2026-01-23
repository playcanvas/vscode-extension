import type sinon from 'sinon';
import * as vscode from 'vscode';

import { ROOT_FOLDER, ENV } from '../../config';
import { UriHandler } from '../../handlers/uri-handler';

import { assets, user } from './models';
import type { MockRest } from './rest';

class MockUriHandler extends UriHandler {
    filePath: string | undefined = assets.get(1)?.name;

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

    async openFile(folderUri: vscode.Uri) {
        const filePath = this.filePath;
        this.filePath = undefined;

        if (!filePath) {
            return;
        }

        await super._openDocument(folderUri, { filePath, line: 1, col: 1, error: true });
    }
}

export { MockUriHandler };
