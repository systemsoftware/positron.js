class MenuItem {
    constructor({ label="", channel="", payload={}, key="", items=[], separator=false }) {
        this.label = label;
        this.channel = channel;
        this.payload = JSON.stringify(payload);
        this.key = key;
        this.items = items ? items.map(i => new MenuItem(i)) : null;
        this.separator = separator || false;
    }

    json() {
        return {
            label: this.label,
            channel: this.channel,
            payload: this.payload,
            key: this.key,
            items: this.items ? this.items.map(i => i.json()) : null,
            separator: this.separator
        }
    }
}

module.exports.Menu = class {

    #template = []

    constructor(template = []) {
        this.#template = template;
    }

get template() {
  return this.#template;
}

addItem(item = new MenuItem()) {
this.#template.push(item.json());
return this;
}
}

module.exports.MenuItem = MenuItem;