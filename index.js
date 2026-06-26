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
let trayMenu = [];

const randomPort = () => {
  const min = 1024;
  const max = 65535;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let PORT = process.env.POSITRON_IPC_PORT || randomPort();
const HOST = process.env.POSITRON_IPC_HOST || "127.0.0.1";

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

if(isPackaged) {
if (typeof process.pkg !== 'undefined') {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    __dirname = path.join(path.dirname(process.execPath), '.');
  } else {
    __dirname = path.dirname(process.execPath);
  }
}
}

const EXPECTED_TOKEN = process.env.POSITRON_AUTH_TOKEN;


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

 //   setTimeout(() => { // FOR HIJACK TESTING

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

    process.on("exit", () => {
  if (renderProcess) {
    renderProcess.kill();
  }
});

process.on("SIGINT", () => {
  process.exit();
});

process.on("uncaughtException", (err) => {
  error("Uncaught exception:", err, '\n', err.stack.split('\n').slice(1).join('\n'));
  process.exit(1);
});

    renderProcess.on("close", (code) => {
        info(`[Positron] Render process exited with code ${code}`);
        if (!process.env.POSITRON_TEST_NO_EXIT) {
            process.exit(code);
        }
    });
 //   }, 60000);
} else {
    // PRODUCTION MODE
    info("[Positron] Packaged mode detected. Skipping native binary spawn.");
}

const httpServer = http.createServer()

const MAX_CONNECTIONS = 1;

const _ipcWS = new WebSocket.Server({ server: httpServer, verifyClient: (info, cb) => {

  const clientToken = info.req.headers["x-positron-auth-token"];
  if (clientToken !== EXPECTED_TOKEN) {
    warn("[Security] Unauthorized local connection attempt rejected.");
    cb(false, 401, "Unauthorized token match failure.");
    return
  } 

  if (_ipcWS.clients.size >= MAX_CONNECTIONS) {
      return cb(false, 503, 'IPC client already connected. Only one client allowed at a time.');
    }
  
  cb(true);
}

});
let activeSocket = null;
const pendingWindows = new Set(); 


const commandQueue = []; 

let activeWindows = new Set();

_ipcWS.on("connection", (ws, req) => {
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
  appEvents.emit("ready");

ws.on("message", raw => {
  try {
    const msg = JSON.parse(raw);

   if(process.env.POSITRON_LOG_IPC) console.log("Received IPC message:", msg);

    if (msg.event === "ipcMessage" || msg.event.includes("-reply-") || msg.event.includes("-result-") || msg.event === "nativeError") {
      
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
      } else if(msg.event == "menu-action" || msg.event == "context-menu-action" || msg.event == "tray-menu-action") {
       
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
        
        let searchMenu = msg.event === "menu-action" ? currMenu : (msg.event === "context-menu-action" ? contextMenu : trayMenu);
        let menuAction = findMenuAction(searchMenu, msg.data.label, msg.data.channel);
        
        if (!menuAction && msg.event === "context-menu-action") {
          menuAction = findMenuAction(trayMenu, msg.data.label, msg.data.channel);
        }
        
        if (menuAction) {
          menuAction.click();
        } else {
          warn("Received menu action for unknown item:", msg.data);
        }
      } else {
      appEvents.emit(msg.event, msg.data);
    }
  } catch (err) {
    error("Failed to process incoming IPC network frame:", err, err.stack.split('\n').slice(1).join('\n'));
  }
});


  ws.on("close", () => { 
    activeSocket = null; 
    
    for (const win of activeWindows) {
      win.emit("close");
      win.isDestroyed = true;
    }
    activeWindows.clear();
    pendingWindows.clear();
    commandQueue.length = 0;
  });
});

const ipc = new IpcRouter();

let _windowCounter = 0;

class Window extends Events.EventEmitter {

  id = 0;

  /** Creates a new window instance. */
  constructor(options = {

    darwinOptions: {
      closable: true,
      resizable: true,
      minimizable: true,
      titlebarTransparent: false,
      titlebarVisible: true
    },
    linuxOptions: {
      closable: true,
      resizable: true,
      minimizable: true,
      titlebarTransparent: false,
      titlebarVisible: true
    },
    allowEvaluateJS: false,
    skipCreate: false,
    preload: ""
  }) {
    super();
    this.id = ++_windowCounter;
    this.options = { allowEvaluateJS: false, ...options };
    activeWindows.add(this);

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      process.nextTick(() => this.emit("ready"));
    } else {
      pendingWindows.add(this);
    }

    const width = options.width ? String(options.width) : "800";
    const height = options.height ? String(options.height) : "600";

    if(!this.options.skipCreate) {
      if (process.platform === "linux") {
        this.create(width, height, options.linuxOptions || options.darwinOptions, options.preload);
      } else {
        this.create(width, height, options.darwinOptions, options.preload);
      }
    }

  }

  /**
   * Send a fire-and-forget command to the native layer. Commands are simple strings that correspond to actions the native layer can perform.
   * Args can be provided as an array or a single value, and will be normalized to an array of strings before being sent.
   * If the socket connection is not currently open, the command will be queued and sent once the connection is established.
   * @param {string} command 
   * @param {string[]} args 
   */
  sendCommand(command, ...args) {
    if(args[0] instanceof Array) args = args[0].concat(args.slice(1));
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
   * Loads a file into the window. The path can be an absolute file path or a relative path from the application's root directory. Emits a "file-loaded" event with the path as data, and a "navigated" event with the path as data.
   * @param {string} path The path to the file to load.
   */
  async loadFile(path) {
    const res = await this.request("loadFile", { replyChannel: `loadFile-reply-${this.id}` }, path);
    this.emit("file-loaded", path);
    this.emit("navigated", path);
    return res;
  }

  /**
   * Loads a URL into the window. Emits a "url-loaded" event with the URL as data, and a "navigated" event with the URL as data.
   * @param {string} url The URL to load.
   */
  async loadURL(url) {
    const res = await this.request("loadURL", { replyChannel: `loadURL-reply-${this.id}` }, url);
    this.emit("url-loaded", url);
    this.emit("navigated", url);
    return res;
  }

  /**
   * Sends an IPC message to the renderer process.
   * @param {string} channel The IPC channel to send the message on.
   * @param {string[]} args The arguments to send with the message.
   */
emitToRenderer(channel, args = []) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({
      windowId: this.id,
      command: "emitToRenderer",
      args: [channel, JSON.stringify(args)]
    });
    activeSocket.send(payload);
    this.emit("ipc-sent", { channel, args });
  } else {
    warn(`Cannot send IPC message on ${channel}, socket not ready.`);
  }
}


/**
 * @deprecated Use emitToRenderer instead.
 */
sendIpc = (channel, args = []) => {
  warn("sendIpc is deprecated. Use emitToRenderer instead.");
  this.emitToRenderer(channel, args);
}

 #created = false;

 /**
  * Creates the window in the native layer.
  * @param {string} width 
  * @param {string} height 
  * @param {Object} darwinOptions 
  * @param {string?} preloadFile
  * @returns 
  */
create(width, height, darwinOptions = {}, preloadFile = null) {
  if (this.#created) {
    warn(`Window ${this.id} is already created.`);
    return;
  }

  const defaultOptions = {
    closable: true,
    resizable: true,
    minimizable: true,
    titlebarTransparent: false,
    titlebarVisible: true,
    titleBarStyle: "default"
  };

  const resolvedOptions = { ...defaultOptions, ...darwinOptions };

  this.#created = true;
  if(!width) width = this.options.width || 800;
  if(!height) height = this.options.height || 600;

  const args = [
    width,
    height,
    String(resolvedOptions.closable),
    String(resolvedOptions.resizable),
    String(resolvedOptions.minimizable),
    String(resolvedOptions.titlebarTransparent),
    String(resolvedOptions.titlebarVisible),
    preloadFile || "",
    String(resolvedOptions.titleBarStyle)
  ];

  this.sendCommand("createWindow", args);
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

  isClosed() {
    return !activeWindows.has(this);
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
   if (!this.options.allowEvaluateJS) {
    throw new Error("addUserScript is disabled by default for security. Set allowEvaluateJS: true in window options to enable it.");
  }
  this.sendCommand("addUserScript", [script]);
  this.emit("user-script-added", { content: script, filePath: null });
}

/**
 * Adds a user script from a file.
 * @param {string} filePath The path to the script file.
 */
addUserScriptFromFile(filePath) {
  if (!this.options.allowEvaluateJS) {
    throw new Error("addUserScriptFromFile is disabled by default for security. Set allowEvaluateJS: true in window options to enable it.");
  }
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
 * Checks if the window is currently visible. Returns a Promise that resolves to true if the window is visible, or false if it is hidden. Emits an "is-visible-checked" event with the result as data when done.
 * @returns {Promise<boolean>} True if the window is visible, false otherwise.
 */
async isVisible() {
  const res = await this.request("isVisible");
  return res?.isVisible === "true";
}

/**
 * Checks if the window is currently in fullscreen mode.
 * @returns {Promise<boolean>} True if the window is fullscreen, false otherwise.
 */
async isFullscreen() {
  const res = await this.request("isFullscreen");
  return res?.isFullscreen === "true";
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
 const response = await this.request("capturePage", { replyChannel: `capture-page-result-${this.id}` });
 return response.image ? Buffer.from(response.image, "base64") : null;
}

/**
 * Checks if the window can navigate back in its history. Returns a Promise that resolves to true if it can go back, or false if it cannot. Emits a "can-go-back-checked" event with the result as data when done.
 * @returns {Promise<boolean>} True if the window can navigate back, false otherwise.
 */
async canGoBack() {
 const response = await this.request("canGoBack");
 return response === "true";
}

// @ts-check

/**
 * @typedef {Object} RequestOptions
 * @property {number} [timeout]
 * @property {boolean} [noTimeout]
 * @property {string} [replyChannel]
 */

/**
 * @overload
 * @param {string} command
 * @param {...any} args
 * @returns {Promise<any>}
 */

/**
 * @overload
 * @param {string} command
 * @param {RequestOptions} options
 * @param {...any} args
 * @returns {Promise<any>}
 */

/**
 * Send an IPC request.
 * @param {string} command
 * @param {...any} args
 */
async request(command, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;

    let options = {};

    if(typeof args[0] === "object" && args[0].constructor === Object) {
      options = args[0];
      args = args.slice(1);
    }

    if(!command) {
      reject(new Error("Command is required for request"));
      return;
    }

    const reqId = crypto.randomUUID();

    let replyChannel = `${command}-reply-${reqId}`;

  if (options.replyChannel) {
  replyChannel = options.replyChannel;
} else if(args[0] && (args[0].includes("-reply-") || args[0].includes("-result-"))) {
  // TEMP TRANSITIONAL LOGIC TO SUPPORT LEGACY REQUESTS THAT PASS REPLY CHANNEL AS FIRST ARGUMENT. WILL BE REMOVED IN A FUTURE RELEASE.
  replyChannel = args[0];
}

    const unsubscribe = ipc.handle(replyChannel, (data) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        unsubscribe();

        for (const key in data) {
          if (data[key] === "true") {
            data[key] = true;
          } else if (data[key] === "false") {
            data[key] = false;
          } else if (!isNaN(data[key])) {
            data[key] = Number(data[key]);
          }
        } 

        resolve(data);
      }
    });

        let timeout;


    if(!options.noTimeout) {
      let timeoutDuration = 7000;
  

if (options.timeout) {
  timeoutDuration = options.timeout;
}
      
    timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsubscribe();
    //    reject(new Error(`Request timed out waiting for reply on channel "${replyChannel}"`));
    resolve({ error: `Request timed out waiting for reply on channel "${replyChannel}"` });
      }
    }, timeoutDuration);
  } else {
    args = args.filter(arg => arg !== "NO_TIMEOUT");
  }

    this.sendCommand(command, [...args, replyChannel]);
  });
}

/**
 * Checks if the window can navigate forward in its history. Returns a Promise that resolves to true if it can go forward, or false if it cannot. Emits a "can-go-forward-checked" event with the result as data when done.
 * @returns {Promise<boolean>} True if the window can navigate forward, false otherwise.
 */
async canGoForward() {
  const response = await this.request("canGoForward");
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
  const res = await this.request("prompt", message, defaultValue);
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
 * Checks if the window is currently focused.
 * @returns {Promise<boolean>} True if the window is focused, false otherwise.
 */
async isFocused() {
  const res = await this.request("isFocused");
  return res?.isFocused === "true";
}

/**
 * Gets the current bounds of the window. Returns a Promise that resolves to an object containing the x and y coordinates of the window's position, as well as its width and height. Emits a "bounds-retrieved" event with the bounds data when done.
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} An object containing the window's bounds.
 */
async getBounds() {
  return await this.request("getBounds");
}

/**
 * Gets the current URL loaded in the window. Returns a Promise that resolves to the URL as a string. Emits a "url-retrieved" event with the URL data when done.
 * @returns {Promise<string>} The current URL loaded in the window.
 */
async getURL() {
  return (await this.request("getURL"))?.url || "";
}

/**
 * Gets the current title of the window. Returns a Promise that resolves to the title as a string. Emits a "title-retrieved" event with the title data when done.
 * @returns {Promise<string>} The current title of the window.
 */
async getTitle() {
  return (await this.request("getTitle"))?.title || "";
}

/**
 * Sets the title bar style of the window.
 * @param {"default" | "hidden" | "hiddenInset" | "customButtons"} style 
 */
setTitleBarStyle(style) {
  this.sendCommand("setTitleBarStyle", [style]);
  this.emit("title-bar-style-updated", style);
}

/**
 * Sets the position of the traffic light buttons (macOS only).
 * @param {number} x 
 * @param {number} y 
 */
setTrafficLightPosition(x, y) {
  this.sendCommand("setTrafficLightPosition", [String(x), String(y)]);
  this.emit("traffic-light-position-updated", { x, y });
}

/**
 * Sets the visibility of the traffic light buttons (macOS only).
 * @param {boolean} visible 
 */
setTrafficLightVisible(visible) {
  this.sendCommand("setTrafficLightVisible", [String(visible)]);
  this.emit("traffic-light-visibility-updated", visible);
}

/**
 * Evaluates JavaScript code in the context of the window. Returns a Promise that resolves to the result of the evaluation. Emits a "js-evaluated" event with the result data when done.
 * @param {string} script The JavaScript code to evaluate.
 * @returns {Promise<*>} A Promise that resolves to the result of the evaluation.
 */
async evaluateJavaScript(script) {
  if (!this.options.allowEvaluateJS) {
    throw new Error("evaluateJavaScript is disabled by default for security. Set allowEvaluateJS: true in window options to enable it.");
  }
  return await this.#evaluateJavaScriptInternal(script);
}


async #evaluateJavaScriptInternal(script) {
  const res = await this.request("evaluateJS", script);
  return res.result;
}

/**
 * Gets the user agent string of the window. Returns a Promise that resolves to the user agent as a string.
 * @returns {Promise<string>} The user agent string of the window.
 */
async getUserAgent() {
  return await this.#evaluateJavaScriptInternal("navigator.userAgent");
}

/**
 * Sets the style of elements matching a CSS selector. Returns a Promise that resolves when the style has been applied.
 * @param {string} selector The CSS selector for the elements to style.
 * @param {Object} style The style properties to apply.
 * @returns {Promise<void>} A Promise that resolves when the style has been applied.
 */
async setStyleOf(selector, style) {
  const styleString = Object.entries(style).map(([key, value]) => `${key}: ${value};`).join(" ");
  const script = `
  (function() { 
    const elements = document.querySelectorAll(${JSON.stringify(selector)});
    elements.forEach(el => {
      Object.entries(${JSON.stringify(style)}).forEach(([key, value]) => {
        el.style[key] = value;
      });
    });
  })();
  `;
  await this.#evaluateJavaScriptInternal(script);
  this.emit("style-updated", { selector, style });
}

/**
 * Sets an attribute of elements matching a CSS selector. Returns a Promise that resolves when the attribute has been set.
 * @param {string} selector The CSS selector for the elements to update.
 * @param {string} attribute The name of the attribute to set.
 * @param {string} value The value to set for the attribute.
 * @returns {Promise<void>} A Promise that resolves when the attribute has been set.
 */
async setAttributeOf(selector, attribute, value) {
  const script = `
  (function() {
    const elements = document.querySelectorAll(${JSON.stringify(selector)});
    elements.forEach(el => {
      el.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value)});
    });
  })();
  `;
  await this.#evaluateJavaScriptInternal(script);
  this.emit("attribute-updated", { selector, attribute, value });
}

/**
 * Removes an attribute from elements matching a CSS selector. Returns a Promise that resolves when the attribute has been removed.
 * @param {string} selector The CSS selector for the elements to update.
 * @param {string} attribute The name of the attribute to remove.
 * @returns {Promise<void>} A Promise that resolves when the attribute has been removed.
 */
async removeAttributeOf(selector, attribute) {
  const script = `
    (function() {
      const elements = document.querySelectorAll(${JSON.stringify(selector)});
      elements.forEach(el => {
        el.removeAttribute(${JSON.stringify(attribute)});
      });
    })();
  `;
  await this.#evaluateJavaScriptInternal(script);
  this.emit("attribute-removed", { selector, attribute });
}

/**
 * Removes specific style properties from elements matching a CSS selector. Returns a Promise that resolves when the styles have been removed.
 * @param {string} selector The CSS selector for the elements to update.
 * @param {string[]} styleProperties The style properties to remove.
 * @returns {Promise<void>} A Promise that resolves when the styles have been removed.
 */
async removeStyleOf(selector, styleProperties) {
  const propertiesString = styleProperties.map(prop => `${prop}:`).join("|");
  const script = `
    (function() {
      const elements = document.querySelectorAll(${JSON.stringify(selector)});
      elements.forEach(el => {
        el.style.cssText = el.style.cssText.split(";").filter(rule => {
          return !${JSON.stringify(propertiesString)}.includes(rule.trim().split(":")[0] + ":");
        }).join(";");
      });
    })();
  `;
  await this.#evaluateJavaScriptInternal(script);
  this.emit("style-removed", { selector, styleProperties });
}

/**
 * Adds or replaces click handlers that emit IPC events.
 *
 * @param {string} selector - The CSS selector for the elements to attach the click handlers to.
 * @param {string} channel - The IPC channel to emit events on when the elements are clicked.
 * @param {{ replace?: boolean }} [options] - Optional settings for the click handlers. If `replace` is true, any existing IPC click handlers on the elements will be removed before adding the new handler. If false or omitted, the new handler will be added alongside existing handlers without removing them.
 * @returns {Promise<void>} A Promise that resolves when the click handlers have been added.
 */
async onClick(selector, channel, { replace = true } = {}) {
  const script = `
  (function() {
      const selector = ${JSON.stringify(selector)};
      const channel = ${JSON.stringify(channel)};
      const replace = ${replace};

      const elements = document.querySelectorAll(selector);

      elements.forEach(el => {
        if (replace) {
          el.onclick = () => {
            window.ipc.send(channel, { selector });
          }
        } else {
        el.addEventListener("click", () => {
          window.ipc.send(channel, { selector });
        });  
        }
            })
  })();
  `;

  await this.#evaluateJavaScriptInternal(script);
}

/**
 * Removes click handlers that emit IPC events from elements matching the specified CSS selector. This will remove all click handlers that were added via the onClick method for the given selector, regardless of the channel or whether they were set to replace existing handlers.
 * @param {string} selector The CSS selector for the elements to remove click handlers from.
 * @returns {Promise<void>} A Promise that resolves when the click handlers have been removed.
 */
async removeOnClick(selector) {
  const script = `
    const elements = document.querySelectorAll(${JSON.stringify(selector)});
    elements.forEach(el => {
      el.onclick = null;
    });
  `;
  await this.#evaluateJavaScriptInternal(script);
}

/**
 * Displays a confirmation dialog with the given message. Returns a Promise that resolves to true if the user confirmed, or false if the user cancelled. Emits a "confirm" event with the message as data when done.
 * @param {string} message The message to display in the confirmation dialog.
 * @returns {Promise<boolean>} True if the user confirmed, false if the user cancelled.
 */
async confirm(message) {
  const res = await this.request("confirm", message);
  this.emit("confirm", res?.confirmed);
  return res?.confirmed == true || res?.confirmed === "true";
}

/**
 * Enables or disables swipe navigation for the window. When enabled, users can navigate back and forward through their history by swiping left or right on a trackpad or touchscreen. Emits a "swipe-navigation-updated" event with the new value when done.
 * @param {boolean} enabled Whether swipe navigation should be enabled.
 * @returns {Promise<void>} A Promise that resolves when the swipe navigation setting has been updated.
 */
async setSwipeNavigation(enabled) {
const res = await this.request("setSwipeNav", String(enabled));
this.emit("swipe-navigation-updated", enabled);
}

/**
 * Checks if swipe navigation is enabled for the window. Returns a Promise that resolves to true if swipe navigation is enabled, or false if it is disabled. Emits an "is-swipe-navigation-enabled-checked" event with the result as data when done.
 * @returns {Promise<boolean>} True if swipe navigation is enabled, false otherwise.
 */
async isSwipeNavigationEnabled() {
  const res = await this.request("isSwipeNavEnabled");
  return res?.enabled === "true";
}

/**
 * Adds content blocker rules to the window. The rules can be provided as a JSON object, loaded from a URL that returns JSON, or loaded from a local file. 
 * Once the rules are added, the window will block content according to the specified rules. Emits a "content-blocker-updated" event with the new rules as data when done.
 * @param {Object} config The configuration for adding content blocker rules.
 * @param {Object[]} [config.json] An array of content blocker rules as JSON objects. Each rule should follow the format specified by the native layer's content blocking implementation.
 * @param {string} [config.url] A URL that returns a JSON array of content blocker rules. If provided, the rules will be loaded from this URL instead of using the `json` property.
 * @param {string} [config.file] A local file path containing the content blocker rules in JSON format. If provided, the rules will be loaded from this file instead of using the `json` or `url` properties.
 * @param {boolean} [config.reload] Whether to reload the window after adding the content blocker rules. Reloading may be necessary for the new rules to take effect immediately, but it can also be set to false if you want to add rules without interrupting the user's current session.
 * @param {boolean} [config.clearExisting] Whether to clear existing content blocker rules before adding the new ones. If false, the new rules will be added alongside any existing rules. If true, all existing rules will be removed before adding the new ones.
 * @platform macOS only
 * @see https://webkit.org/blog/3476/content-blockers-first-look/
 */
async addToContentBlocker(config={ json:[], url:"", file:"", reload:true, clearExisting: false }) {

  if(process.platform !== "darwin") return;

  let json = config.json || [];

  if(config.file) {
    json = config.file
  } else {
  if(config.url) {
    let req = (await fetch(config.url));
    let _json = await req.json();

    if(json.length) {
      json = json.concat(_json);
    } else {
      json = _json;
    }
  }

  json = JSON.stringify(json);
}


  const res = await this.request("addToContentBlocker", json, config.reload, config.clearExisting);
  this.emit("content-blocker-updated", json);
}

/**
 * Displays a file open dialog and returns a Promise that resolves with the selected file path(s), or an empty string/array if the user cancelled.
 * @param {Object} options The options for the file open dialog.
 * @param {string} [options.title] The title of the dialog.
 * @param {Array<{name: string, extensions: string[]}>} [options.filters] File type filters (e.g. [{name: "Images", extensions: ["png","jpg"]}, {name: "All Files", extensions: ["*"]}]).
 * @param {boolean} [options.multiSelect=false] Whether to allow multiple file selection.
 * @param {boolean} [options.canChooseDirectories=false] Whether to allow directory selection instead of files.
 * @param {string} [options.defaultPath] The default directory to open the dialog in.
 * @returns {Promise<Object>} A promise that resolves to {filePath: string} or {files: string} when multiSelect is true.
 */
async showFileOpenDialog(options = {}) {
  this.emit("show-file-open-dialog", options);
  return this.request("showFileOpenDialog", { noTimeout: true }, JSON.stringify(options));
}

/**
 * Displays a save file dialog and returns a Promise that resolves to the selected file path, or an empty string if the user cancelled.
 * @param {Object} options The options for the save dialog.
 * @param {string} [options.title] The title of the dialog.
 * @param {Array<{name: string, extensions: string[]}>} [options.filters] File type filters.
 * @param {string} [options.defaultPath] The default path (directory and/or filename) for the dialog.
 * @returns {Promise<Object>} A promise that resolves to {filePath: string}.
 */
async showSaveDialog(options = {}) {
  this.emit("show-save-dialog", options);
  return this.request("showSaveDialog", { noTimeout: true }, JSON.stringify(options));
}

/**
 * Displays a native dropdown/select modal dialog and returns a Promise that resolves to the selected item.
 * @param {Object} options The options for the select dialog.
 * @param {string} [options.title="Select"] The title/label for the dialog.
 * @param {string[]} options.items The list of items to display in the dropdown.
 * @param {number} [options.defaultIndex=0] The index of the pre-selected item.
 * @returns {Promise<Object>} A promise that resolves to {selected: string, index: number}, or {selected: "", index: -1} if cancelled.
 */
async select(options = {}) {
  this.emit("show-select-menu", options);
  return this.request("showSelectMenu", JSON.stringify(options));
}


  async findInPage(text, options = { caseSensitive: false, scrollIntoView: true }) {
    const js = `
      (() => {
  const walker = document.createTreeWalker(
    document.body, 
    NodeFilter.SHOW_TEXT, 
    null
  );

  const searchTerm = ${JSON.stringify(text)};
  const scrollIntoView = ${options.scrollIntoView};
  const caseSensitive = ${options.caseSensitive};

  const matches = [];
  let node;

  while (node = walker.nextNode()) {
    if (caseSensitive) {
      if (node.nodeValue.includes(searchTerm)) {
        matches.push(node);
      }
    } else {
      if (node.nodeValue.toLowerCase().includes(searchTerm.toLowerCase())) {
        matches.push(node);
      }
    }
  }

  matches.forEach(textNode => {
    const parent = textNode.parentNode;
    
    const index = caseSensitive
  ? textNode.nodeValue.indexOf(searchTerm)
  : textNode.nodeValue.toLowerCase().indexOf(searchTerm.toLowerCase());

if (index === -1) return;
    
    const matchNode = textNode.splitText(index);
    matchNode.splitText(searchTerm.length);
    
    const mark = document.createElement('mark');
    mark.className = 'find-in-page-highlight';
    
    parent.insertBefore(mark, matchNode);
    mark.appendChild(matchNode);
    
    if (scrollIntoView) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
})();
    `;
    const res = await this.#evaluateJavaScriptInternal(js);
    this.emit("find-in-page", { text, result: res });
    return res;
  }

  /**
   * Removes highlights added by the findInPage method. Returns a Promise that resolves when the highlights have been removed. Emits a "stop-find-in-page" event when done.
   */
async stopFindInPage() {
  const js = `
    (() => {
      const highlights = document.querySelectorAll('.find-in-page-highlight');
      highlights.forEach(mark => {
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      });
    })();
  `;
  await this.#evaluateJavaScriptInternal(js);
  this.emit("stop-find-in-page");
}

/**
 * Sets the opacity of the window's background.
 * @param {number} value The opacity value for the background (0.0 to 1.0)
 */
setBackgroundOpacity(value) {
  this.sendCommand("setBackgroundTransparency", [String(value)]);
  this.emit("background-transparency-updated", value);
}

/**
 * Sets the opacity of the window.
 * @param {number} value The opacity value (0.0 to 1.0)
 */
setOpacity(value) {
  this.sendCommand("setOpacity", [String(value)]);
  this.emit("opacity-updated", value);
}

/**
 * Gets the full HTML content of the window's web page. Returns a Promise that resolves to the HTML content as a string.
 * @returns {Promise<string>} The full HTML content of the window's web page.
 */
async getWebContent() {
  const res = await this.#evaluateJavaScriptInternal("document.documentElement.outerHTML.toString()");
  return res;
}

/**
 * Sets whether the window should always stay on top of other windows. Emits an "always-on-top-updated" event with the new value when done.
 * @param {boolean} value Whether the window should always stay on top of other windows.
 */
async setAlwaysOnTop(value) {
  this.sendCommand("setAlwaysOnTop", [String(value)]);
  this.emit("always-on-top-updated", value);
}

}

const app = {

  name:"PositronApp",

  setTrayMenu(menuTemplate) {
    if(menuTemplate instanceof Menu) {
      menuTemplate = menuTemplate.template;
    } 
    trayMenu = menuTemplate;
    this.events.emit("tray-menu-updated", menuTemplate);
  },

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
   * Adds an event listener for application-level events.
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
   * Gets the currently focused window. Returns a Promise that resolves to the focused Window instance, or null if no windows are currently focused. Emits a "focused-window-retrieved" event with the focused window as data when done.
   * @returns {Promise<Window|null>} The currently focused window, or null if no windows are focused.
   */
  async getFocusedWindow() {
   const getFocused = await this.requestFromNative("getFocusedWindowId");
   const winId = getFocused?.focusedWindowId ? parseInt(getFocused.focusedWindowId, 10) : -1;
   const focusedWin = [...activeWindows].find(w => w.id === winId);
   return focusedWin || { error: "No focused window found" };
  },

  /**
   * Sets the application name.
   * @param {string} name The new name for the application.
   */
  setName(name) {
    process.env.POSITRON_APP_NAME = name;
    this.events.emit("name-updated", name);
    this.name = name;
    const path = this.userData.getPath();
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path, { recursive: true });
    }
  },

userData: {
  /**
   * Gets the path to the user data directory for the application. The path is determined based on the operating system and the application name. If the directory does not exist, it will be created. Emits a "user-data-path-retrieved" event with the path as data when done.
   * @param {string} [append] An optional string to append to the user data path.
   * @returns {string} The path to the user data directory.
   */
  getPath(append) {
    let userPath = null;

    if (process.platform === "win32") {
      userPath = process.env.APPDATA
        ? path.join(process.env.APPDATA, process.env.POSITRON_APP_NAME)
        : path.join(
            process.env.USERPROFILE,
            "AppData",
            "Roaming",
            process.env.POSITRON_APP_NAME
          );
    } else if (process.platform === "darwin") {
      userPath = path.join(
        process.env.HOME,
        "Library",
        "Application Support",
        process.env.POSITRON_APP_NAME
      );
    } else {
      // Linux / other POSIX — follow XDG Base Directory spec
      const xdgDataHome = process.env.XDG_DATA_HOME
        || path.join(process.env.HOME, ".local", "share");
      userPath = path.join(xdgDataHome, process.env.POSITRON_APP_NAME);
    }

    if(!fs.existsSync(userPath)) {
      fs.mkdirSync(userPath, { recursive: true });
  }

    return append ? path.join(userPath, append) : userPath;
  },

  /**
   * Creates the user data directory if it does not already exist.
   */
  create() {
    const userPath = this.getPath();

    if (!fs.existsSync(userPath)) {
      fs.mkdirSync(userPath, { recursive: true });
      success("User data directory created successfully.");
    }
  },

  /**
   * Deletes the user data directory and all of its contents. Use with caution, as this will permanently remove all user data for the application.
   */

  delete() {
    const userPath = this.getPath();

    if (fs.existsSync(userPath)) {
      fs.rmSync(userPath, { recursive: true, force: true });
      success("User data deleted successfully.");
    } else {
      warn("User data path does not exist:", userPath);
    }
  }
},

  /**
   * Full access to the underlying event emitter for application-level events, allowing for advanced event handling patterns if needed.
   */
  events: appEvents,

  /**
   * Sends a command to the native layer. This is a low-level method that can be used to send arbitrary commands, but for most use cases you will want to use the higher-level methods provided by the Window class instead.
   * @param {string} command The command to send to the native layer.
   * @param {any[]} args The arguments to send with the command.
   */
  sendToNative(command, args) {
    const payload = JSON.stringify({ 
      windowId: 0, 
      command,
      args: args || []
    });

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(payload);
    } else {
      error("No active socket to send command to native layer");
    }
  },
  
  /**
   * Sends a request to the native layer and returns a Promise that resolves to the response. This is a low-level method that can be used to send arbitrary requests, but for most use cases you will want to use the higher-level methods provided by the Window class instead.
   * @param {string} command The command to send to the native layer.
   * @param {any[]} args The arguments to send with the command.
   * @returns {Promise<any>} A Promise that resolves to the response from the native layer.
   */
  async requestFromNative(command, ...args) {
    return new Promise((resolve, reject) => {
      if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        const reqId = crypto.randomUUID();
        const replyChannel = `${command}-reply-${reqId}`;
        
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            unsubscribe();
            resolve({ error: `Request timed out waiting for reply on channel "${replyChannel}"` });
          }
        }, 7000);

        const unsubscribe = ipc.handle(replyChannel, (data) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            unsubscribe();
            
            for (const key in data) {
              if (data[key] === "true") data[key] = true;
              else if (data[key] === "false") data[key] = false;
              else if (!isNaN(data[key])) data[key] = Number(data[key]);
            }
            resolve(data);
          }
        });

        const payload = JSON.stringify({ 
          windowId: 0, 
          command,
          args: [...args, replyChannel]
        });

        activeSocket.send(payload);
      } else {
        reject(new Error("No active socket to send request to native layer"));
      }
    });
  },

  /**
   * Checks if the system is currently in dark mode. Returns a Promise that resolves to true if dark mode is enabled, or false if it is disabled. Emits an "is-dark-mode-checked" event with the result as data when done.
   * @returns {Promise<boolean>} True if dark mode is enabled, false otherwise.
   */
  async isDarkMode() {
    const res = await this.requestFromNative("isDarkMode");
    return res?.isDarkMode;
  }

}

const clipboard = {

  /**
   * Writes the specified text to the system clipboard.
   * @param {string} text The text to write to the clipboard.
   */
  async writeText(text) {
    app.sendToNative("writeToClipboard", [text]);
  },

  /**
   * Reads text from the system clipboard. Returns a Promise that resolves to the text currently stored in the clipboard, or an empty string if the clipboard is empty or does not contain text. 
   * @returns {Promise<string>} The text currently stored in the clipboard.
   */
  async readText() {
    const res = await app.requestFromNative("readFromClipboard");
    return res.text || "";
  }

}

const blockPowerSave = {
  
  start() {
    app.sendToNative("blockPowerSave");
  },

  stop() {
    app.sendToNative("unblockPowerSave");
  }

}

const getOpenPort = () => {
  const server = http.createServer()
  const res = server.listen(0).address();
  if (res && typeof res === "object") {
    server.close();
    return res.port;
  } else {
    warn("Failed to get open port, defaulting to random port generator");
    return getRandomPort();
  }
}

const setPort = (port) => {
  PORT = port;
  process.env.POSITRON_IPC_PORT = String(port);
  httpServer.close(() => {
    httpServer.listen(PORT, HOST, () => {
      info("IPC server running on " + HOST + ":" + PORT);
    });
  });
}

/**
 * Authorizes an incoming request by checking for a valid authentication token in the request headers. The token is compared to the expected token stored in the environment variable POSITRON_AUTH_TOKEN using a timing-safe comparison to prevent against timing attacks.
 * @param {Object} req The incoming HTTP request object.
 * @returns {boolean} True if the request is authorized, false otherwise.
 */
const authorize = (req) => {
  const header = req.headers["x-positron-auth-token"] || req.headers.authorization;

  if (!header) {
    return false;
  }

  const token = header.replace("Bearer ", "").trim();
  const expectedToken = process.env.POSITRON_AUTH_TOKEN || "";

  try {
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expectedToken, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

const registeredRoutes = [];

httpServer.on("request", (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  let matched = false;
  for (const route of registeredRoutes) {
    if (route.method === req.method && route.endpoint === pathname) {
      matched = true;
      if (route.requireAuth && !authorize(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      route.cb(req, res);
      break;
    }
  }

  if (!matched) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
});

const server = {
  authorize,
  /**
   * Registers an GET route with the server.
   * @param {string} endpoint The endpoint for the route.
   * @param {Function} cb The callback function for the route.
   * @param {boolean} requireAuth Whether the route requires authentication.
   */
  get: (endpoint, cb, requireAuth = false) => {
    registeredRoutes.push({ method: "GET", endpoint, cb, requireAuth });
  },
  /**
   * Registers an POST route with the server.
   * @param {string} endpoint The endpoint for the route.
   * @param {Function} cb The callback function for the route.
   * @param {boolean} requireAuth Whether the route requires authentication.
   */
  post: (endpoint, cb, requireAuth = false) => {
    registeredRoutes.push({ method: "POST", endpoint, cb, requireAuth });
  },
  /**
   * Registers a PATCH route with the server.
   * @param {string} endpoint The endpoint for the route.
   * @param {Function} cb The callback function for the route.
   * @param {boolean} requireAuth Whether the route requires authentication.
   */
  patch: (endpoint, cb, requireAuth = false) => {
    registeredRoutes.push({ method: "PATCH", endpoint, cb, requireAuth });
  },
  /**
   * Registers a DELETE route with the server.
   * @param {string} endpoint The endpoint for the route.
   * @param {Function} cb The callback function for the route.
   * @param {boolean} requireAuth Whether the route requires authentication.
   */
  delete: (endpoint, cb, requireAuth = false) => {
    registeredRoutes.push({ method: "DELETE", endpoint, cb, requireAuth });
  },
  /**
   * Registers a PUT route with the server.
   * @param {string} endpoint The endpoint for the route.
   * @param {Function} cb The callback function for the route.
   * @param {boolean} requireAuth Whether the route requires authentication.
   */
  put: (endpoint, cb, requireAuth = false) => {
    registeredRoutes.push({ method: "PUT", endpoint, cb, requireAuth });
  },

  /**
   * Unregisters a route from the server.
   * @param {string} endpoint The endpoint of the route to unregister.
   */
  unregister(endpoint) {
    const index = registeredRoutes.findIndex(r => r.endpoint === endpoint);
    if (index !== -1) {
      registeredRoutes.splice(index, 1);
    }
  },


  fullServer: httpServer
}

const dock = {
  icon: {
    show() {
      app.sendToNative("showDockIcon");
    },
    hide() {
      app.sendToNative("hideDockIcon");
    },
    toggle() {
      app.sendToNative("toggleDockIcon");
    },
    get visible() {
    return app.requestFromNative("isDockIconVisible")
      .then(res => res?.isDockIconVisible === "true");
  }
  },

  /**
   * Bounces the dock icon to get the user's attention.
   * @param {"informational"|"critical"} type The type of bounce to perform. "informational" will bounce the icon once, while "critical" will bounce it repeatedly until the user interacts with the application.
   */
  bounce(type = "informational") {
    app.sendToNative("bounceDockIcon", [type]);
  },

  badge: {
    /**
     * Sets the badge text on the dock icon.
     * @param {string} text The text to display on the badge. An empty string will remove the badge.
     */
    set(text) {
      app.sendToNative("setDockBadge", [text]);
    },
    /**
     * Gets the current badge text from the dock icon. Returns a Promise that resolves to the badge text as a string.
     * @returns {Promise<string>} The current badge text.
     */
    get text() {
    return app.requestFromNative("getDockBadge")
      .then(res => res?.badge || "");
  }
  }
}

module.exports = { Window, ipc, isPackaged, app, ipcPort:PORT, clipboard, blockPowerSave, getOpenPort, PORT, httpServer:server, wsServer:_ipcWS, setPort, dock };

const findNearestPackageJson = require("./findpackage");

const pkgjson = findNearestPackageJson()?.packageJson;
app.setName(pkgjson?.productName || pkgjson?.name || app.name);

httpServer.listen(PORT, HOST, () => {
info("IPC server running on " + (HOST !== "127.0.0.1" ? HOST : "") + ":" + PORT);
});