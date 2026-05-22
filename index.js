const WebSocket = require("ws");
const Events = require("events");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { performNativeBuild } = require("./builder");
const logger = require("./logs");
const IpcRouter = require("./ipc");
const { Menu } = require("./menu");
const { info, error, warn, success } = require("./logs");


const appRoot = process.cwd();
const binaryName = process.platform === "win32" ? "positron-runtime.exe" : "positron-runtime";
const binaryPath = path.join(appRoot, "bin", binaryName);

const appEvents = new Events.EventEmitter();


const isPackaged = process.env.POSITRON_PACKAGED === "true";

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
    const renderProcess = cp.spawn(binaryPath);

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

const _ipcWS = new WebSocket.Server({ port: process.env.POSITRON_IPC_PORT || 9000 });
let activeSocket = null;
const pendingWindows = new Set(); 

const commandQueue = []; 

_ipcWS.on("connection", ws => {
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

      switch (msg.event) {
        case "ipcMessage": {
          ipc.dispatch(ws, msg); 
          break;
        }

        case "windowClosed": {
          info(`Window ${msg.windowId} closed`);
          break;
        }

        default:
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

info("IPC server running on port " + (process.env.POSITRON_IPC_PORT || 9000));

let _windowCounter = 0;

class Window extends Events.EventEmitter {
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

  setTitle(title) { 
    this.sendCommand("setTitle", [title]); 
    this.emit("title-updated", title); 
  }
  loadURL(url) { 
    this.sendCommand("loadURL", [url]); 
    this.emit("url-loaded", url); 
    this.emit("navigated", url); 
  }
  loadFile(path) { 
    this.sendCommand("loadFile", [path]); 
    this.emit("file-loaded", path); 
    this.emit("navigated", path); 
  }

sendIpc(command, args = []) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ windowId: this.id, command, args }));
    this.emit("ipc-sent", { command, args });
  } else {
    warn(`Cannot send IPC message, socket not ready. Command: ${command}`);
  }
}

 #created = false;

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

close() {
  this.#created = false;
  this.emit("close");
  this.sendCommand("closeWindow");
}

setMenu(menuTemplate) {
  if(menuTemplate instanceof Menu) {
    menuTemplate = menuTemplate.template;
  } 
  this.sendCommand("setMenu", [JSON.stringify(menuTemplate)]);
  this.emit("menu-updated", menuTemplate);
}

resetMenu() {
  this.sendCommand("resetMenu");
  this.emit("menu-updated", null);
}

alert(message) {
  this.sendCommand("alert", [message]);
  this.emit("alert", message);
}

addUserScript(script) {
  this.sendCommand("addUserScript", [script]);
  this.emit("user-script-added", { content: script, filePath: null });
}

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

resize(width, height) {
  this.sendCommand("resizeWindow", [width, height]);
  this.emit("resized", { width, height });
}

openDevTools() {
  this.sendCommand("openDevTools");
  this.emit("devtools-opened");
}

toggleFullscreen() {
  this.sendCommand("toggleFullscreen");
  this.emit("fullscreen-toggled");
}

goFullscreen() {
  this.sendCommand("fullscreen");
  this.emit("fullscreen-entered");
}

exitFullscreen() {
  this.sendCommand("exitFullscreen");
  this.emit("fullscreen-exited");
}


goForward() {
  this.sendCommand("forward");
  this.emit("navigated-forward");
}

goBack() {
  this.sendCommand("back");
  this.emit("navigated-back");
}

hide() {
  this.sendCommand("hideWindow");
  this.emit("hidden");
}

show() {
  this.sendCommand("showWindow");
  this.emit("shown");
}

focus() {
  this.sendCommand("focus");
  this.emit("focused");
}

reload() {
  this.sendCommand("reload");
  this.emit("reloaded");
}

capturePage() {
  this.sendCommand("capturePage");
  this.emit("capture-page-requested");
}

}

const app = {

  quit(exitCode = 0) {
    this.events.emit("before-quit");
    process.exit(exitCode);
  },

  events: appEvents
  
}

module.exports = { Window, ipc, isPackaged, app };
