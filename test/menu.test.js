const { test, describe } = require('node:test');
const assert = require('node:assert');
const { Menu, MenuItem, Separator } = require('../menu');

describe('Menu System', () => {
    test('MenuItem should serialize to JSON correctly', () => {
        const item = new MenuItem({ label: 'File', channel: 'file-menu', payload: { a: 1 } });
        const json = item.json();
        assert.strictEqual(json.label, 'File');
        assert.strictEqual(json.channel, 'file-menu');
        assert.strictEqual(json.payload, JSON.stringify({ a: 1 }));
    });

    test('Separator should have separator property true', () => {
        const sep = new Separator();
        assert.strictEqual(sep.json().separator, true);
    });

    test('Menu should allow adding items and returning a template', () => {
        const menu = new Menu();
        menu.addItem(new MenuItem({ label: 'Edit' }));
        menu.addItems([new MenuItem({ label: 'Cut' }), new Separator()]);

        const template = menu.template;
        assert.strictEqual(template.length, 3);
        assert.strictEqual(template[0].label, 'Edit');
        assert.strictEqual(template[1].label, 'Cut');
        assert.strictEqual(template[2].separator, true);
    });
});
