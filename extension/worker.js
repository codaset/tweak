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
import { applyTweaks, askedIn, forTab, pageOf, reachesTab } from "./lib/tweaks.js";
import { matches } from "./lib/match.js";
import { requests } from "./lib/requests.js";
import { draw, frame, paced } from "./lib/screenshot.js";

const KEEPALIVE_MS = 20_000; // WebSocket traffic keeps the worker awake (Chrome 116+)
const ALARM = "reconnect";
const ALL_URLS = { origins: ["<all_urls>"] };
const NOT_CONNECTED = "Not connected to Tweak";

// What the side panel shows (see lib/status.js for connection and message).
const view = { connection: "connecting", message: "", port: DEFAULT_PORT, granted: false, claims: [], update: null, suggestions: [] };
// The claims as of event seq, from the bridge or, until it answers, the cache.
let claimState = { seq: 0, claims: [] };
let heardFromBridge = false; // once true, the cache is out of date
// The open tweaks as of event seq. Kept in storage.session too, so pins and
// cards survive a worker restart while the bridge is down.
let tweakState = applyTweaks(undefined, { type: "snapshot", seq: 0, tweaks: [] });
// The tab each tweak was sent from, by number: its question pops up there
// (askedIn). Kept in storage.session too, so a worker restart keeps it.
const senders = new Map();

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
  if (area === "local" && "dismissed" in changes) {
    dismissed = changes.dismissed.newValue ?? {};
    publishSuggestions();
  }
});
// Toggling pick mode on a claimed page (design.md § Toolbar button) is still
// to come; ⌥-click picks for now.
chrome.action.onClicked.addListener((tab) => openSidePanel(tab));
chrome.runtime.onConnect.addListener((port) => {
  const ports = { panel: panels, tab: tabs }[port.name];
  if (!ports) return;
  ports.add(port);
  port.tabId = port.sender?.tab?.id;
  port.shots = new Map(); // a tab's captures, held until Send or drop
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    port.shots.clear();
    if (port.suggestions?.length) publishSuggestions();
  });
  if (port.name === "tab") port.onMessage.addListener((msg) => onTabMessage(port, msg));
  port.postMessage(port.name === "panel" ? panelMessage() : tabMessage());
  if (port.name === "tab") selfUpdate.watchTab(port);
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(cardKey(tabId)));

// ---- The side panel and tabs ----

// Called first in its handler, while the gesture lasts. The e2e test copy
// calls it by message, as the shortcut and context menu will.
function openSidePanel(tab) {
  return chrome.sidePanel.open({ tabId: tab.id });
}

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

// ---- Optional improvements ----

// The side panel suggests what a tab's page could add (design.md, Optional
// improvements) until it is dismissed for the site: by origin, kept in
// storage.local as dismissed {origin: [kind]}. The panel shows its own
// window's active tab's.
let dismissed = {};
const dismissedRead = chrome.storage.local.get("dismissed").then(({ dismissed: d = {} }) => (dismissed = d));

async function publishSuggestions() {
  await dismissedRead;
  const suggestions = [];
  for (const port of tabs) {
    if (port.tabId === undefined || !port.url) continue;
    const origin = new URL(port.url).origin;
    for (const kind of port.suggestions ?? []) if (!dismissed[origin]?.includes(kind)) suggestions.push({ tabId: port.tabId, origin, kind });
  }
  if (JSON.stringify(suggestions) !== JSON.stringify(view.suggestions)) publish({ suggestions });
}

// ---- Tweaks in tabs ----

// Each tab port says which page it shows; it gets that page's tweaks and
// the card that was open in the tab (kept per tab in storage.session, so it
// reopens in place after a reload), then every change to one of them. The
// card stays open as the tab navigates, so its tweak reaches the tab too,
// whatever page it's on (port.card).
const cardKey = (tabId) => `card-${tabId}`;

async function onTabMessage(port, msg) {
  const tabId = port.sender?.tab?.id;
  switch (msg.type) {
    case "page": {
      // A page says its suggestions once its HTML has loaded; a new page
      // has none until it does.
      if (Array.isArray(msg.suggestions)) port.suggestions = msg.suggestions;
      else if (pageOf(msg.url) !== port.page) port.suggestions = [];
      port.page = pageOf(msg.url);
      port.url = msg.url;
      publishSuggestions();
      await tweaksRestored;
      const key = cardKey(tabId);
      const { [key]: card = null } = await chrome.storage.session.get(key);
      if (!("card" in port)) port.card = card; // a card message since then is newer
      port.postMessage({ type: "tweaks", tweaks: forTab(tweakState, port), card: port.card, claimed: claimed(port.url) });
      break;
    }
    case "card":
      port.card = msg.number || null;
      if (msg.number) await chrome.storage.session.set({ [cardKey(tabId)]: msg.number });
      else await chrome.storage.session.remove(cardKey(tabId));
      break;
    case "capture":
      capture(port, msg);
      break;
    case "drop":
      port.shots.delete(msg.id);
      break;
    case "create":
    case "reply":
    case "again":
    case "undo": {
      const answered = { create: "created", reply: "replied", again: "resent", undo: "undid" }[msg.type];
      // The capture stays here: the bridge gets the PNG once it has a number.
      const { shot, ...request } = msg;
      const held = shot && port.shots.get(shot.id);
      const png = held ? render(held, shot.rects ?? []) : null;
      const ref = bridge.request(request, (answer) => {
        if (msg.type === "create" && answer.number) {
          rememberSender(answer.number, tabId);
          if (png) {
            port.shots.delete(shot.id);
            upload(answer.number, png);
          }
        }
        port.postMessage({ type: answered, ref: msg.ref, ...answer });
      });
      if (ref) port.onDisconnect.addListener(() => bridge.pending.forget(ref));
      break;
    }
  }
}

// ---- Screenshots ----

// design.md § Screenshot: the tab hides its overlay and asks; the capture is
// the viewport in device pixels, held by the tab's port until the tweak is
// sent (then cropped, outlined and uploaded) or dropped. Captures queue to
// stay inside Chrome's two a second. Without <all_urls> or activeTab on the
// tab, Chrome refuses, and the tweak goes without one.
const pace = paced();
const HELD = 2; // captures held per tab: the composer's, and a pick replacing it

async function capture(port, { id, viewport }) {
  let ok = false;
  try {
    const tab = await chrome.tabs.get(port.tabId);
    if (!tab.active) throw new Error("the tab isn't the one shown");
    const dataUrl = await pace(() => chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }));
    port.shots.set(id, { dataUrl, viewport });
    for (const old of [...port.shots.keys()].slice(0, -HELD)) port.shots.delete(old);
    ok = true;
  } catch (e) {
    console.info("Codaset Tweak: no screenshot:", e.message);
  }
  try {
    port.postMessage({ type: "captured", id, ok });
  } catch {
    port.shots.delete(id); // the tab went meanwhile
  }
}

// render crops the capture to what was pointed at, outlines it and scales
// it (lib/screenshot.js), resolving with the PNG, or null.
async function render({ dataUrl, viewport }, rects) {
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const f = frame(rects, viewport, bitmap);
    const canvas = new OffscreenCanvas(f.size.width, f.size.height);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, f.crop.x, f.crop.y, f.crop.width, f.crop.height, 0, 0, f.size.width, f.size.height);
    bitmap.close();
    draw(ctx, f);
    return await canvas.convertToBlob({ type: "image/png" });
  } catch (e) {
    console.warn("Codaset Tweak: couldn't process the screenshot", e);
    return null;
  }
}

// upload is PUT /tweaks/:n/screenshot, to the socket's host. Without a host
// grant it's a CORS request, which the bridge approves for this path.
async function upload(number, png) {
  const blob = await png;
  if (!blob) return;
  try {
    const r = await fetch(`http://127.0.0.1:${await bridgePort()}/tweaks/${number}/screenshot`, {
      method: "PUT",
      headers: { "x-tweak": "1", "x-tweak-protocol": String(PROTOCOL), "content-type": "image/png" },
      body: blob,
    });
    if (!r.ok) console.warn(`Codaset Tweak: the bridge refused tweak ${number}'s screenshot`, r.status, await r.text());
  } catch (e) {
    console.warn(`Codaset Tweak: couldn't upload tweak ${number}'s screenshot`, e.message);
  }
}

// claimed says whether any claim covers a URL: a tab whose page none does
// goes dormant (no picker, no pins).
const claimed = (url) => claimState.claims.some((c) => matches(c.pattern, url));

async function restoreTweaks() {
  await selfUpdate.restored;
  const { tweaks = [], senders: sent = {} } = await chrome.storage.session.get(["tweaks", "senders"]).catch(() => ({}));
  if (tweakState.seq === 0) tweakState = applyTweaks(undefined, { type: "snapshot", seq: 0, tweaks });
  for (const [n, tabId] of Object.entries(sent)) if (!senders.has(Number(n))) senders.set(Number(n), tabId);
}

function rememberSender(number, tabId) {
  if (tabId === undefined) return;
  senders.set(number, tabId);
  saveSenders();
}
const saveSenders = () => chrome.storage.session.set({ senders: Object.fromEntries(senders) });

function adoptTweaks(next, msg) {
  const was = tweakState;
  tweakState = next;
  chrome.storage.session.set({ tweaks: [...next.tweaks.values()] });
  const shown = [...tabs].filter((port) => port.page);
  for (const port of shown) {
    if (msg.type === "snapshot") port.postMessage({ type: "tweaks", tweaks: forTab(next, port), claimed: claimed(port.url) });
    else if (reachesTab(msg.tweak, port)) port.postMessage({ type: "tweak", tweak: msg.tweak, event: msg.event });
  }
  if (msg.type === "snapshot") {
    // Only open tweaks can still ask, so the rest are forgotten.
    const before = senders.size;
    for (const n of senders.keys()) if (!next.tweaks.has(n)) senders.delete(n);
    if (senders.size !== before) saveSenders();
    return;
  }
  // A new question: it carries the tweak, as the sending tab may be on another page.
  const { open, toast } = askedIn(was.tweaks.get(msg.tweak.number), msg.tweak, shown, senders.get(msg.tweak.number));
  for (const port of open) port.postMessage({ type: "asked", tweak: msg.tweak });
  for (const port of toast) port.postMessage({ type: "asked", tweak: msg.tweak, toast: true });
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
      // Closed on purpose: close() has dropped its requests already, and
      // those waiting now belong to the socket that replaced it.
      if (this.ws !== conn) return;
      this.pending.dropAll(NOT_CONNECTED);
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
    this.pending.dropAll(NOT_CONNECTED); // now, not on the close event: a new socket may be sending by then
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
