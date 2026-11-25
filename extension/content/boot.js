// The content script's last file: starts the pieces the earlier files
// defined, once the document has a body, and marks this copy ready.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;
  ns.ready = true;

  const start = () => {
    ns.overlay.attach();
    ns.worker.connect();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
