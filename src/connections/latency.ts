import type WebSocket from 'isomorphic-ws';
import type { MessageEvent } from 'ws';

const LATENCY = parseInt(process.env.LATENCY ?? '0', 10) || 0;
const JITTER = parseInt(process.env.JITTER ?? '0', 10) || 0;

/** computed delay with optional jitter */
const delay = () => (LATENCY > 0 ? LATENCY + Math.round((Math.random() * 2 - 1) * JITTER) : 0);

type SendArgs = Parameters<WebSocket['send']>;
type MessageListener = (event: MessageEvent) => void;

/** patch send, addEventListener, and removeEventListener to inject simulated latency */
const latency = <T extends WebSocket>(socket: T): T => {
    const ms = delay();
    if (!ms) {
        return socket;
    }

    // delay outgoing
    const send = socket.send.bind(socket) as (...args: SendArgs) => void;
    socket.send = ((...args: SendArgs) => {
        setTimeout(() => send(...args), delay());
    }) as typeof socket.send;

    // track original→wrapped listeners so removeEventListener works
    const listeners = new WeakMap<MessageListener, MessageListener>();

    // delay incoming via addEventListener
    const add = socket.addEventListener.bind(socket) as typeof socket.addEventListener;
    socket.addEventListener = (<K extends keyof WebSocket.WebSocketEventMap>(
        event: K,
        fn: ((ev: WebSocket.WebSocketEventMap[K]) => void) | { handleEvent(ev: WebSocket.WebSocketEventMap[K]): void },
        ...rest: [WebSocket.EventListenerOptions?]
    ) => {
        if (event === 'message') {
            const delayed: MessageListener = (ev) => setTimeout(() => (fn as MessageListener)(ev), delay());
            listeners.set(fn as MessageListener, delayed);
            return add('message', delayed, ...rest);
        }
        return add(event, fn, ...rest);
    }) as typeof socket.addEventListener;

    // unwrap when removing
    const remove = socket.removeEventListener.bind(socket) as typeof socket.removeEventListener;
    socket.removeEventListener = (<K extends keyof WebSocket.WebSocketEventMap>(
        event: K,
        fn: ((ev: WebSocket.WebSocketEventMap[K]) => void) | { handleEvent(ev: WebSocket.WebSocketEventMap[K]): void }
    ) => {
        if (event === 'message') {
            const wrapped = listeners.get(fn as MessageListener);
            if (wrapped) {
                listeners.delete(fn as MessageListener);
                return remove('message', wrapped);
            }
        }
        return remove(event, fn);
    }) as typeof socket.removeEventListener;

    return socket;
};

export { delay, latency };
