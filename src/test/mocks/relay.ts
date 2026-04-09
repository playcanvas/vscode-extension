import type sinon from 'sinon';

import { Relay } from '../../connections/relay';

class MockRelay extends Relay {
    connect: sinon.SinonSpy<[() => string], Promise<void>>;

    disconnect: sinon.SinonSpy<[], void>;

    join: sinon.SinonSpy<[], void>;

    leave: sinon.SinonSpy<[], void>;

    message: sinon.SinonSpy<[], void>;

    constructor(sandbox: sinon.SinonSandbox) {
        super({
            url: '',
            origin: ''
        });

        this.connect = sandbox.spy(async (_getToken: () => string) => {
            this.connected.set(() => {
                return true;
            });
        });
        this.disconnect = sandbox.spy(() => {
            this.connected.set(() => {
                return false;
            });
        });
        this.join = sandbox.spy(() => {
            return undefined;
        });
        this.leave = sandbox.spy(() => {
            return undefined;
        });
        this.message = sandbox.spy(() => {
            return undefined;
        });
    }
}

export { MockRelay };
