import type sinon from 'sinon';

import { Messenger } from '../../connections/messenger';

class MockMessenger extends Messenger {
    connect: sinon.SinonSpy<[() => string], Promise<void>>;

    disconnect: sinon.SinonSpy<[], void>;

    watch: sinon.SinonSpy<[projectId: number], void>;

    unwatch: sinon.SinonSpy<[projectId: number], void>;

    send: sinon.SinonSpy<[], Promise<void>>;

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
        this.watch = sandbox.spy((_projectId: number) => {
            return undefined;
        });
        this.unwatch = sandbox.spy((_projectId: number) => {
            return undefined;
        });
        this.send = sandbox.spy(async () => {
            return undefined;
        });
    }
}

export { MockMessenger };
