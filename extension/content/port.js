// The tab's line to the service worker: a runtime.connect port named "tab".
// The worker can stop at any time; the port then disconnects and is opened
// again, which starts the worker. If the extension itself is gone (reloaded
// or updated), the script removes itself so a fresh copy can be injected.
// Listeners hear a local {type: "open"} each time the port connects, and
// {type: "closed"} each time it's lost.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const listeners = new Set();
  let port = null;
  let stopped = false;

  ns.worker = {
    connection: "connecting",
    // down says whether the bridge is known to be down (or refused us):
    // pins and cards fade and go read-only, and pointing opens the side
    // panel. While the worker's port reconnects it's unknown, not down.
    down() {
      return this.connection === "disconnected" || this.connection === "refused";
    },
    // openSidePanel asks the worker for the side panel. Call it from the
    // input event itself: runtime.sendMessage carries its user gesture,
    // which sidePanel.open needs.
    openSidePanel() {
      try {
        chrome.runtime.sendMessage({ type: "side-panel" }).catch(() => {});
      } catch {
        // the extension is gone: the port's teardown follows
      }
    },
    // on(fn) hears every message from the worker.
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    post(msg) {
      port?.postMessage(msg);
    },
    connect() {
      if (stopped) return;
      try {
        port = chrome.runtime.connect({ name: "tab" });
      } catch {
        ns.teardown(); // the extension is gone
        return;
      }
      for (const fn of listeners) fn({ type: "open" });
      port.onMessage.addListener((msg) => {
        if (msg.type === "state") ns.worker.connection = msg.connection;
        for (const fn of listeners) fn(msg);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        // Until the new port's state arrives, nothing can be sent, and
        // whatever was waiting on the worker will never be answered.
        ns.worker.connection = "connecting";
        for (const fn of listeners) fn({ type: "closed" });
        if (!ns.alive()) ns.teardown();
        else setTimeout(() => ns.worker.connect(), 100);
      });
    },
  };
  ns.teardowns.push(() => {
    stopped = true;
    port?.disconnect();
    port = null;
  });
})();
