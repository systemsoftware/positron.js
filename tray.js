const { app } = require("./index");
const { Menu } = require("./menu");

let createdTray = false;
 
module.exports = {

create(menu, title = "", icon = "") {

    if(createdTray) {
        console.warn("Tray already created. Use setMenu, setTitle, or setIcon to update the existing tray.");
        return;
    }
    
    createdTray = true;
   
    if(menu instanceof Menu) {
        menu = menu.template
    }

      const stripClick = (items) => {
    if (!items) return null;
    return items.map(i => {
      const newItem = { ...i, click: undefined };
      if (newItem.items) {
        newItem.items = stripClick(newItem.items);
      }
      return newItem;
    });
  };

    app.setTrayMenu(menu);
    app.sendToNative("createTray", [JSON.stringify(stripClick(menu)), title, icon]);
  },

  setMenu(menu) {
    if(menu instanceof Menu) {
        menu = menu.template
    }

      const stripClick = (items) => {
    if (!items) return null;
    return items.map(i => {
      const newItem = { ...i, click: undefined };
      if (newItem.items) {
        newItem.items = stripClick(newItem.items);
      }
      return newItem;
    });
  };

    app.setTrayMenu(menu);
    app.sendToNative("createTray", [JSON.stringify(stripClick(menu)), "setMenu"]);
  },

  setTitle(title) {
    app.sendToNative("createTray", [title, "setTitle"]);
  },

  setIcon(iconPath) {
    app.sendToNative("createTray", [iconPath, "setIcon"]);
  }

}