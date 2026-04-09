import type sinon from 'sinon';
import type * as vscode from 'vscode';

import { Auth } from '../../auth';

import { accessToken } from './models';

class MockAuth extends Auth {
    getAccessToken: sinon.SinonSpy<[], Promise<string>>;

    reset: sinon.SinonSpy<[reason?: string], Promise<void>>;

    constructor(sandbox: sinon.SinonSandbox) {
        super({} as vscode.ExtensionContext);

        this.getAccessToken = sandbox.spy(async () => accessToken);
        this.reset = sandbox.spy(async () => undefined);
    }
}

export { MockAuth };
