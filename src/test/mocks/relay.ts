import type sinon from 'sinon';

import { Relay } from '../../connections/relay';

class MockRelay extends Relay {
    connect: sinon.SinonSpy<[], Promise<void>>;

    disconnect: sinon.SinonSpy<[], void>;

    join: sinon.SinonSpy<[], void>;

    leave: sinon.SinonSpy<[], void>;

    message: sinon.SinonSpy<[], void>;

    constructor(sandbox: sinon.SinonSandbox) {
        super({
            url: '',
            origin: '',
        });

        this.connect = sandbox.spy(async () => {
            this.connected.set(() => true);
        });
        this.disconnect = sandbox.spy(() => {
            this.connected.set(() => false);
        });
        this.join = sandbox.spy(() => undefined);
        this.leave = sandbox.spy(() => undefined);
        this.message = sandbox.spy(() => undefined);
    }
}

export { MockRelay };
