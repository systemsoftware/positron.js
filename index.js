const WebSocket = require("ws");
const Events = require("events");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { performNativeBuild } = require("./builder");
const logger = require("./logs");
const IpcRouter = require("./ipc");
const { Menu } = require("./menu");


const appRoot = process.cwd();
const binaryName = process.platform === "win32" ? "positron-runtime.exe" : "positron-runtime";
const binaryPath = path.join(appRoot, "bin", binaryName);

const appEvents = new Events.EventEmitter();


const isPackaged = process.env.POSITRON_PACKAGED === "true";

if (!isPackaged) {
    // DEV MODE
    if (!fs.existsSync(binaryPath)) {
        console.log("[Positron] Native binary missing. Triggering automatic background build...");
        const buildSuccess = performNativeBuild();
        if (!buildSuccess) {
            console.error("[Positron] Fatal: Could not auto-compile native binary.");
            process.exit(1);
        }
    }

    console.log("[INFO] Starting Positron render process...");
    const renderProcess = cp.spawn(binaryPath);

    renderProcess.on("error", (err) => {
        console.error("[ERROR] Failed to start render process:", err);
        process.exit(1);
    });

    renderProcess.on("close", (code) => {
        console.log(`[Positron] Render process exited with code ${code}`);
        process.exit(code);
    });
} else {
    // PRODUCTION MODE
    console.log("[Positron] Packaged mode detected. Skipping native binary spawn.");
}

const _ipcWS = new WebSocket.Server({ port: process.env.POSITRON_IPC_PORT || 9000 });
let activeSocket = null;
const pendingWindows = new Set(); 

const commandQueue = []; 

_ipcWS.on("connection", ws => {
  activeSocket = ws;
  logger.info("Client connected to IPC");

  while (commandQueue.length > 0) {
    const payload = commandQueue.shift();
    activeSocket.send(payload);
  }

  pendingWindows.forEach(win => {
    win.emit("ready");
  });
  pendingWindows.clear();
ws.on("message", raw => {
  const msg = JSON.parse(raw);

  switch (msg.event) {
    case "ipcMessage": {
      const { channel, payload } = msg.data;
      const parsed = JSON.parse(payload);
      ipc.dispatch(msg);
      break;
    }

    case "windowClosed": {
      logger.info(`Window ${msg.windowId} closed`);
      break;
    }

    default:
      logger.warn("Unhandled event:", msg.event, msg);
  }
});

  ws.on("close", () => { 
    activeSocket = null; 
  });
});

const ipc = new IpcRouter(_ipcWS);

logger.info("IPC server running on port " + (process.env.POSITRON_IPC_PORT || 9000));

let _windowCounter = 0;

class Window extends Events.EventEmitter {
  constructor(options = {}) {
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
      this.create(width, height);
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
      if(command != "createWindow") logger.info(`Socket not ready. Outbound command queued: ${command}`);
      commandQueue.push(payload);
    }
  }

  setTitle(title) { this.sendCommand("setTitle", [title]); }
  loadURL(url) { this.sendCommand("loadURL", [url]); }
  loadFile(path) { this.sendCommand("loadFile", [path]); }

sendIpc(windowId, command, args = []) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ windowId, command, args }));
    this.emit("ipc-sent", { command, args });
  } else {
    logger.warn(`Cannot send IPC message, socket not ready. Command: ${command}`);
  }
}

 #created = false;

create(width, height) {
  if (this.#created) {
    logger.warn(`Window ${this.id} is already created.`);
    return;
  }
  this.#created = true;
  if(!width) width = this.options.width || 800;
  if(!height) height = this.options.height || 600;
      this.sendCommand("createWindow", [width, height]);
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
      logger.error(`Failed to read user script from ${filePath}:`, err);
      return;
    }
    this.addUserScript(data);
    this.emit("user-script-added", { filePath, content: data });
  });
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
