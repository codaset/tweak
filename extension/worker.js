// The service worker: the bridge WebSocket, content-script registration, the
// badge, and relaying to the side panel and tabs (docs/design.md, "Chrome
// extension"). Every chrome.* listener is added synchronously at the top
// level, so events that wake the worker reach it.
import { plan, CONTENT_FILES, PROBE_FILES } from "./lib/registrations.js";
import { retryDelay } from "./lib/backoff.js";
import { apply, coverOf, heldBy, registered } from "./lib/claims.js";
import { GREY, badge, claimedBefore, tabBadge } from "./lib/badge.js";
import { toolbar } from "./lib/toolbar.js";
import { nextStatus } from "./lib/status.js";
import { DEFAULT_PORT, PROTOCOL, validPort } from "./lib/bridge.js";
import { createSelfUpdate, reloadedFor } from "./self-update.js";
import { applyTweaks, askedIn, askedSince, forTab, pageOf, prune, reachesTab, resolvedList } from "./lib/tweaks.js";
import { requests } from "./lib/requests.js";
import { draw, frame, paced } from "./lib/screenshot.js";

const KEEPALIVE_MS = 20_000; // WebSocket traffic keeps the worker awake (Chrome 116+)
const ALARM = "reconnect";
const ALL_URLS = { origins: ["<all_urls>"] };
const NOT_CONNECTED = "Not connected to Tweak";

// What the side panel shows (see lib/status.js for connection and message).
const view = { connection: "connecting", message: "", port: DEFAULT_PORT, granted: false, claims: [], lapsed: [], update: null, suggestions: [], sites: [], resolved: [], gone: [] };
// The claims (held and lapsed) as of event seq, from the bridge or, until it
// answers, the cache.
let claimState = { seq: 0, claims: [], lapsed: [] };
let heardFromBridge = false; // once true, the cache is out of date
// The open tweaks as of event seq. Kept in storage.session too, so pins and
// cards survive a worker restart while the bridge is down.
let tweakState = applyTweaks(undefined, { type: "snapshot", seq: 0, tweaks: [] });
// The tab each tweak was sent from, by number: its question pops up there
// (askedIn). Kept in storage.session too, so a worker restart keeps it.
const senders = new Map();
// What each tab's badge was last set to (showBadge), by tab ID.
const badges = new Map();
let badgeRun = Promise.resolve();

// ---- Listeners ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU, title: "Open side panel", contexts: ["action"] }, () => void chrome.runtime.lastError);
  restoreFromCache();
});
chrome.runtime.onStartup.addListener(() => restoreFromCache());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  bridge.connect();
  pruneTweaks(); // resolved tweaks the bridge has deleted since
});
chrome.permissions.onAdded.addListener(async () => {
  await refreshAccess();
  // Registrations didn't inject before the grant: give open tabs the scripts.
  injectIntoOpenTabs(registered(claimState));
});
chrome.permissions.onRemoved.addListener(() => refreshAccess());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "port" in changes) bridge.reconnect();
  if (area === "local" && "dismissed" in changes) {
    dismissed = changes.dismissed.newValue ?? {};
    publishSuggestions();
  }
});
// The toolbar button and its shortcuts (design.md § Toolbar button). Each
// handler opens the side panel, when it does, before any await: the gesture
// sidePanel.open needs ends with the listener's first turn.
chrome.action.onClicked.addListener((tab) => pickMode(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU && tab) openSidePanel(tab).catch(warnPanel);
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) return;
  if (command === "pick-mode") pickMode(tab);
  else if (command === "side-panel") openSidePanel(tab).catch(warnPanel);
  else if (command === "pins") togglePins(tab);
});
// Chrome keeps a tab's badge across navigation: recomputed as the tab moves.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if ("url" in change || change.status === "loading") {
    badges.delete(tabId);
    showBadge();
  }
});
chrome.runtime.onConnect.addListener((port) => {
  const ports = { panel: panels, tab: tabs }[port.name];
  if (!ports) return;
  ports.add(port);
  port.tabId = port.sender?.tab?.id;
  port.shots = new Map(); // a tab's captures, held until Send or drop
  port.dropped = new Set(); // ids dropped while still being captured
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    port.shots.clear();
    if (port.url) publishSuggestions();
    if (port.gone?.length) publishGone();
  });
  if (port.name === "tab") port.onMessage.addListener((msg) => onTabMessage(port, msg));
  if (port.name === "panel") port.onMessage.addListener((msg) => onPanelMessage(port, msg));
  port.postMessage(port.name === "panel" ? panelMessage() : tabMessage());
  if (port.name === "tab") selfUpdate.watchTab(port);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  badges.delete(tabId);
  chrome.storage.session.remove([cardKey(tabId), draftKey(tabId)]);
});
// A tab asks for the side panel: an ⌥-click while the bridge is down. Sent
// with runtime.sendMessage from the click, whose user gesture
// sidePanel.open needs; it's called first, while the gesture lasts.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "side-panel" && sender.tab) openSidePanel(sender.tab).catch(warnPanel);
});

// ---- The toolbar button, its menu and the shortcuts ----

const MENU = "side-panel";
const warnPanel = (e) => console.warn("Codaset Tweak: couldn't open the side panel", e.message);

// openSidePanel opens the window's one side panel, which follows its active
// tab. Called first in its handler, while the gesture lasts: the context
// menu, ⌥⇧N, and the toolbar button where there's nothing to pick. The e2e
// test copy calls the handlers by message.
function openSidePanel(tab) {
  return chrome.sidePanel.open({ windowId: tab.windowId });
}

const tabPort = (tabId) => [...tabs].find((p) => p.tabId === tabId);
const down = () => view.connection === "disconnected" || view.connection === "refused";

// pickMode is the toolbar click and ⌥⇧C (lib/toolbar.js): pick mode on a
// claimed page, else the side panel. A claimed page the scripts don't run
// on yet (only the click's activeTab reaches it) gets them now, then picks.
function pickMode(tab) {
  const port = tabPort(tab.id);
  const action = toolbar({ down: down(), url: port?.url ?? tab.url, hasScripts: Boolean(port), claimed });
  if (action === "side-panel") return openSidePanel(tab).catch(warnPanel);
  if (action === "pick") return port.postMessage({ type: "pick-mode" });
  return inject(tab.id).then(() =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.codasetTweak?.picker?.toggleMode(true) }).catch(() => {}),
  );
}

// togglePins is ⌥⇧H: the tab's site's pins hide or show, remembered in
// storage.local's pinsHidden {origin: true}, which the tabs and the side
// panel read. Local, so it works while the bridge is down too.
async function togglePins(tab) {
  const url = tabPort(tab.id)?.url ?? tab.url;
  if (!url) return;
  const origin = new URL(url).origin;
  const { pinsHidden = {} } = await chrome.storage.local.get("pinsHidden");
  const hidden = !pinsHidden[origin];
  if (hidden) pinsHidden[origin] = true;
  else delete pinsHidden[origin];
  await chrome.storage.local.set({ pinsHidden });
  tabPort(tab.id)?.postMessage({ type: "pins", hidden });
}

const panels = new Set();
const tabs = new Set();
const panelMessage = () => ({ type: "state", ...view });
const tabMessage = () => ({ type: "state", connection: view.connection });

function publish(changes) {
  const was = view.connection;
  Object.assign(view, changes);
  if (view.connection !== was) showBadge();
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

// The panel also shows the per-site reload setting for the tab in front,
// when its page runs the content script: sites are {tabId, origin}.
async function publishSuggestions() {
  await dismissedRead;
  const suggestions = [];
  const sites = [];
  for (const port of tabs) {
    if (port.tabId === undefined || !port.url) continue;
    const origin = new URL(port.url).origin;
    sites.push({ tabId: port.tabId, origin });
    for (const kind of port.suggestions ?? []) if (!dismissed[origin]?.includes(kind)) suggestions.push({ tabId: port.tabId, origin, kind });
  }
  const changes = {};
  if (JSON.stringify(suggestions) !== JSON.stringify(view.suggestions)) changes.suggestions = suggestions;
  if (JSON.stringify(sites) !== JSON.stringify(view.sites)) changes.sites = sites;
  if (Object.keys(changes).length) publish(changes);
}

// ---- Pins whose element is gone ----

// The side panel lists, for the tab in front, the tweaks whose pin has no
// element on its page: gone is [{tabId, number, request, status}].
function publishGone() {
  const gone = [];
  for (const port of tabs) {
    for (const number of port.gone ?? []) {
      const t = tweakState.tweaks.get(number);
      if (t && port.tabId !== undefined) gone.push({ tabId: port.tabId, number, request: t.entries?.find((e) => e.kind === "request")?.text ?? "", status: t.status });
    }
  }
  if (JSON.stringify(gone) !== JSON.stringify(view.gone)) publish({ gone });
}

// ---- Tweaks in tabs ----

// Each tab port says which page it shows; it gets that page's tweaks and
// the card that was open in the tab (kept per tab in storage.session, so it
// reopens in place after a reload), then every change to one of them. The
// card stays open as the tab navigates, so its tweak reaches the tab too,
// whatever page it's on (port.card).
const cardKey = (tabId) => `card-${tabId}`;
// And its drafts, kept as you type so they survive a reload:
// {compose: {page, kind, selectors, anchor, selection?, whole?, area?, text} | null,
// replies: {[number]: {text, question}}}, question being which of the
// tweak's questions the reply answers.
const draftKey = (tabId) => `draft-${tabId}`;

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
      const { [key]: card = null, [draftKey(tabId)]: draft = null } = await chrome.storage.session.get([key, draftKey(tabId)]);
      if (!("card" in port)) port.card = card; // a card message since then is newer
      port.postMessage({ type: "tweaks", tweaks: tweaksFor(port), card: port.card, draft, ...cover(port.url) });
      break;
    }
    case "card":
      port.card = msg.number || null;
      if (msg.number) await chrome.storage.session.set({ [cardKey(tabId)]: msg.number });
      else await chrome.storage.session.remove(cardKey(tabId));
      break;
    case "draft":
      // The tab's drafts as you type them, or null once none is left;
      // after the self-update's restore, which would put an older copy back.
      await tweaksRestored;
      if (msg.draft) await chrome.storage.session.set({ [draftKey(tabId)]: msg.draft });
      else await chrome.storage.session.remove(draftKey(tabId));
      break;
    case "gone":
      // The tab's pins whose element isn't on the page: the side panel lists them.
      port.gone = msg.numbers;
      publishGone();
      break;
    case "capture":
      capture(port, msg);
      break;
    case "drop":
      if (!port.shots.delete(msg.id)) port.dropped.add(msg.id); // the tab gave up waiting
      break;
    case "create":
    case "reply":
    case "again":
    case "undo":
    case "withdraw":
    case "resolve": {
      const answered = { create: "created", reply: "replied", again: "resent", undo: "undid", withdraw: "withdrew", resolve: "resolved" }[msg.type];
      // The capture stays here: the bridge gets the PNG once it has a number.
      const { shot, ...request } = msg;
      const held = shot && port.shots.get(shot.id);
      const png = held ? render(held, shot.rects ?? []) : null;
      // screenshot: true has a brief fetched before the upload wait for it.
      const ref = bridge.request(png ? { ...request, screenshot: true } : request, (answer) => {
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
    // captureVisibleTab takes whatever tab its window shows, so the sender
    // must be that tab when the queued call runs, and still after it: a
    // capture of another tab is never kept.
    const shown = async () => {
      const tab = await chrome.tabs.get(port.tabId);
      if (!tab.active) throw new Error("the tab isn't the one shown");
      return tab;
    };
    const dataUrl = await pace(async () => {
      const { windowId } = await shown();
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const [front] = await chrome.tabs.query({ active: true, windowId });
      if (front?.id !== port.tabId) throw new Error("the tab changed while it was captured");
      return url;
    });
    if (port.dropped.delete(id)) return; // too late: the tab went on without it
    port.shots.set(id, { dataUrl, viewport });
    for (const old of [...port.shots.keys()].slice(0, -HELD)) port.shots.delete(old);
    ok = true;
  } catch (e) {
    console.info("Codaset Tweak: no screenshot:", e.message);
    port.dropped.delete(id);
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

// The side panel's messages: Undo (or Ask Claude to undo) on a resolved
// tweak in its list, answered as the card's is; and Show on a gone pin,
// which opens its card in that tab.
function onPanelMessage(port, msg) {
  if (msg.type === "show") tabPort(msg.tabId)?.postMessage({ type: "show", number: msg.number });
  if (msg.type !== "undo") return;
  const ref = bridge.request({ type: "undo", number: msg.number }, (answer) => port.postMessage({ type: "undid", ref: msg.ref, ...answer }));
  if (ref) port.onDisconnect.addListener(() => bridge.pending.forget(ref));
}

// listed is the side panel's list of resolved tweaks: what each row shows.
const listed = (state) =>
  resolvedList(state).map(({ number, page, url, status, entries, change, resolvedAt, deleteAt }) => ({
    number,
    page,
    url,
    status,
    request: entries?.find((e) => e.kind === "request")?.text ?? "",
    change,
    resolvedAt,
    deleteAt,
  }));

// cover says whether a held claim covers a URL (claimed), or a lapsed one
// that can still come back (lapsed). A tab whose page neither does goes
// dormant (no picker, no pins); a lapsed one keeps its pins and cards.
function cover(url) {
  const { kind } = coverOf(claimState, url);
  return { claimed: kind === "claimed", lapsed: kind === "lapsed" };
}
// claimed says whether a held claim covers a URL: a lapsed page counts as
// unclaimed, so the toolbar opens the side panel there.
const claimed = (url) => coverOf(claimState, url).kind === "claimed";

// A tweak as tabs get it: with heldBy, the session holding its page and
// whether it's listening, which its card says (design.md § When the
// session goes quiet).
const forTabs = (tweak) => ({ ...tweak, heldBy: heldBy(claimState, tweak) });
const tweaksFor = (port) => forTab(tweakState, port).map(forTabs);

async function restoreTweaks() {
  await selfUpdate.restored;
  const { tweaks = [], resolved = [], senders: sent = {} } = await chrome.storage.session.get(["tweaks", "resolved", "senders"]).catch(() => ({}));
  if (tweakState.seq === 0) {
    tweakState = applyTweaks(undefined, { type: "snapshot", seq: 0, tweaks, resolved });
    publish({ resolved: listed(tweakState) });
  }
  for (const [n, tabId] of Object.entries(sent)) if (!senders.has(Number(n))) senders.set(Number(n), tabId);
}

function rememberSender(number, tabId) {
  if (tabId === undefined) return;
  senders.set(number, tabId);
  saveSenders();
}
const saveSenders = () => chrome.storage.session.set({ senders: Object.fromEntries(senders) });

// pruneTweaks drops the resolved tweaks past their deleteAt from the
// worker's copy and its cache in storage.session.
function pruneTweaks() {
  const next = prune(tweakState);
  if (next === tweakState) return;
  tweakState = next;
  saveTweaks(next);
}

function saveTweaks(state) {
  chrome.storage.session.set({ tweaks: [...state.tweaks.values()], resolved: [...state.resolved.values()] });
  const resolved = listed(state);
  if (JSON.stringify(resolved) !== JSON.stringify(view.resolved)) publish({ resolved });
}

function adoptTweaks(next, msg) {
  next = prune(next);
  const was = tweakState;
  tweakState = next;
  saveTweaks(next);
  showBadge();
  publishGone();
  const shown = [...tabs].filter((port) => port.page);
  for (const port of shown) {
    if (msg.type === "snapshot") port.postMessage({ type: "tweaks", tweaks: tweaksFor(port), ...cover(port.url) });
    else if (reachesTab(msg.tweak, port)) port.postMessage({ type: "tweak", tweak: forTabs(msg.tweak), event: msg.event });
  }
  // A new question: it carries the tweak, as the sending tab may be on
  // another page. Those asked while the socket was down come in a snapshot,
  // compared with the cache (the hello waits for it to be read back).
  const asked =
    msg.type === "snapshot"
      ? askedSince(was, next, shown, senders)
      : [{ tweak: msg.tweak, ...askedIn(was.tweaks.get(msg.tweak.number), msg.tweak, shown, senders.get(msg.tweak.number)) }];
  for (const { tweak, open, toast } of asked) {
    for (const port of open) port.postMessage({ type: "asked", tweak: forTabs(tweak) });
    for (const port of toast) port.postMessage({ type: "asked", tweak: forTabs(tweak), toast: true });
  }
  if (msg.type === "snapshot") {
    // Only open tweaks can still ask, so the rest are forgotten.
    const before = senders.size;
    for (const n of senders.keys()) if (!next.tweaks.has(n)) senders.delete(n);
    if (senders.size !== before) saveSenders();
  }
}

// ---- Site access and the badge ----

async function refreshAccess() {
  const granted = await chrome.permissions.contains(ALL_URLS);
  publish({ granted });
  await showBadge();
  return granted;
}

// showBadge is the one place the badge is set (lib/badge.js): the grey "!"
// in every tab until access is granted or while the bridge is down, else
// each tab's own. It's called on every change to the connection, access,
// claims or a tweak, and as a tab navigates. badges holds what each tab was
// last given, so only changes reach Chrome; null is the global badge.
function showBadge() {
  badgeRun = badgeRun.then(drawBadges).catch((e) => console.warn("Codaset Tweak: badge", e.message));
  return badgeRun;
}

async function drawBadges() {
  const b = badge(view);
  if (!b) return;
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setBadgeText({ text: b.text });
  const { claimedOrigins: before = [] } = b.perTab ? await chrome.storage.local.get("claimedOrigins") : {};
  for (const tab of await chrome.tabs.query({})) {
    // null falls back to the global badge.
    const want = b.perTab ? tabBadge({ url: tab.url, claims: claimState.claims, tweaks: tweakState.tweaks, before }) : null;
    const key = want && `${want.text} ${want.color}`;
    if (badges.has(tab.id) && badges.get(tab.id) === key) continue;
    badges.set(tab.id, key);
    // The global colour is always grey, so a tab falling back to it is too.
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: want?.color ?? GREY }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: tab.id, text: want ? want.text : null }).catch(() => {});
  }
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
    for (const tab of open) await inject(tab.id);
  }
}

// inject runs a claim's scripts in a tab's top frame.
function inject(tabId) {
  const target = { tabId };
  return chrome.scripting
    .executeScript({ target, files: PROBE_FILES, world: "MAIN", injectImmediately: true })
    .then(() => chrome.scripting.executeScript({ target, files: CONTENT_FILES }))
    .catch((e) => console.warn(`Codaset Tweak: couldn't inject into tab ${tabId}`, e.message));
}

// Chrome wipes runtime registrations on install and update, so the
// last-known claims are registered again at once, before the bridge answers.
async function restoreFromCache() {
  const { claims: cached = [], lapsed = [] } = await chrome.storage.local.get(["claims", "lapsed"]);
  if (!heardFromBridge) claimState = { seq: 0, claims: cached, lapsed };
  await syncRegistrations(registered(claimState));
}

// adoptClaims takes the bridge's claims: shows them in the panel, caches
// them in storage.local and brings the registrations in line. A tab hears
// whether its page is claimed, and its tweaks again, as whether a session
// is listening may have changed what their cards say.
async function adoptClaims(next) {
  claimState = next;
  heardFromBridge = true;
  for (const port of tabs) {
    if (port.page) port.postMessage({ type: "tweaks", tweaks: tweaksFor(port), ...cover(port.url) });
    else if (port.url) port.postMessage({ type: "claimed", ...cover(port.url) });
  }
  publish({ claims: next.claims, lapsed: next.lapsed });
  // Their origins are remembered: once released, the badge's grey "!" still
  // marks them as dev servers.
  const { claimedOrigins = [] } = await chrome.storage.local.get("claimedOrigins");
  const origins = claimedBefore(claimedOrigins, next.claims);
  await chrome.storage.local.set({ claims: next.claims, lapsed: next.lapsed, ...(origins !== claimedOrigins ? { claimedOrigins: origins } : {}) });
  showBadge();
  await syncRegistrations(registered(next));
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
    const [port, reloaded] = await Promise.all([bridgePort(), reloadedFor()]);
    if (this.ws !== conn) return; // closed or replaced meanwhile
    setStatus({ type: "connecting" }, { port });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    conn.socket = ws;

    ws.onopen = async () => {
      // The snapshot is compared with the cached tweaks and their senders
      // (questions asked meanwhile pop up), so those are read back first.
      await tweaksRestored;
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, lastSeq: 0, version: chrome.runtime.getManifest().version, reloadedFor: reloaded }));
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
