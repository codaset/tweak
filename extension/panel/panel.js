// The side panel: a view only. It shows the worker's state, which arrives
// over a port named "panel", and holds none of its own. The port field writes
// chrome.storage.local, which the worker watches. Its one request, Undo on a
// resolved tweak, goes through the same port.
import { DEFAULT_PORT, validPort } from "../lib/bridge.js";

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
let last = null; // the worker's last state, drawn again when the tab changes

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

  // Optional improvements for the tab in front; each kind has its section.
  const here = (state.suggestions ?? []).filter((s) => s.tabId === activeTab);
  for (const section of document.querySelectorAll(".suggestion")) {
    const suggestion = here.find((s) => s.kind === section.id);
    section.hidden = !suggestion;
    section.dataset.origin = suggestion?.origin ?? "";
  }

  renderResolved(state);

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
