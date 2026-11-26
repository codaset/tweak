// The side panel: a view only. It shows the worker's state, which arrives
// over a port named "panel", and holds none of its own. The port field writes
// chrome.storage.local, which the worker watches.
import { DEFAULT_PORT, validPort } from "../lib/bridge.js";

const $ = (id) => document.getElementById(id);

const STATUS = {
  connecting: "Connecting to Tweak…",
  connected: "Connected to Tweak",
  disconnected: "Not connected to Tweak",
  refused: "Tweak refused this extension",
};

// The panel follows its window's active tab: suggestions are about it.
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

  const input = $("port");
  if (document.activeElement !== input) input.value = state.port === DEFAULT_PORT ? "" : String(state.port);
}

// The worker can restart; reconnect when it does.
function listen() {
  const port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener((msg) => msg.type === "state" && render(msg));
  port.onDisconnect.addListener(() => setTimeout(listen, 100));
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
