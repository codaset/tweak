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

function render(state) {
  $("status").dataset.connection = state.connection;
  $("status-text").textContent = STATUS[state.connection] ?? STATUS.disconnected;
  $("access").hidden = state.granted;

  const down = state.connection === "disconnected" || state.connection === "refused";
  $("not-connected").hidden = !down;
  $("refusal").hidden = state.connection !== "refused";
  $("refusal").textContent = state.message;
  $("start-hint").hidden = state.connection === "refused";

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
  const note = { updated: `Updated to ${update?.version}`, waiting: `Updating to ${update?.version} once you've finished` }[update?.state];
  $("update-note").hidden = !note;
  $("update-note").textContent = note ?? "";

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
