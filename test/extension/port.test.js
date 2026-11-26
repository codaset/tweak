// The tab's port to the worker, loaded as the classic content script it is,
// with a stand-in for chrome.runtime.connect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./probe-world.js";


function load() {
  const ports = [];
  const chrome = {
    runtime: {
      connect() {
        const on = () => {
          const fns = [];
          return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.forEach((fn) => fn(...a)) };
        };
        const port = { onMessage: on(), onDisconnect: on(), sent: [], postMessage: (m) => port.sent.push(m) };
        ports.push(port);
        return port;
      },
    },
  };
  const ns = { ready: false, teardowns: [], alive: () => true, teardown() {} };
  loadScript("port.js", ns, { chrome, setTimeout: () => 0 });
  return { ns, ports };
}

test("losing the worker's port says so at once: not connected, and a closed message", () => {
  const { ns, ports } = load();
  const heard = [];
  ns.worker.on((m) => heard.push(m.type));
  ns.worker.connect();
  ports[0].onMessage.fire({ type: "state", connection: "connected" });
  assert.equal(ns.worker.connection, "connected");

  ports[0].onDisconnect.fire();
  assert.notEqual(ns.worker.connection, "connected");
  assert.deepEqual(heard, ["open", "state", "closed"]);
});
