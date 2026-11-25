// The service worker: the bridge WebSocket, content-script registration, the
// badge, and relaying to the side panel and tabs (docs/design.md, "Chrome
// extension"). Every chrome.* listener is added synchronously at the top
// level, so events that wake the worker reach it.
import { plan, CONTENT_FILES, PROBE_FILES } from "./lib/registrations.js";
import { retryDelay } from "./lib/backoff.js";
import { apply } from "./lib/claims.js";
import { badge } from "./lib/badge.js";
import { DEFAULT_PORT, PROTOCOL, validPort } from "./lib/bridge.js";

const KEEPALIVE_MS = 20_000; // WebSocket traffic keeps the worker awake (Chrome 116+)
const ALARM = "reconnect";
const ALL_URLS = { origins: ["<all_urls>"] };

// What the side panel shows. connection is "connecting", "connected",
// "disconnected" or "refused" (with message).
const state = { connection: "connecting", message: "", port: DEFAULT_PORT, granted: false, claims: [] };
let claims = { seq: 0, claims: [] };
let heardFromBridge = false; // once true, the cache is out of date

// ---- Listeners ----

chrome.runtime.onInstalled.addListener(() => restoreFromCache());
chrome.runtime.onStartup.addListener(() => restoreFromCache());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) connect();
});
chrome.permissions.onAdded.addListener(async () => {
  await refreshAccess();
  // Registrations didn't inject before the grant: give open tabs the scripts.
  injectIntoOpenTabs(claims.claims);
});
chrome.permissions.onRemoved.addListener(() => refreshAccess());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "port" in changes) reconnect();
});
chrome.action.onClicked.addListener((tab) => {
  // First, while the click's gesture lasts. Pick mode comes with the tracer.
  chrome.sidePanel.open({ tabId: tab.id });
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "panel") {
    panels.add(port);
    port.onDisconnect.addListener(() => panels.delete(port));
    port.postMessage({ type: "state", ...state });
  } else if (port.name === "tab") {
    tabs.add(port);
    port.onDisconnect.addListener(() => tabs.delete(port));
    port.postMessage({ type: "state", connection: state.connection });
  }
});

const panels = new Set();
const tabs = new Set();

function publish(changes) {
  Object.assign(state, changes);
  for (const p of panels) p.postMessage({ type: "state", ...state });
  for (const p of tabs) p.postMessage({ type: "state", connection: state.connection });
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
  if (!heardFromBridge) claims = { seq: 0, claims: cached };
  await syncRegistrations(claims.claims);
}

async function remember(next) {
  claims = next;
  heardFromBridge = true;
  publish({ claims: next.claims });
  await chrome.storage.local.set({ claims: next.claims });
  await syncRegistrations(next.claims);
}

// ---- The bridge socket ----

let socket = null;
let attempt = 0;
let retryTimer = 0;

async function bridgePort() {
  const { port } = await chrome.storage.local.get("port");
  return validPort(port) ? port : DEFAULT_PORT;
}

async function connect() {
  if (socket) return;
  clearTimeout(retryTimer);
  const port = await bridgePort();
  if (socket) return;
  if (state.connection !== "refused") publish({ connection: "connecting", port });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket = ws;
  let keepalive = 0;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, lastSeq: 0, version: chrome.runtime.getManifest().version }));
    keepalive = setInterval(() => ws.send(JSON.stringify({ type: "keepalive" })), KEEPALIVE_MS);
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "snapshot") {
      attempt = 0;
      publish({ connection: "connected", message: "", port });
    }
    if (msg.type === "refusal") {
      publish({ connection: "refused", message: msg.message, port });
      return;
    }
    const next = apply(claims, msg);
    if (next !== claims) remember(next);
  };
  ws.onclose = () => {
    clearInterval(keepalive);
    if (socket !== ws) return;
    socket = null;
    // The claims and registrations stay as they were: pages keep working
    // from the last-known claims until the bridge is back.
    if (state.connection === "refused") return; // only the alarm retries
    publish({ connection: "disconnected", port });
    retryTimer = setTimeout(connect, retryDelay(attempt++));
  };
}

function reconnect() {
  attempt = 0;
  const ws = socket;
  socket = null;
  publish({ connection: "connecting", message: "" });
  ws?.close();
  connect();
}

// ---- Every worker start ----

// The alarm stays armed: if Chrome stops the worker with the socket open,
// onclose never runs, and only the alarm wakes it to connect again (seen
// with the keepalive off). While connected, it finds the socket open.
chrome.alarms.get(ALARM).then((a) => a || chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }));
refreshAccess();
restoreFromCache();
connect();
