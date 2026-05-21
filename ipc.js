module.exports = class IpcRouter {
  #handlers = new Map();
  #ws;

  constructor(ws) {
    this.#ws = ws;
  }

  handle(channel, fn) {
    this.#handlers.set(channel, fn);
    return this;
  }

  dispatch(msg) {
    if (msg.event !== "ipcMessage") return false;

    const { channel, payload } = msg.data;
    const parsed = JSON.parse(payload);
    const handler = this.#handlers.get(channel);

    if (!handler) {
      console.warn(`[ipc] No handler for channel "${channel}"`);
      return false;
    }

    const reply = (data) => this.send(msg.windowId, channel + "-reply", data);
    const emit  = (ch, data) => this.send(msg.windowId, ch, data);

    handler(parsed, { reply, emit, windowId: msg.windowId });
    return true;
  }

  send(windowId, channel, data = null) {
    this.#ws.send(JSON.stringify({
      windowId,
      command: "emitToRenderer",
      args: [channel, JSON.stringify(data)],
    }));
  }
}