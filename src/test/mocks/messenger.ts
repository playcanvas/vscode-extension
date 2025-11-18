import type sinon from 'sinon';

import { Messenger } from '../../connections/messenger';

class MockMessenger extends Messenger {
    connect: sinon.SinonSpy<[], Promise<void>>;

    disconnect: sinon.SinonSpy<[], void>;

    watch: sinon.SinonSpy<[projectId: number], void>;

    unwatch: sinon.SinonSpy<[projectId: number], void>;

    send: sinon.SinonSpy<[], Promise<void>>;

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
        this.watch = sandbox.spy((_projectId: number) => undefined);
        this.unwatch = sandbox.spy((_projectId: number) => undefined);
        this.send = sandbox.spy(async () => undefined);
    }
}

export { MockMessenger };
