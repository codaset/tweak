// The content script's first file. Content scripts registered at runtime
// can't be modules, so the files are classic scripts, run in order, sharing
// this one namespace object in the isolated world. Each file is wrapped in a
// function, so running the set twice (registration plus executeScript)
// declares nothing twice.
//
// The run-once guard: if a live copy already runs in this page, `ready` stays
// true and every later file returns at once. A copy left behind by an earlier
// load of the extension (its chrome.runtime.id is gone) is replaced.
//
// util holds the small helpers more than one file needs.
(() => {
  const existing = globalThis.codasetTweak;
  if (existing?.ready && existing.alive()) return;
  existing?.teardown?.();
  globalThis.codasetTweak = {
    ready: false,
    alive: () => Boolean(chrome.runtime?.id),
    teardowns: [],
    teardown() {
      for (const fn of this.teardowns.splice(0).reverse()) fn();
      if (globalThis.codasetTweak === this) delete globalThis.codasetTweak;
    },
    util: {
      // cut shortens s to n characters (code points), ending in … when longer.
      cut(s, n) {
        const cps = [...s];
        return cps.length > n ? `${cps.slice(0, n - 1).join("")}…` : s;
      },
      // pageKey is the page a tweak belongs to: origin and path, as the
      // query and hash don't change it.
      pageKey: () => `${location.origin}${location.pathname}`,
      // find is the first element a selector matches, or null, also for a
      // selector this page can't evaluate.
      find(selector) {
        try {
          return document.querySelector(selector);
        } catch {
          return null;
        }
      },
      // clamp keeps v within 0 and 1: a fraction of a box.
      clamp: (v) => Math.min(1, Math.max(0, v)),
    },
  };
})();
