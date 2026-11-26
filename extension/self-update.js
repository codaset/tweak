// The worker's half of the self-update (docs/design.md, "The extension
// updates itself"). The bridge rewrites the extension folder at its own
// version; when the hello reply names another, the worker reloads itself
// with chrome.runtime.reload(), which re-reads an unpacked extension's files
// from disk. The decisions are in lib/update.js.
//
// Confirmed in Chrome for Testing 158 (unpacked, Developer mode on): a reload
// re-reads the files, fires onInstalled with reason "update", wipes runtime
// registrations and clears chrome.storage.session; storage.local is kept.
import { decide, justUpdated } from "./lib/update.js";

const STASH = "updateStash"; // storage.local: storage.session's contents across a reload
const EXPECTED = "updateExpected"; // storage.local: the version the last reload was for
const UPDATED = "updatedTo"; // storage.session: shown in the side panel
const TOAST_MS = 20_000; // tabs (re)injected this soon after the update get the toast

// createSelfUpdate returns the hooks the worker calls. publish(changes)
// updates the side panel's view; the view's `update` is
// {state: "updated" | "waiting" | "stuck", version, folder?} or null.
export function createSelfUpdate({ publish: publishView }) {
  const own = chrome.runtime.getManifest().version;
  // Every publish reaches every tab, so only a change is published.
  let lastUpdate = null;
  const publish = ({ update }) => {
    if (JSON.stringify(update) === JSON.stringify(lastUpdate)) return;
    lastUpdate = update;
    publishView({ update });
  };
  const tabs = new Map(); // tab port -> busy
  let bridge; // the version in the last hello reply
  let folder; // and where the bridge keeps that version
  let updatedAt = 0;
  let reloading = false;

  const toast = (port) => port.postMessage({ type: "updated", version: own });

  // Every start: put back what the reload cleared, then see whether this
  // start is the update landing.
  async function start() {
    const { [STASH]: stash, [EXPECTED]: expected } = await chrome.storage.local.get([STASH, EXPECTED]);
    if (stash) {
      await chrome.storage.session.set(stash);
      await chrome.storage.local.remove(STASH);
    }
    if (justUpdated({ own, expected })) {
      await chrome.storage.local.remove(EXPECTED);
      await chrome.storage.session.set({ [UPDATED]: own });
      updatedAt = Date.now();
      for (const port of tabs.keys()) toast(port);
    }
    const { [UPDATED]: shown } = await chrome.storage.session.get(UPDATED);
    if (shown) publish({ update: { state: "updated", version: shown } });
  }
  // Later readers of storage.session await this: until it settles, a draft
  // saved before the reload may not be back yet.
  const restored = start().catch((e) => console.error("Codaset Tweak: restoring after an update failed", e));

  async function check() {
    await restored;
    if (reloading) return;
    const { [EXPECTED]: expected } = await chrome.storage.local.get(EXPECTED);
    const busy = [...tabs.values()].some(Boolean);
    switch (decide({ own, bridge, expected, busy })) {
      case "current":
        if (expected) await chrome.storage.local.remove(EXPECTED);
        clearPending();
        break;
      case "wait":
        publish({ update: { state: "waiting", version: bridge } });
        break;
      case "stuck":
        publish({ update: { state: "stuck", version: own, folder } });
        break;
      case "reload": {
        reloading = true;
        const session = await chrome.storage.session.get(null);
        delete session[UPDATED];
        await chrome.storage.local.set({ [STASH]: session, [EXPECTED]: bridge });
        chrome.runtime.reload();
        break;
      }
    }
  }

  // A "waiting" or "stuck" line no longer applies; "updated" stays.
  async function clearPending() {
    const { [UPDATED]: shown } = await chrome.storage.session.get(UPDATED);
    publish({ update: shown ? { state: "updated", version: shown } : null });
  }

  const run = () => check().catch((e) => console.error("Codaset Tweak: self-update failed", e));

  return {
    restored,

    // bridgeVersion takes the version from each hello reply (none from a
    // development bridge), and the folder the bridge writes it to.
    bridgeVersion(version, extensionFolder) {
      bridge = version;
      folder = extensionFolder;
      run();
    },

    // watchTab follows a tab's port: {type: "busy", busy} holds the reload
    // back while true; a closed tab holds nothing.
    watchTab(port) {
      tabs.set(port, false);
      port.onMessage.addListener((msg) => {
        // A tab repeats its busy state after each state message, so a
        // restarted worker hears it; only a change matters.
        if (msg?.type !== "busy" || Boolean(msg.busy) === tabs.get(port)) return;
        tabs.set(port, Boolean(msg.busy));
        run();
      });
      port.onDisconnect.addListener(() => {
        tabs.delete(port);
        run();
      });
      if (updatedAt && Date.now() - updatedAt < TOAST_MS) toast(port);
    },
  };
}
