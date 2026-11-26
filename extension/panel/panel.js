// The side panel: a view only. It shows the worker's state, which arrives
// over a port named "panel", and holds none of its own. The port field writes
// chrome.storage.local, which the worker watches. Its one request, Undo on a
// resolved tweak, goes through the same port.
import { DEFAULT_PORT, validPort } from "../lib/bridge.js";
import { ago, coverOf } from "../lib/claims.js";

// The card's own wording (content/describe.js, loaded before this module).
const describe = globalThis.codasetTweak.describe;

const $ = (id) => document.getElementById(id);

const STATUS = {
  connecting: "Connecting to Tweak…",
  connected: "Connected to Tweak",
  disconnected: "Not connected to Tweak",
  refused: "Tweak refused this extension",
};

// The panel follows its window's active tab: suggestions are about it, and
// so are the resolved tweaks, by the tab's site when its URL can be read
// (with site access granted), else all of them.
let activeTab = null;
let activeURL = ""; // its URL, which the claim status is about
let last = null; // the worker's last state, drawn again when the tab changes
let pinsHidden = {}; // storage.local's, below
let autoReload = {}; // storage.local's, below

function render(state) {
  last = state;
  $("status").dataset.connection = state.connection;
  $("status-text").textContent = STATUS[state.connection] ?? STATUS.disconnected;
  $("access").hidden = state.granted;

  const down = state.connection === "disconnected" || state.connection === "refused";
  $("not-connected").hidden = !down;
  $("refusal").hidden = state.connection !== "refused";
  $("refusal").textContent = state.message;
  $("start-hint").hidden = state.connection === "refused";
  $("command").textContent = `/tweak ${activeOrigin ?? "<your dev server's URL>"}`;

  $("claims").hidden = state.connection !== "connected" || state.claims.length === 0;
  $("claim-list").replaceChildren(
    ...state.claims.map((c) => {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = c.pattern;
      li.append(code);
      return li;
    }),
  );

  const update = state.update;
  $("another-folder").hidden = update?.state !== "stuck";
  $("extension-folder").textContent = update?.folder ?? "~/.local/state/codaset-tweak/extension";
  const note = { updated: `Updated to ${update?.version}`, waiting: `Updating to ${update?.version} once you've finished` }[update?.state];
  $("update-note").hidden = !note;
  $("update-note").textContent = note ?? "";

  renderCover(state);

  // Optional improvements for the tab in front; each kind has its section.
  const here = (state.suggestions ?? []).filter((s) => s.tabId === activeTab);
  for (const section of document.querySelectorAll(".suggestion")) {
    const suggestion = here.find((s) => s.kind === section.id);
    section.hidden = !suggestion;
    section.dataset.origin = suggestion?.origin ?? "";
  }

  renderResolved(state);
  // The reload setting for the site in front, when it runs Tweak.
  const site = (state.sites ?? []).find((s) => s.tabId === activeTab)?.origin ?? "";
  $("reload-setting").hidden = !site;
  $("reload-setting").dataset.origin = site;
  $("reload-site").textContent = site.replace(/^https?:\/\//, "");
  $("auto-reload").checked = autoReload[site] !== false;

  // The tab in front: whether a session claims it, with the command to
  // claim it when none does (design.md § Claims; a lapsed claim has its own
  // section, above), its site's pins switch where pins can show, and its
  // tweaks whose pin has no element on the page.
  const kind = activeOrigin === null ? "none" : coverOf(state, activeURL).kind;
  $("unclaimed").hidden = state.connection !== "connected" || activeOrigin === null || kind !== "none";
  $("unclaimed-command").textContent = `/tweak ${activeOrigin ?? ""}`;
  $("pins-setting").hidden = kind === "none";
  $("pins-setting").dataset.origin = activeOrigin ?? "";
  $("pins-site").textContent = (activeOrigin ?? "").replace(/^https?:\/\//, "");
  $("pins-shown").checked = !pinsHidden[activeOrigin];
  const gone = (state.gone ?? []).filter((g) => g.tabId === activeTab);
  $("gone").hidden = gone.length === 0;
  renderGone(gone);

  const input = $("port");
  if (document.activeElement !== input) input.value = state.port === DEFAULT_PORT ? "" : String(state.port);
}

// ---- Resolved tweaks ----

// The tweaks resolved or withdrawn, newest first, each with what it
// changed and its Undo (or where an undo stands), until they're deleted.
// An Undo on its way: number -> {ref, state, error}, from the click until
// the tweak's change moves on from state (or the answer is a refusal).
const undos = new Map();
let refs = 0;
let expiry = 0;
let port = null;

function renderResolved(state) {
  const now = Date.now();
  const site = /^https?:/.test(activeOrigin ?? "") ? activeOrigin : "";
  const list = (state.resolved ?? []).filter((t) => (!site || describe.origin(t.url) === site) && (!t.deleteAt || Date.parse(t.deleteAt) > now));
  for (const t of state.resolved ?? []) if (undos.get(t.number)?.state !== t.change?.state) undos.delete(t.number);
  $("resolved").hidden = list.length === 0;
  // While the bridge is down the list stays, faded, and Undo is refused.
  $("resolved").classList.toggle("offline", state.connection === "disconnected" || state.connection === "refused");
  // Rows are rebuilt only when what they show changes, and the focus is
  // kept on the same control of a rebuilt row.
  const focused = document.activeElement?.closest?.("#resolved-list li") ? document.activeElement.dataset.focus : "";
  const ul = $("resolved-list");
  const old = new Map([...ul.children].map((li) => [li.dataset.key, li]));
  const rows = list.map((t) => {
    const inFlight = undos.get(t.number);
    const key = JSON.stringify([t, inFlight ?? null, state.connection, describe.kept(t, now)]);
    return old.get(key) ?? resolvedRow(t, inFlight, state.connection === "connected", now, key);
  });
  ul.replaceChildren(...rows);
  if (focused) ul.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  // Drawn again when the next one goes, or its "kept for" moves on.
  clearTimeout(expiry);
  const next = Math.min(...list.map((t) => Date.parse(t.deleteAt) - now).filter((ms) => ms > 0), 60_000);
  if (list.length) expiry = setTimeout(() => last && render(last), Math.max(next, 50));
}

function resolvedRow(t, inFlight, connected, now, key) {
  const el = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const li = el("li", `tweak tone-${describe.status(t).tone}`);
  li.dataset.key = key;
  li.dataset.number = String(t.number);
  const head = el("div", "tweak-head");
  head.append(el("span", "tweak-number", `Tweak ${t.number}`), el("span", "tweak-status", describe.status(t).text));
  li.append(head);
  if (t.request) li.append(el("p", "tweak-request", t.request));
  const where = el("p", "tweak-where");
  try {
    where.textContent = new URL(t.page).pathname;
  } catch {
    where.textContent = t.page;
  }
  li.append(where);

  const c = describe.change(t);
  if (c) {
    const files = el("p", "tweak-change");
    files.append(el("span", "", c.files.length ? c.announce : c.title));
    if (c.files.length) files.title = c.files.map((f) => f.path).join("\n");
    li.append(files);
  }
  const u = describe.undo(t);
  if (u) {
    const row = el("div", `tweak-undo undo-${u.kind}`);
    if (u.kind === "offer") {
      const button = el("button", "secondary", inFlight && !inFlight.error ? (u.label === "Undo" ? "Undoing…" : "Asking Claude…") : u.label);
      button.type = "button";
      button.dataset.focus = `undo-${t.number}`;
      button.disabled = !connected;
      button.setAttribute("aria-disabled", String(Boolean(inFlight && !inFlight.error)));
      button.setAttribute("aria-label", `${u.label}: tweak ${t.number}`);
      button.addEventListener("click", () => undo(t, button));
      row.append(button);
      if (u.note) row.append(el("span", "note", u.note));
      const why = inFlight?.error || (connected ? "" : "Not connected to Tweak");
      if (why) {
        const error = el("p", "error", why);
        error.setAttribute("role", "alert");
        row.append(error);
      }
    } else if (u.kind === "waiting") {
      row.append(el("p", "", u.text));
      const command = el("div", "command");
      const code = el("code", "", u.command);
      const copy = el("button", "copy", "Copy");
      copy.type = "button";
      copy.dataset.focus = `copy-${t.number}`;
      copy.setAttribute("aria-label", `Copy the command for tweak ${t.number}`);
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(u.command);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
      command.append(code, copy);
      row.append(command);
    } else row.append(el("p", "", u.text));
    li.append(row);
  }
  const kept = describe.kept(t, now);
  if (kept) li.append(el("p", "note tweak-kept", u?.kind === "offer" ? `${kept}, with Undo` : kept));
  return li;
}

function undo(t, button) {
  if (!port || button.disabled || button.getAttribute("aria-disabled") === "true") return;
  const ref = `p${++refs}`;
  undos.set(t.number, { ref, state: t.change?.state });
  port.postMessage({ type: "undo", ref, number: t.number });
  if (last) render(last);
}

// undid is the answer to an Undo: under way (the tweak's next state shows
// where it stands), or refused with why.
function undid(msg) {
  for (const [number, u] of undos) {
    if (u.ref === msg.ref && !msg.number) undos.set(number, { ...u, error: msg.message || msg.error || "Couldn't undo it" });
  }
  if (last) render(last);
}

// The claim status of the tab in front: when its page's session stopped
// responding (design.md § When the session goes quiet), who, how long ago,
// and the command that claims it from another session. The time ticks on
// unannounced; the live region says only that the session stopped.
let said = "";
function renderCover(state) {
  const cover = activeURL && state.connection === "connected" ? coverOf(state, activeURL) : { kind: "none" };
  const lapsed = cover.kind === "lapsed";
  $("lapsed").hidden = !lapsed;
  const say = lapsed ? `The session in ${cover.folder} stopped responding` : "";
  if (say !== said) $("page-said").textContent = said = say;
  if (!lapsed) return;
  $("lapsed-folder").textContent = cover.folder;
  $("lapsed-ago").textContent = ago(cover.lapsedAt);
  $("lapsed-command").textContent = `/tweak ${cover.pattern}`;
}
setInterval(() => last && renderCover(last), 15_000);

// ---- Pins whose element is gone ----

// Each gone pin's row: the tweak, its request, and Show, which opens its
// card on the page. Rows are kept by number, so the focus stays put.
function renderGone(gone) {
  const list = $("gone-list");
  const rows = new Map([...list.children].map((li) => [Number(li.dataset.number), li]));
  const wanted = gone.map((g) => {
    let li = rows.get(g.number);
    if (!li) {
      li = document.createElement("li");
      li.dataset.number = String(g.number);
      const head = document.createElement("span");
      head.className = "gone-title";
      const request = document.createElement("span");
      request.className = "gone-request";
      const show = document.createElement("button");
      show.type = "button";
      show.className = "show";
      show.textContent = "Show";
      show.addEventListener("click", () => port?.postMessage({ type: "show", tabId: activeTab, number: g.number }));
      li.append(head, request, show);
    }
    li.querySelector(".gone-title").textContent = `Tweak ${g.number}`;
    li.querySelector(".gone-request").textContent = g.request;
    li.querySelector(".show").setAttribute("aria-label", `Show tweak ${g.number}'s card`);
    return li;
  });
  if (wanted.length !== list.children.length || wanted.some((li, i) => list.children[i] !== li)) list.replaceChildren(...wanted);
}

// The worker can restart; reconnect when it does.
function listen() {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "state") render(msg);
    if (msg.type === "undid") undid(msg);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    for (const [number, u] of undos) if (!u.error) undos.set(number, { ...u, error: "Not connected to Tweak" });
    setTimeout(listen, 100);
  });
}
listen();

// The tab in front's origin, for the /tweak command: Chrome gives its URL
// only where the extension has access, which a page with Tweak's tools has.
let activeOrigin = null;
const originOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
};
function showTab(tab) {
  activeTab = tab?.id ?? null;
  activeOrigin = originOf(tab?.url);
  activeURL = tab?.url ?? "";
  if (last) render(last);
}

chrome.windows.getCurrent().then(async (win) => {
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  showTab(tab);
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId !== win.id) return;
    chrome.tabs.get(info.tabId).then(showTab, () => showTab({ id: info.tabId }));
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tabId === activeTab && "url" in change) showTab(tab);
  });
});

// Pins are shown unless hidden for a site: storage.local's pinsHidden is
// {origin: true}, which the tabs read.
chrome.storage.local.get("pinsHidden").then(({ pinsHidden: h = {} }) => {
  pinsHidden = h;
  if (last) render(last);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("pinsHidden" in changes)) return;
  pinsHidden = changes.pinsHidden.newValue ?? {};
  if (last) render(last);
});
$("pins-shown").addEventListener("change", async (e) => {
  const origin = $("pins-setting").dataset.origin;
  if (!origin) return;
  const { pinsHidden: h = {} } = await chrome.storage.local.get("pinsHidden");
  if (e.target.checked) delete h[origin];
  else h[origin] = true;
  await chrome.storage.local.set({ pinsHidden: h });
});

// Auto-reload is on unless turned off for a site: storage.local's
// autoReload is {origin: false}, which the tab reads when a change lands.
chrome.storage.local.get("autoReload").then(({ autoReload: a = {} }) => {
  autoReload = a;
  if (last) render(last);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("autoReload" in changes)) return;
  autoReload = changes.autoReload.newValue ?? {};
  if (last) render(last);
});
$("auto-reload").addEventListener("change", async (e) => {
  const origin = $("reload-setting").dataset.origin;
  if (!origin) return;
  const { autoReload: a = {} } = await chrome.storage.local.get("autoReload");
  if (e.target.checked) delete a[origin];
  else a[origin] = false;
  await chrome.storage.local.set({ autoReload: a });
});

// Dismissing a suggestion is remembered for its site, in storage.local,
// which the worker watches.
for (const button of document.querySelectorAll("[data-dismiss]")) {
  button.addEventListener("click", async () => {
    const kind = button.dataset.dismiss;
    const origin = $(kind).dataset.origin;
    if (!origin) return;
    const { dismissed = {} } = await chrome.storage.local.get("dismissed");
    dismissed[origin] = [...new Set([...(dismissed[origin] ?? []), kind])];
    await chrome.storage.local.set({ dismissed });
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText($(button.dataset.copy).textContent);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });
}

$("allow").addEventListener("click", () => {
  // First thing in the handler, while the click's gesture lasts.
  chrome.permissions.request({ origins: ["<all_urls>"] }).then((granted) => {
    $("allow-note").hidden = granted;
  });
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("command").textContent);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

$("port-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("port");
  const raw = input.value.trim();
  const port = raw === "" ? DEFAULT_PORT : Number(raw);
  const valid = validPort(port);
  input.setAttribute("aria-invalid", String(!valid));
  $("port-note").textContent = valid ? "Saved. Reconnecting…" : "Enter a port from 1 to 65535.";
  if (!valid) return;
  if (port === DEFAULT_PORT) await chrome.storage.local.remove("port");
  else await chrome.storage.local.set({ port });
  input.blur();
});
