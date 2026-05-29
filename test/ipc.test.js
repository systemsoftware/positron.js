const { test, describe } = require('node:test');
const assert = require('node:assert');
const IpcRouter = require('../ipc');

describe('IpcRouter', () => {
    test('should register and unregister handlers', () => {
        const router = new IpcRouter();
        let called = false;
        const handler = () => { called = true; };
        
        const unsubscribe = router.handle('test-channel', handler);
        
        const wsMock = { send: () => {} };
        const msg = {
            event: 'ipcMessage',
            windowId: 1,
            data: { channel: 'test-channel', payload: {} }
        };

        const dispatched = router.dispatch(wsMock, msg);
        assert.strictEqual(dispatched, true);
        assert.strictEqual(called, true);

        called = false;
        unsubscribe();
        const dispatchedAfter = router.dispatch(wsMock, msg);
        assert.strictEqual(dispatchedAfter, false);
        assert.strictEqual(called, false);
    });

    test('should correctly parse payload and provide reply/emit functions', () => {
        const router = new IpcRouter();
        
        let replyCalledWith = null;
        let emitCalledWith = null;

        router.handle('hello', (payload, { reply, emit, windowId }) => {
            assert.strictEqual(payload.foo, 'bar');
            assert.strictEqual(windowId, 42);
            reply({ res: 'ok' });
            emit('custom-event', { custom: true });
        });

        const wsMock = {
            readyState: 1, 
            send: (dataStr) => {
                const data = JSON.parse(dataStr);
                if (data.args[0] === 'hello-reply') replyCalledWith = JSON.parse(data.args[1]);
                if (data.args[0] === 'custom-event') emitCalledWith = JSON.parse(data.args[1]);
            }
        };

        global.WebSocket = { OPEN: 1 };

        const msg = {
            event: 'ipcMessage',
            windowId: 42,
            data: { channel: 'hello', payload: '{"foo":"bar"}' }
        };

        router.dispatch(wsMock, msg);
        
        assert.deepStrictEqual(replyCalledWith, { res: 'ok' });
        assert.deepStrictEqual(emitCalledWith, { custom: true });
    });
});
