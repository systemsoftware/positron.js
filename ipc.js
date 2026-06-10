const { warn } = require("./logs");

module.exports = class IpcRouter {
  #handlers = new Map();

  /**
   * Registers a handler for a specific IPC channel. Returns a function to unregister the handler.
   * @param {string} channel 
   * @param {function} fn 
   * @returns {function} A function to unregister the handler.
   */
  handle(channel, fn) {
    if (!this.#handlers.has(channel)) {
      this.#handlers.set(channel, new Set());
    }

    this.#handlers.get(channel).add(fn);

    return () => {
      this.#handlers.get(channel)?.delete(fn);

      if (this.#handlers.get(channel)?.size === 0) {
        this.#handlers.delete(channel);
      }
    };
  }

  /**
   * @internal
   */
 dispatch(ws, msg) {
    if (msg.event !== "ipcMessage") return false;

    const { channel, payload } = msg.data;

    const parsed =
      typeof payload === "string"
        ? JSON.parse(payload)
        : payload;

    const handlers = this.#handlers.get(channel);

    if (!handlers || handlers.size === 0) {
      if(channel == "nativeError") return
      warn(`[ipc] No handlers for channel "${channel}"`);
      return false;
    }

    const reply = (data) =>
      this.send(ws, msg.windowId, channel + "-reply", data);

    const emit = (ch, data) =>
      this.send(ws, msg.windowId, ch, data);

    for (const handler of handlers) {
      try {
        handler(parsed, {
          reply,
          emit,
          windowId: msg.windowId,
        });
      } catch (err) {
        warn(`[ipc] Handler error on "${channel}": ${err.stack || err}`);
      }
    }

    return true;
  }

  /** @internal */
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