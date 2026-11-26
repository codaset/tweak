// The worker's self-update glue, against a small fake of the chrome.* it uses.
import { test } from "node:test";
import assert from "node:assert/strict";

function fakeChrome(version) {
  const area = () => {
    const data = {};
    return {
      data,
      async get(keys) {
        if (keys === null) return { ...data };
        const out = {};
        for (const k of [keys].flat()) if (k in data) out[k] = data[k];
        return out;
      },
      async set(items) {
        Object.assign(data, items);
      },
      async remove(keys) {
        for (const k of [keys].flat()) delete data[k];
      },
    };
  };
  return {
    reloads: 0,
    storage: { local: area(), session: area() },
    runtime: {
      getManifest: () => ({ version }),
      reload() {
        globalThis.chrome.reloads++;
      },
    },
  };
}

function fakePort() {
  const on = { message: [], disconnect: [] };
  return {
    sent: [],
    postMessage(m) {
      this.sent.push(m);
    },
    onMessage: { addListener: (f) => on.message.push(f) },
    onDisconnect: { addListener: (f) => on.disconnect.push(f) },
    say: (m) => on.message.forEach((f) => f(m)),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function setup(version) {
  globalThis.chrome = fakeChrome(version);
  const published = [];
  const { createSelfUpdate } = await import("../../extension/self-update.js");
  const u = createSelfUpdate({ publish: (c) => published.push(c) });
  await u.restored;
  return { u, published };
}

test("a tab saying busy again, unchanged, publishes nothing more", async () => {
  const { u, published } = await setup("1.1.0");
  const tab = fakePort();
  u.watchTab(tab);
  tab.say({ type: "busy", busy: true });
  u.bridgeVersion("1.2.0");
  await settle();
  const n = published.length;
  assert.deepEqual(published.at(-1), { update: { state: "waiting", version: "1.2.0" } });
  // Every publish reaches the tab as a state message, which echoes busy.
  for (let i = 0; i < 5; i++) tab.say({ type: "busy", busy: true });
  await settle();
  assert.equal(published.length, n);
  assert.equal(chrome.reloads, 0);
});

test("stuck after reloading, the panel names the bridge's folder", async () => {
  globalThis.chrome = fakeChrome("1.1.0");
  await chrome.storage.local.set({ updateExpected: "1.2.0" });
  const published = [];
  const { createSelfUpdate } = await import("../../extension/self-update.js");
  const u = createSelfUpdate({ publish: (c) => published.push(c) });
  u.bridgeVersion("1.2.0", "/tmp/tweak-state/extension");
  await settle();
  assert.deepEqual(published.at(-1), { update: { state: "stuck", version: "1.1.0", folder: "/tmp/tweak-state/extension" } });
  assert.equal(chrome.reloads, 0);
});

test("the tab coming free reloads, with storage.session stashed", async () => {
  const { u } = await setup("1.1.0");
  await chrome.storage.session.set({ draft: "half" });
  const tab = fakePort();
  u.watchTab(tab);
  tab.say({ type: "busy", busy: true });
  u.bridgeVersion("1.2.0");
  await settle();
  tab.say({ type: "busy", busy: false });
  await settle();
  assert.equal(chrome.reloads, 1);
  assert.deepEqual(chrome.storage.local.data, { updateStash: { draft: "half" }, updateExpected: "1.2.0" });
});

// The hello carries it, so the bridge tells an update on its way from a copy
// loaded from another folder (docs/design.md, "The extension updates itself").
test("the version the worker last reloaded for, for hello: none until it reloads", async () => {
  const { u } = await setup("1.1.0");
  const { reloadedFor } = await import("../../extension/self-update.js");
  assert.equal(await reloadedFor(), "");
  const tab = fakePort();
  u.watchTab(tab);
  tab.say({ type: "busy", busy: true });
  u.bridgeVersion("1.2.0");
  await settle();
  assert.equal(await reloadedFor(), "", "waiting on a busy tab is not reloaded yet");
  tab.say({ type: "busy", busy: false });
  await settle();
  assert.equal(await reloadedFor(), "1.2.0");
});

