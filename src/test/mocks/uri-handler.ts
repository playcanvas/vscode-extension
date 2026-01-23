import type sinon from 'sinon';
import * as vscode from 'vscode';

import { ROOT_FOLDER, ENV } from '../../config';
import { UriHandler } from '../../handlers/uri-handler';

import { assets, user } from './models';
import type { MockRest } from './rest';

class MockUriHandler extends UriHandler {
    filePath: string | undefined = assets.get(1)?.name;

    line: number | undefined = undefined;

    col: number | undefined = undefined;

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

    openFile() {
        const filePath = this.filePath;
        this.filePath = undefined;
        const line = this.line;
        this.line = undefined;
        const col = this.col;
        this.col = undefined;
        return Promise.resolve(
            filePath
                ? {
                      filePath,
                      line,
                      col
                  }
                : undefined
        );
    }
}

export { MockUriHandler };
