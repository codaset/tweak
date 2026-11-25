// The page probe, in the page's own world, at document_start: it never draws
// anything. It answers questions from the content script through CustomEvents
// on document carrying JSON strings with request IDs, never through
// attributes written onto the page. The page can see and spoof this traffic;
// the answers are only data describing elements. Framework metadata and HMR
// signals come later; for now it answers "ping".
(() => {
  const GUARD = Symbol.for("codaset-tweak.probe");
  if (window[GUARD]) return; // registration and executeScript can both run it
  Object.defineProperty(window, GUARD, { value: true });

  const answer = (id, body) =>
    document.dispatchEvent(new CustomEvent("codaset-tweak:answer", { detail: JSON.stringify({ id, ...body }) }));

  document.addEventListener("codaset-tweak:ask", (e) => {
    let q;
    try {
      q = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (q?.what === "ping") answer(q.id, { ready: true });
  });
})();
