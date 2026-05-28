class MenuItem {

    /**
     * Creates a new MenuItem instance with the specified properties. The label is the text displayed for the menu item, the channel is the IPC channel to send when the item is clicked, and the payload is the data to send along with the click event. The key is an optional identifier for the menu item, and items can be used to create submenus. The separator property indicates whether this item is a separator, and click is a callback function that will be called when the item is clicked. The enabled property determines whether the menu item is enabled or disabled.
     * @param {Object} options - The options for creating the MenuItem.
     * @param {string} options.label - The text displayed for the menu item.
     * @param {string} options.channel - The IPC channel to send when the item is clicked.
     * @param {Object} options.payload - The data to send along with the click event.
     * @param {string} [options.key] - An optional identifier for the menu item.
     * @param {MenuItem[]} [options.items] - An array of MenuItem instances to create a submenu.
     * @param {boolean} [options.separator=false] - Whether this item is a separator.
     * @param {function} [options.click=()=>{}] - A callback function that will be called when the item is clicked.
     * @param {boolean} [options.enabled=true] - Whether the menu item is enabled or disabled.
     */

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

    /**
     * Converts the MenuItem instance into a JSON object that can be used to create a menu
     * @internal
     */
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
    /**
     * Creates a new Separator instance, which is a type of MenuItem that represents a separator in a menu. 
     */
    constructor() {
        super({ separator: true });
    }
}


 class Menu {

    #template = []

    /**
     * Creates a new Menu instance with an optional template. The template is an array of MenuItem instances that define the structure of the menu. If no template is provided, an empty menu will be created.
     * @param {MenuItem[]} template - An array of MenuItem instances that define the structure of the menu.
     */
    constructor(template = []) {
        this.#template = template;
    }

/**
 * Gets the current template of the menu, which is an array of MenuItem instances that define the structure of the menu.
 */
get template() {
  return this.#template;
}

/**
 * Adds an item to the menu.
 * @param {MenuItem} item - The MenuItem instance to add.
 * @returns {Menu} The menu instance for chaining.
 */
addItem(item) {
this.#template.push(item.json());
return this;
}

/**
 * Adds multiple items to the menu.
 * @param {MenuItem[]} items - An array of MenuItem instances to add.
 * @returns {Menu} The menu instance for chaining.
 */
addItems(items) {
items.forEach(item => this.addItem(item));
return this;
}

}

module.exports = {
    Menu,
    MenuItem,
    Separator
}