const WebSocket = require("ws");
const Events = require("events");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { performNativeBuild } = require("./builder");
const logger = require("./logs");
const IpcRouter = require("./ipc");
const { Menu } = require("./menu");
const http = require("http");
const crypto = require("crypto");
const { info, error, warn, success } = require("./logs");

let currMenu = []
let contextMenu = [];

const randomPort = () => {
  const min = 1024;
  const max = 65535;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const PORT = process.env.POSITRON_IPC_PORT || randomPort();
const HOST = "127.0.0.1";

if (!process.env.POSITRON_AUTH_TOKEN) {
    process.env.POSITRON_AUTH_TOKEN = crypto.randomUUID();
}

if(!process.env.POSITRON_IPC_PORT) {
    process.env.POSITRON_IPC_PORT = PORT;
}
const appRoot = process.cwd();
const binaryName = process.platform === "win32" ? "positron-runtime.exe" : "positron-runtime";
const binaryPath = path.join(appRoot, "bin", binaryName);

const appEvents = new Events.EventEmitter();


const isPackaged = process.env.POSITRON_PACKAGED === "true";

const EXPECTED_TOKEN = process.env.POSITRON_AUTH_TOKEN;

const parseRes = (obj) => {
  if (Object.keys(obj) > 1) return obj;

  return Object.values(obj)[0];
}

if (!isPackaged) {
    // DEV MODE
    if (!fs.existsSync(binaryPath)) {
        warn("Native binary missing. Triggering automatic background build...");
        const buildSuccess = performNativeBuild();
        if (!buildSuccess) {
            error("[Positron] Fatal: Could not auto-compile native binary.");
            process.exit(1);
        }
    }

    info("Starting Positron render process...");
    const renderProcess = cp.spawn(binaryPath, {
      env: {
        ...process.env,
        POSITRON_AUTH_TOKEN: EXPECTED_TOKEN
      },
      stdio: process.env.POSITRON_SILENT_NATIVE ? "ignore" : "inherit"
    });

    renderProcess.on("error", (err) => {
        error("Failed to start render process:", err);
        process.exit(1);
    });

    renderProcess.on("close", (code) => {
        info(`[Positron] Render process exited with code ${code}`);
        process.exit(code);
    });
} else {
    // PRODUCTION MODE
    info("[Positron] Packaged mode detected. Skipping native binary spawn.");
}

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/running') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('true');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const _ipcWS = new WebSocket.Server({ server: httpServer });
let activeSocket = null;
const pendingWindows = new Set(); 


const commandQueue = []; 

_ipcWS.on("connection", (ws, req) => {
const clientToken = req.headers["x-positron-auth-token"];

  if (clientToken !== EXPECTED_TOKEN) {
    warn("[Security] Unauthorized local connection attempt rejected. Token:", clientToken, "Expected:", EXPECTED_TOKEN);
    ws.close(4001, "Unauthorized token match failure.");
    return;
  }

  activeSocket = ws;
  success("Client connected to IPC");

  while (commandQueue.length > 0) {
    const payload = commandQueue.shift();
    activeSocket.send(payload);
  }

  pendingWindows.forEach(win => {
    win.emit("ready");
  });
  pendingWindows.clear();

ws.on("message", raw => {
  try {
    const msg = JSON.parse(raw);

   if(process.env.POSITRON_LOG_IPC) console.log("Received IPC message:", msg);

    if (msg.event === "ipcMessage" || msg.event.includes("-reply-") || msg.event.includes("-result-")) {
      
      const simulatedMsg = msg.event === "ipcMessage" ? msg : {
        event: "ipcMessage",
        windowId: msg.windowId,
        data: {
          channel: msg.event,
          payload: msg.data
        }
      };
      
      ipc.dispatch(ws, simulatedMsg);
    } else if (msg.event === "window-close-requested") {
      const win = [...activeWindows].find(w => w.id === msg.windowId);
      if (win) {
        let defaultPrevented = false;
        
        const eventObject = {
          preventDefault: () => { defaultPrevented = true; }
        };

        win.emit("close", eventObject);

        if (!defaultPrevented) {
          win.destroy();
        }
      }
      } else if(msg.event == "menu-action" || msg.event == "context-menu-action") {
       
            const findMenuAction = (items, label, channel) => {
      if (!items || items.length === 0) return null;

      for (const item of items) {
        if (item.label === label || (channel && item.channel === channel)) {
          return item;
        }
        
        if (item.items && item.items.length > 0) {
          const found = findMenuAction(item.items, label, channel);
          if (found) return found; 
        }
      }
      
      return null; 
    }
        
        const menuAction = findMenuAction((msg.event === "menu-action" ? currMenu : contextMenu), msg.data.label, msg.data.channel);
        
        if (menuAction) {
          menuAction.click();
        } else {
          warn("Received menu action for unknown item:", msg.data);
        }
      } else {
      appEvents.emit(msg.event, msg.data);
    }
  } catch (err) {
    error("Failed to process incoming IPC network frame:", err);
  }
});


  ws.on("close", () => { 
    activeSocket = null; 
  });
});

const ipc = new IpcRouter();

let _windowCounter = 0;

class Window extends Events.EventEmitter {

  /** Creates a new window instance. */
  constructor(options = {

    darwinOptions: {
      closable: true,
      resizable: true,
      minimizable: true,
      titlebarTransparent: false,
      titlebarVisible: true
    }

  }) {
    super();
    this.id = ++_windowCounter;
    this.options = options;

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      process.nextTick(() => this.emit("ready"));
    } else {
      pendingWindows.add(this);
    }

    const width = options.width ? String(options.width) : "800";
    const height = options.height ? String(options.height) : "600";

    if(!this.options.skipCreate) {
      this.create(width, height, options.darwinOptions);
    }

  }

  /**
   * Send a fire-and-forget command to the native layer. Commands are simple strings that correspond to actions the native layer can perform.
   * Args can be provided as an array or a single value, and will be normalized to an array of strings before being sent.
   * If the socket connection is not currently open, the command will be queued and sent once the connection is established.
   * @param {string} command 
   * @param {string[]} args 
   */
  sendCommand(command, args = []) {
    const normalizedArgs = Array.isArray(args) ? args.map(String) : [String(args)];
    
    const payload = JSON.stringify({ 
      windowId: this.id, 
      command, 
      args: normalizedArgs 
    });

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(payload);
      this.emit("command-sent", { command, args: normalizedArgs });
    } else {
      if(command != "createWindow") info(`Socket not ready. Outbound command queued: ${command}`);
      commandQueue.push(payload);
    }
  }

  /**
   * Sets the title of the window.
   * @param {string} title The new title for the window.
   */
  setTitle(title) { 
    this.sendCommand("setTitle", [title]); 
    this.emit("title-updated", title); 
  }

  /**
   * Loads a remote URL in the window. Emits "url-loaded" and "navigated" events with the URL as data.
   * @param {string} url The URL to load.
   */
  loadURL(url) { 
    this.sendCommand("loadURL", [url]); 
    this.emit("url-loaded", url); 
    this.emit("navigated", url); 
  }

  /**
   * Triggers the print dialog for the window. Emits a "print" event. Note that the actual print functionality and dialog is handled by the native layer, so behavior may vary across platforms.
   */
  print() {
    this.sendCommand("print");
    this.emit("print");
  }

  /**
   * Sets the user agent string for the window. Emits a "user-agent-updated" event with the new user agent as data.
   * @param {string} userAgent The new user agent string.
   */
  setUserAgent(userAgent) {
    this.sendCommand("setUserAgent", [userAgent]);
    this.emit("user-agent-updated", userAgent);
  }

  /**
   * Loads a local file in the window. Emits "file-loaded" and "navigated" events with the file path as data.
   * @param {string} path The path to the file to load.
   */
  loadFile(path) { 
    this.sendCommand("loadFile", [path]); 
    this.emit("file-loaded", path); 
    this.emit("navigated", path); 
  }

  /**
   * Sends an IPC message to the renderer process.
   * @param {string} channel The IPC channel to send the message on.
   * @param {string[]} args The arguments to send with the message.
   */
sendIpc(channel, args = []) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({
      windowId: this.id,
      command: "emitToRenderer",
      args: [channel, JSON.stringify(args)]
    });
    activeSocket.send(payload);
    this.emit("ipc-sent", { channel, args });
  } else {
    warn(`Cannot send IPC message, socket not ready. Channel: ${channel}`);
  }
}

 #created = false;

 /**
  * Creates the window in the native layer.
  * @param {string} width 
  * @param {string} height 
  * @param {Object} darwinOptions 
  * @returns 
  */
create(width, height, darwinOptions = {
  closable: true,
  resizable: true,
  minimizable: true,
  titlebarTransparent: false,
  titlebarVisible: true
}) {
  if (this.#created) {
    warn(`Window ${this.id} is already created.`);
    return;
  }

    darwinOptions = {
    closable: true,
    resizable: true,
    minimizable: true,
    titlebarTransparent: false,
    titlebarVisible: true,
    ...darwinOptions
  }

  this.#created = true;
  if(!width) width = this.options.width || 800;
  if(!height) height = this.options.height || 600;
      this.sendCommand("createWindow", [width, height, ...Object.values(darwinOptions).map(val => String(val))]);
    this.emit("created");
}

/**
 * Closes the window by triggering the native close sequence. This allows the "close" event to be emitted and gives the app a chance to prevent the close if needed. If you want to force close without emitting "close", use the destroy() method instead.
 */
  close() {
    this.sendCommand("triggerCloseSequence"); 
  }

  /**
   * Immediately destroys the window without emitting "close" or allowing prevention. This should be used with caution, as it can lead to unsaved state or other issues if the app is not prepared for it.
   */
  destroy() {
    this.#created = false;
    activeWindows.delete(this);
    this.sendCommand("forceCloseWindow");
  }


  /**
   * Sets the application menu for this window.
   * @param {Menu} menuTemplate
   */
setMenu(menuTemplate) {
  if(menuTemplate instanceof Menu) {
    menuTemplate = menuTemplate.template;
  } 
  
  currMenu = menuTemplate;

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

  this.sendCommand("setMenu", [JSON.stringify(stripClick(menuTemplate))]);
  this.emit("menu-updated", menuTemplate);
}

/**
 * Clears the application menu for this window.
 */
resetMenu() {
  this.sendCommand("resetMenu");
  currMenu = [];
  this.emit("menu-updated", null);
}

/** 
 * Displays an alert dialog with the given message. Emits an "alert" event with the message as data.
 * @param {string} message The message to display in the alert dialog.
 */
alert(message) {
  this.sendCommand("alert", [message]);
  this.emit("alert", message);
}

/**
 * Adds a user script to the window.
 * @param {string} script The script to add.
 */
addUserScript(script) {
  this.sendCommand("addUserScript", [script]);
  this.emit("user-script-added", { content: script, filePath: null });
}

/**
 * Adds a user script from a file.
 * @param {string} filePath The path to the script file.
 */
addUserScriptFromFile(filePath) {
  fs.readFile(filePath, "utf-8", (err, data) => {
    if (err) {
      error(`Failed to read user script from ${filePath}:`, err);
      return;
    }
    this.addUserScript(data);
    this.emit("user-script-added", { filePath, content: data });
  });
}

/**
 * Resizes the window to the specified dimensions.
 * @param {number} width The new width of the window.
 * @param {number} height The new height of the window.
 */
resize(width, height) {
  this.sendCommand("resizeWindow", [width, height]);
  this.emit("resized", { width, height });
}

/**
 * Opens the developer tools for the window. Emits a "devtools-opened" event when done. Does not work on macOS. For macOS, right-click the window and select "Inspect Element" to open dev tools for that window.
 */
openDevTools() {
  if(process.platform === "darwin") {
    warn("The openDevTools command is not supported on macOS due to OS limitations. Please right-click the window and select 'Inspect Element' to access developer tools.");
    return;
  }
  this.sendCommand("openDevTools");
  this.emit("devtools-opened");
}

/**
 * Toggles fullscreen mode for the window. Emits a "fullscreen-toggled" event when done.
 */
toggleFullscreen() {
  this.sendCommand("toggleFullscreen");
  this.emit("fullscreen-toggled");
}

/**
 * Enters fullscreen mode for the window. Emits a "fullscreen-entered" event when done.
 */
goFullscreen() {
  this.sendCommand("fullscreen");
  this.emit("fullscreen-entered");
}

/**
 * Exits fullscreen mode for the window. Emits a "fullscreen-exited" event when done.
 */
exitFullscreen() {
  this.sendCommand("exitFullscreen");
  this.emit("fullscreen-exited");
}

/**
 * Navigates forward in the window's history. Emits a "navigated-forward" event when done.
 */
goForward() {
  this.sendCommand("forward");
  this.emit("navigated-forward");
}

/**
 * Navigates back in the window's history. Emits a "navigated-back" event when done.
 */
goBack() {
  this.sendCommand("back");
  this.emit("navigated-back");
}

/**
 * Hides the window. Emits a "hidden" event when done.
 */
hide() {
  this.sendCommand("hideWindow");
  this.emit("hidden");
}

/**
 * Shows the window. Emits a "shown" event when done.
 */
show() {
  this.sendCommand("showWindow");
  this.emit("shown");
}

/**
 * Focuses the window. Emits a "focused" event when done.
 */
focus() {
  this.sendCommand("focus");
  this.emit("focused");
}

/**
 * Reloads the window. Emits a "reloaded" event when done.
 */
reload() {
  this.sendCommand("reload");
  this.emit("reloaded");
}

/**
 * Captures a screenshot of the current window. Returns a Promise that resolves to a Buffer containing the image data in PNG format, or null if the capture failed. Emits a "screenshot-captured" event with the image buffer as data when done.
 * @returns {Promise<Buffer|null>} The captured screenshot as a Buffer, or null if the capture failed.
 */
async capturePage() {
 const response = await this.request("capturePage", `capture-page-result-${this.id}`);
 return response.image ? Buffer.from(response.image, "base64") : null;
}

/**
 * Checks if the window can navigate back in its history. Returns a Promise that resolves to true if it can go back, or false if it cannot. Emits a "can-go-back-checked" event with the result as data when done.
 * @returns {Promise<boolean>} True if the window can navigate back, false otherwise.
 */
async canGoBack() {
 const response = await this.request("canGoBack", `canGoBack-reply-${this.id}`);
 return response === "true";
}

/**
 * Sends a request/response command to the native layer. The command will be sent, and the method will wait for a response on the specified reply channel. Once a response is received, the promise will resolve with the reply data.
 * @param {string} command The command to send.
 * @param {string} replyChannel The channel to listen for the reply on.
 * @returns {Promise<*>} A promise that resolves to the reply data.
 */
async request(command, replyChannel, ...args) {
  return new Promise((resolve) => {
    const unsubscribe = ipc.handle(replyChannel, (data) => {
      unsubscribe();
      resolve(data);
    });

    this.sendCommand(command, ...args);
  });
}

/**
 * Checks if the window can navigate forward in its history. Returns a Promise that resolves to true if it can go forward, or false if it cannot. Emits a "can-go-forward-checked" event with the result as data when done.
 * @returns {Promise<boolean>} True if the window can navigate forward, false otherwise.
 */
async canGoForward() {
  const response = await this.request("canGoForward", `canGoForward-reply-${this.id}`);
  return response === "true";
}

/**
 * Shows a notification. Emits a "notification-shown" event when done.
 * @param {string} title The title of the notification.
 * @param {string} body The body of the notification.
 * @param {Object} options The options for the notification.
 */
showNotification(title, body, options = {}) {
  if(!isPackaged) {
    warn("Notifications do not work in development mode due to limitations of the OS notification APIs. This command will be a no-op until the app is packaged.");
    return;
  }
  this.sendCommand("showNotification", [title, body, JSON.stringify(options)]);
  this.emit("notification-shown", { title, body, options });
}

/**
 * Sets whether the window is closeable. Emits a "closeable-updated" event with the new value when done.
 * @param {boolean} isClosable Whether the window is closeable.
 */
setCloseable(isClosable) {
  this.sendCommand("setCloseable", [String(isClosable)]);
  this.emit("closeable-updated", isClosable);
}

/** 
 * Sets whether the window is resizable. Emits a "resizable-updated" event with the new value when done.
 * @param {boolean} isResizable Whether the window is resizable.
 */
setResizable(isResizable) {
  this.sendCommand("setResizable", [String(isResizable)]);
  this.emit("resizable-updated", isResizable);
}

/** 
 * Sets whether the window is minimizable. Emits a "minimizable-updated" event with the new value when done.
 * @param {boolean} isMinimizable Whether the window is minimizable.
 */
setMinimizable(isMinimizable) {
  this.sendCommand("setMinimizable", [String(isMinimizable)]);
  this.emit("minimizable-updated", isMinimizable);
}

/** 
 * Sets the bounds of the window. Emits a "bounds-updated" event with the new bounds when done.
 * @param {number} x The x-coordinate of the window's position.
 * @param {number} y The y-coordinate of the window's position.
 * @param {number} width The width of the window.
 * @param {number} height The height of the window.
 */
setBounds(x, y, width, height) {
  this.sendCommand("setBounds", [x, y, width, height]);
  this.emit("bounds-updated", { x, y, width, height });
}

/**
 * Displays a prompt dialog with the given message and default value. Returns a Promise that resolves to the user's input as a string, or null if the user cancelled the prompt. Emits a "prompt" event with the message and default value as data when done.
 * @param {string} message The message to display in the prompt dialog.
 * @param {string} defaultValue The default value to display in the prompt input field.
 * @returns {Promise<string|null>} The user's input as a string, or null if the user cancelled the prompt.
 */
async prompt(message, defaultValue = "") {
  const res = await this.request("prompt", `prompt-reply-${this.id}`, message, defaultValue);
  this.emit("prompt", { message, defaultValue });
  return res?.input;
}

/**
 * Sets the context menu for the window. The menuTemplate should be an array of menu item objects, where each object can have a label, an optional click handler, and an optional submenu (which is itself an array of menu item objects). Emits a "context-menu-updated" event with the new menu template when done.
 * @param {Menu} menuTemplate 
 */
setContextMenu(menuTemplate) {

  if(menuTemplate instanceof Menu) {
    menuTemplate = menuTemplate.template;
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

  contextMenu = menuTemplate;

  this.sendCommand("setContextMenu", [JSON.stringify(stripClick(menuTemplate))]);
  this.emit("context-menu-updated", menuTemplate);
}

/**
 * Gets the current bounds of the window. Returns a Promise that resolves to an object containing the x and y coordinates of the window's position, as well as its width and height. Emits a "bounds-retrieved" event with the bounds data when done.
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} An object containing the window's bounds.
 */
async getBounds() {
  return await this.request("getBounds", `getBounds-reply-${this.id}`);
}

/**
 * Gets the current URL loaded in the window. Returns a Promise that resolves to the URL as a string. Emits a "url-retrieved" event with the URL data when done.
 * @returns {Promise<string>} The current URL loaded in the window.
 */
async getURL() {
  return await this.request("getURL", `getURL-reply-${this.id}`);
}

/**
 * Gets the current title of the window. Returns a Promise that resolves to the title as a string. Emits a "title-retrieved" event with the title data when done.
 * @returns {Promise<string>} The current title of the window.
 */
async getTitle() {
  return await this.request("getTitle", `getTitle-reply-${this.id}`);
}

/**
 * Sets whether the window's titlebar is visible. Emits a "titlebar-visibility-updated" event with the new value when done.
 * @param {boolean} isVisible Whether the titlebar is visible.
 */
setTitlebarVisible(isVisible) {
  this.sendCommand("setTitlebarVisible", [String(isVisible)]);
  this.emit("titlebar-visibility-updated", isVisible);
}

/**
 * Sets whether the window's titlebar is transparent. Emits a "titlebar-transparency-updated" event with the new value when done.
 * @param {boolean} isTransparent Whether the titlebar is transparent.
 */
setTitlebarTransparent(isTransparent) {
  this.sendCommand("setTitlebarTransparent", [String(isTransparent)]);
  this.emit("titlebar-transparency-updated", isTransparent);
}

/**
 * Evaluates JavaScript code in the context of the window. Returns a Promise that resolves to the result of the evaluation. Emits a "js-evaluated" event with the result data when done.
 * @param {string} script The JavaScript code to evaluate.
 * @returns {Promise<*>} A Promise that resolves to the result of the evaluation.
 */
async evaluateJavaScript(script) {
const res = await this.request("evaluateJS", `evaluateJS-reply-${this.id}`, script);
return res;
}

}

const app = {

  /**
   * Quits the application by sending a terminate command to the native layer and then exiting the process. Emits a "before-quit" event before sending the command, and a "quit" event after initiating the quit sequence.
   * @param {number} exitCode The exit code for the process.
   */
  quit(exitCode = 0) {
    this.events.emit("before-quit");
 const payload = JSON.stringify({ 
      windowId: 1, 
      command: "terminate",
      args: []
    });

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(payload);
    }

    setTimeout(() => {
      process.exit(exitCode);
    }, 20);

    appEvents.emit("quit");
  },

  /**
   * Adds an event listener for application-level events. Supported events include "before-quit" and "quit".
   * @param {string} event The name of the event to listen for.
   * @param {Function} listener The callback function to invoke when the event is emitted.
   */
  on(event, listener) {
    this.events.on(event, listener);
  },
  
  /**
   * Removes an event listener for application-level events.
   * @param {string} event The name of the event to remove the listener from.
   * @param {Function} listener The callback function to remove.
   */
  off(event, listener) {
    this.events.off(event, listener);
  },

  /**
   * Adds a one-time event listener for application-level events. The listener will be invoked at most once for the specified event, and then automatically removed.
   * @param {string} event The name of the event to listen for.
   * @param {Function} listener The callback function to invoke when the event is emitted.
   */
  once(event, listener) {
    this.events.once(event, listener);
  },

  /**
   * Full access to the underlying event emitter for application-level events, allowing for advanced event handling patterns if needed.
   */
  events: appEvents
  
}

module.exports = { Window, ipc, isPackaged, app, PORT, };

httpServer.listen(PORT, HOST, () => {
info("IPC server running on " + HOST + ":" + PORT);
});