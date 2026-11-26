// Marks: what a tweak points at, drawn on the page while its composer or
// card is open. Elements are outlined and numbered as the brief numbers
// them; selected text is highlighted line by line; an area is its box, with
// the element it's inside outlined faintly. The card draws them from the
// tweak's targets, the composer from its pick, every frame, so they follow
// the page as it scrolls and moves.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  let layer = null;
  const drawn = []; // one node per mark, reused frame to frame

  ns.marks = {
    // draw shows exactly these marks: {kind: "element" | "inside" | "text" |
    // "area", number?, hot?, x, y, width, height}, in viewport CSS pixels;
    // hot is the one whose row in the composer's list is pointed at.
    draw(items) {
      if (!ns.overlay.root) return;
      if (!layer) {
        layer = ns.overlay.el("div", "marks");
        layer.setAttribute("aria-hidden", "true");
        ns.overlay.root.prepend(layer);
      }
      while (drawn.length > items.length) drawn.pop().remove();
      items.forEach((m, i) => {
        let node = drawn[i];
        if (!node) {
          node = ns.overlay.el("div");
          node.append(ns.overlay.el("span", "mark-number"));
          layer.append(node);
          drawn[i] = node;
        }
        const cls = `mark kind-${m.kind}${m.hot ? " hot" : ""}`;
        if (node.className !== cls) node.className = cls;
        Object.assign(node.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.width}px`, height: `${m.height}px` });
        const badge = node.firstChild;
        const n = m.number ? String(m.number) : "";
        if (badge.textContent !== n) badge.textContent = n;
        badge.hidden = !n;
      });
    },
    clear() {
      this.draw([]);
    },
  };
  ns.teardowns.push(() => layer?.remove());
})();
