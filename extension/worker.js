// The service worker: the bridge WebSocket, content-script registration, the
// badge, and relaying to the side panel and tabs (docs/design.md, "Chrome
// extension"). Every chrome.* listener is added synchronously at the top
// level, so events that wake the worker reach it.
import { plan, CONTENT_FILES, PROBE_FILES } from "./lib/registrations.js";
import { retryDelay } from "./lib/backoff.js";
import { apply } from "./lib/claims.js";
import { badge } from "./lib/badge.js";
import { nextStatus } from "./lib/status.js";
import { DEFAULT_PORT, PROTOCOL, validPort } from "./lib/bridge.js";
import { createSelfUpdate } from "./self-update.js";
import { applyTweaks, forPage, pageOf } from "./lib/tweaks.js";
import { matches } from "./lib/match.js";
import { requests } from "./lib/requests.js";

const KEEPALIVE_MS = 20_000; // WebSocket traffic keeps the worker awake (Chrome 116+)
const ALARM = "reconnect";
const ALL_URLS = { origins: ["<all_urls>"] };
const NOT_CONNECTED = "Not connected to Tweak";

// What the side panel shows (see lib/status.js for connection and message).
const view = { connection: "connecting", message: "", port: DEFAULT_PORT, granted: false, claims: [], update: null };
// The claims as of event seq, from the bridge or, until it answers, the cache.
let claimState = { seq: 0, claims: [] };
let heardFromBridge = false; // once true, the cache is out of date
// The open tweaks as of event seq. Kept in storage.session too, so pins and
// cards survive a worker restart while the bridge is down.
let tweakState = applyTweaks(undefined, { type: "snapshot", seq: 0, tweaks: [] });

// ---- Listeners ----

chrome.runtime.onInstalled.addListener(() => restoreFromCache());
chrome.runtime.onStartup.addListener(() => restoreFromCache());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) bridge.connect();
});
chrome.permissions.onAdded.addListener(async () => {
  await refreshAccess();
  // Registrations didn't inject before the grant: give open tabs the scripts.
  injectIntoOpenTabs(claimState.claims);
});
chrome.permissions.onRemoved.addListener(() => refreshAccess());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "port" in changes) bridge.reconnect();
});
chrome.action.onClicked.addListener((tab) => {
  // First, while the click's gesture lasts. Pick mode comes with the tracer.
  chrome.sidePanel.open({ tabId: tab.id });
});
chrome.runtime.onConnect.addListener((port) => {
  const ports = { panel: panels, tab: tabs }[port.name];
  if (!ports) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  if (port.name === "tab") port.onMessage.addListener((msg) => onTabMessage(port, msg));
  port.postMessage(port.name === "panel" ? panelMessage() : tabMessage());
  if (port.name === "tab") selfUpdate.watchTab(port);
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(cardKey(tabId)));

// ---- The side panel and tabs ----

const panels = new Set();
const tabs = new Set();
const panelMessage = () => ({ type: "state", ...view });
const tabMessage = () => ({ type: "state", connection: view.connection });

function publish(changes) {
  Object.assign(view, changes);
  for (const p of panels) p.postMessage(panelMessage());
  for (const p of tabs) p.postMessage(tabMessage());
}

const setStatus = (event, changes = {}) => publish({ ...nextStatus(view, event), ...changes });

const selfUpdate = createSelfUpdate({ publish });
// After the self-update's restore: storage.session may be coming back from it.
const tweaksRestored = restoreTweaks();

// ---- Tweaks in tabs ----

// Each tab port says which page it shows; it gets that page's tweaks and
// the card that was open in the tab (kept per tab in storage.session, so it
// reopens in place after a reload), then every change to one of them.
const cardKey = (tabId) => `card-${tabId}`;

async function onTabMessage(port, msg) {
  const tabId = port.sender?.tab?.id;
  switch (msg.type) {
    case "page": {
      port.page = pageOf(msg.url);
      port.url = msg.url;
      await tweaksRestored;
      const key = cardKey(tabId);
      const { [key]: card = null } = await chrome.storage.session.get(key);
      port.postMessage({ type: "tweaks", tweaks: forPage(tweakState, port.page), card, claimed: claimed(port.url) });
      break;
    }
    case "card":
      if (msg.number) await chrome.storage.session.set({ [cardKey(tabId)]: msg.number });
      else await chrome.storage.session.remove(cardKey(tabId));
      break;
    case "create": {
      const ref = bridge.request(msg, (answer) => port.postMessage({ type: "created", ref: msg.ref, ...answer }));
      if (ref) port.onDisconnect.addListener(() => bridge.pending.forget(ref));
      break;
    }
  }
}

// claimed says whether any claim covers a URL: a tab whose page none does
// goes dormant (no picker, no pins).
const claimed = (url) => claimState.claims.some((c) => matches(c.pattern, url));

async function restoreTweaks() {
  await selfUpdate.restored;
  const { tweaks = [] } = await chrome.storage.session.get("tweaks").catch(() => ({}));
  if (tweakState.seq === 0) tweakState = applyTweaks(undefined, { type: "snapshot", seq: 0, tweaks });
}

function adoptTweaks(next, msg) {
  tweakState = next;
  chrome.storage.session.set({ tweaks: [...next.tweaks.values()] });
  for (const port of tabs) {
    if (!port.page) continue;
    if (msg.type === "snapshot") port.postMessage({ type: "tweaks", tweaks: forPage(next, port.page) });
    else if (msg.tweak.page === port.page) port.postMessage({ type: "tweak", tweak: msg.tweak });
  }
}

// ---- Site access and the badge ----

async function refreshAccess() {
  const granted = await chrome.permissions.contains(ALL_URLS);
  const { text, color } = badge({ granted });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  publish({ granted });
  return granted;
}

// ---- Claims and registration ----

// Changes to registrations run one at a time, in order, so a snapshot and
// the events after it can't interleave.
let queue = Promise.resolve();
function syncRegistrations(list) {
  queue = queue.then(() => sync(list)).catch((e) => console.error("Codaset Tweak: registration failed", e));
  return queue;
}

async function sync(list) {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const { register, unregister, added } = plan(registered, list);
  if (unregister.length) await chrome.scripting.unregisterContentScripts({ ids: unregister });
  if (register.length) await chrome.scripting.registerContentScripts(register);
  await injectIntoOpenTabs(added);
}

// Tabs already open when a claim starts get the scripts now, not on reload.
// The scripts guard against running twice.
async function injectIntoOpenTabs(list) {
  if (!list.length || !(await chrome.permissions.contains(ALL_URLS))) return;
  for (const claim of list) {
    const open = await chrome.tabs.query({ url: claim.pattern }).catch(() => []);
    for (const tab of open) {
      const target = { tabId: tab.id }; // the top frame only
      await chrome.scripting
        .executeScript({ target, files: PROBE_FILES, world: "MAIN", injectImmediately: true })
        .then(() => chrome.scripting.executeScript({ target, files: CONTENT_FILES }))
        .catch((e) => console.warn(`Codaset Tweak: couldn't inject into tab ${tab.id}`, e.message));
    }
  }
}

// Chrome wipes runtime registrations on install and update, so the
// last-known claims are registered again at once, before the bridge answers.
async function restoreFromCache() {
  const { claims: cached = [] } = await chrome.storage.local.get("claims");
  if (!heardFromBridge) claimState = { seq: 0, claims: cached };
  await syncRegistrations(claimState.claims);
}

// adoptClaims takes the bridge's claims: shows them in the panel, caches
// them in storage.local and brings the registrations in line.
async function adoptClaims(next) {
  claimState = next;
  heardFromBridge = true;
  for (const port of tabs) if (port.url) port.postMessage({ type: "claimed", claimed: claimed(port.url) });
  publish({ claims: next.claims });
  await chrome.storage.local.set({ claims: next.claims });
  await syncRegistrations(next.claims);
}

function onBridgeMessage(msg, port) {
  if (msg.type === "refusal") {
    setStatus({ type: "refused", message: msg.message }, { port });
    return "refused";
  }
  if (msg.type === "result") {
    bridge.pending.answer(msg);
    return;
  }
  if (msg.type === "snapshot") {
    setStatus({ type: "connected" }, { port });
    selfUpdate.bridgeVersion(msg.version, msg.folder);
  }
  const next = apply(claimState, msg);
  if (next !== claimState) adoptClaims(next);
  const tweaks = applyTweaks(tweakState, msg);
  if (tweaks !== tweakState) adoptTweaks(tweaks, msg);
}

// ---- The bridge socket ----

// One socket at a time. While awake, a closed socket is retried with
// backoff; a refused one waits for the alarm.
const bridge = {
  ws: null,
  attempt: 0,
  retryTimer: 0,
  pending: requests(), // waiting for the bridge's result

  // request sends a message that the bridge answers with a result, or
  // answers at once when there's no connection: the action is refused, not
  // held. It returns the ref, or "" when it answered at once.
  request(msg, reply) {
    const ws = this.ws?.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ws.ready) {
      reply({ error: NOT_CONNECTED });
      return "";
    }
    const ref = this.pending.add(reply);
    ws.send(JSON.stringify({ ...msg, ref }));
    return ref;
  },

  async connect() {
    if (this.ws) return;
    clearTimeout(this.retryTimer);
    // Claim the slot before the first await, so two callers can't both connect.
    const conn = { refused: false, keepalive: 0 };
    this.ws = conn;
    const port = await bridgePort();
    if (this.ws !== conn) return; // closed or replaced meanwhile
    setStatus({ type: "connecting" }, { port });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    conn.socket = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, lastSeq: 0, version: chrome.runtime.getManifest().version }));
      conn.keepalive = setInterval(() => ws.send(JSON.stringify({ type: "keepalive" })), KEEPALIVE_MS);
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "snapshot") {
        this.attempt = 0;
        conn.ready = true;
      }
      if (onBridgeMessage(msg, port) === "refused") conn.refused = true;
    };
    ws.onclose = () => {
      clearInterval(conn.keepalive);
      this.pending.dropAll(NOT_CONNECTED);
      if (this.ws !== conn) return; // closed on purpose
      this.ws = null;
      // The claims and registrations stay as they were: pages keep working
      // from the last-known claims until the bridge is back.
      setStatus({ type: "closed", refused: conn.refused }, { port });
      if (!conn.refused) this.retryTimer = setTimeout(() => this.connect(), retryDelay(this.attempt++));
    };
  },

  close() {
    const conn = this.ws;
    this.ws = null;
    clearTimeout(this.retryTimer);
    if (conn) {
      clearInterval(conn.keepalive);
      conn.socket?.close();
    }
  },

  // reconnect starts again at once, for a new port: an old refusal no longer applies.
  reconnect() {
    this.close();
    this.attempt = 0;
    setStatus({ type: "reconnect" });
    this.connect();
  },
};

async function bridgePort() {
  const { port } = await chrome.storage.local.get("port");
  return validPort(port) ? port : DEFAULT_PORT;
}

// ---- Every worker start ----

// The alarm stays armed: if Chrome stops the worker with the socket open,
// onclose never runs, and only the alarm wakes it to connect again (seen
// with the keepalive off). While connected, it finds the socket open.
chrome.alarms.get(ALARM).then((a) => a || chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }));
refreshAccess();
restoreFromCache();
bridge.connect();
