// The tab's line to the service worker: a runtime.connect port named "tab".
// The worker can stop at any time; the port then disconnects and is opened
// again, which starts the worker. If the extension itself is gone (reloaded
// or updated), the script removes itself so a fresh copy can be injected.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const listeners = new Set();
  let port = null;
  let stopped = false;

  ns.worker = {
    connection: "connecting",
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
