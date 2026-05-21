const { warn } = require("./logs");

module.exports = class IpcRouter {
  #handlers = new Map();

  handle(channel, fn) {
    this.#handlers.set(channel, fn);
    return this;
  }

  dispatch(ws, msg) {
    if (msg.event !== "ipcMessage") return false;

    const { channel, payload } = msg.data;
    
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    const handler = this.#handlers.get(channel);

    if (!handler) {
      warn(`[ipc] No handler for channel "${channel}"`);
      return false;
    }

    const reply = (data) => this.send(ws, msg.windowId, channel + "-reply", data);
    const emit  = (ch, data) => this.send(ws, msg.windowId, ch, data);

    handler(parsed, { reply, emit, windowId: msg.windowId });
    return true;
  }

  send(ws, windowId, channel, data = null) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        windowId,
        command: "emitToRenderer",
        args: [channel, JSON.stringify(data)],
      }));
    } else {
      warn(`[ipc] Cannot emit to renderer: socket connection is not open.`);
    }
  }
}