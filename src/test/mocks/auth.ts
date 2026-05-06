import type sinon from 'sinon';
import type * as vscode from 'vscode';

import { Auth } from '../../auth';

import { accessToken } from './models';

class MockAuth extends Auth {
    getAccessToken: sinon.SinonSpy<[manual?: boolean, reload?: boolean], Promise<string>>;

    getStoredAccessToken: sinon.SinonSpy<[], Promise<string>>;

    clearAccessToken: sinon.SinonSpy<[], Promise<void>>;

    reset: sinon.SinonSpy<[reason?: string], Promise<void>>;

    constructor(sandbox: sinon.SinonSandbox) {
        super({} as vscode.ExtensionContext);

        this.getAccessToken = sandbox.spy(async () => accessToken);
        this.getStoredAccessToken = sandbox.spy(async () => accessToken);
        this.clearAccessToken = sandbox.spy(async () => undefined);
        this.reset = sandbox.spy(async () => undefined);
    }
}

export { MockAuth };
