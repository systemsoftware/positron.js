const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const DataStore = require('../store');
const { app } = require('../index');

describe('DataStore', () => {
    let store;

    before(() => {
        app.setName('test_positron_app');
        store = new DataStore('test_store');
        store.clear();
    });

    after(() => {
        store.rm();
        process.exit(0);
    });

    test('should require an id', () => {
        assert.throws(() => new DataStore(), { message: 'Store id is required' });
    });

    test('should reject path traversal in id', () => {
        assert.throws(() => new DataStore('../test'), { message: 'Invalid store id: cannot contain path traversals' });
        assert.throws(() => new DataStore('test/../foo'), { message: 'Invalid store id: cannot contain path traversals' });
    });

    test('should set and get values', () => {
        store.set('key1', 'value1');
        assert.strictEqual(store.get('key1'), 'value1');
    });

    test('should delete values', () => {
        store.set('key2', 'value2');
        store.delete('key2');
        assert.strictEqual(store.get('key2'), undefined);
    });

    test('should get all values', () => {
        store.clear();
        store.set('k1', 'v1');
        store.set('k2', 'v2');
        assert.deepStrictEqual(store.all(), { k1: 'v1', k2: 'v2' });
    });

    test('should clear values', () => {
        store.set('k1', 'v1');
        store.clear();
        assert.deepStrictEqual(store.all(), {});
    });
});
