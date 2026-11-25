// The content script's first file. Content scripts registered at runtime
// can't be modules, so the files are classic scripts, run in order, sharing
// this one namespace object in the isolated world. Each file is wrapped in a
// function, so running the set twice (registration plus executeScript)
// declares nothing twice.
//
// The run-once guard: if a live copy already runs in this page, `ready` stays
// true and every later file returns at once. A copy left behind by an earlier
// load of the extension (its chrome.runtime.id is gone) is replaced.
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
  };
})();
