class MenuItem {
    constructor({ label="", channel="", payload={}, key="", items=[], separator=false, click=()=>{}, enabled=true }) {
        this.label = label;
        this.channel = channel;
        this.payload = JSON.stringify(payload);
        this.key = key;
        this.items = items ? items.map(i => new MenuItem(i)) : null;
        this.enabled = enabled;
        this.click = click;
        this.separator = separator || false;
    }

    json() {
        return {
            label: this.label,
            channel: this.channel,
            payload: this.payload,
            key: this.key,
            items: this.items ? this.items.map(i => i.json()) : null,
            separator: this.separator,
            enabled: this.enabled,
            click: this.click
        }
    }
}

class Separator extends MenuItem {
    constructor() {
        super({ separator: true });
    }
}


 class Menu {

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

addItems(items = []) {
items.forEach(item => this.addItem(item));
return this;
}

}

module.exports = {
    Menu,
    MenuItem,
    Separator
}