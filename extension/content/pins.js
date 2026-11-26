// Pins: one per tweak on this page, at the point you clicked, coloured by
// status. A pin re-attaches by its element's selector, at the same fraction
// of the element's box, so it follows scrolling, resizing and reloads. A pin
// whose element is gone is hidden. Clicking one opens its card.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const pins = new Map(); // number -> {el, tweak, target}
  let layer = null;

  function find(tweak) {
    const sel = tweak.targets?.elements?.[0]?.selector;
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  ns.pins = {
    // render shows exactly these tweaks' pins.
    render(tweaks) {
      if (!ns.overlay.root) return;
      if (!layer) {
        layer = ns.overlay.el("div", "pins");
        ns.overlay.root.prepend(layer);
      }
      const wanted = new Set(tweaks.map((t) => t.number));
      for (const [n, p] of pins) {
        if (!wanted.has(n)) {
          p.el.remove();
          pins.delete(n);
        }
      }
      for (const tweak of tweaks) {
        let p = pins.get(tweak.number);
        if (!p) {
          const el = ns.overlay.el("button", "pin", String(tweak.number));
          el.type = "button";
          el.addEventListener("click", () => ns.panel.toggle(tweak.number, el));
          el.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && ns.panel.open()) {
              e.preventDefault();
              ns.panel.close();
            }
          });
          layer.append(el);
          p = { el, tweak, target: null };
          pins.set(tweak.number, p);
        }
        p.tweak = tweak;
        const { text } = ns.describe.status(tweak);
        p.el.className = `pin ${ns.describe.classes(tweak)}${ns.panel.showing() === tweak.number ? " open" : ""}`;
        p.el.title = `Tweak ${tweak.number}: ${text}`;
        p.el.setAttribute("aria-label", `Tweak ${tweak.number}: ${text}`);
      }
      this.position();
    },
    // point is where a tweak's pin sits in the viewport, or null if its
    // element isn't on the page.
    point(number) {
      const p = pins.get(number);
      if (!p) return null;
      if (!p.target?.isConnected) p.target = find(p.tweak);
      if (!p.target) return null;
      const r = p.target.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      const a = p.tweak.anchor ?? { x: 0.5, y: 0.5 };
      return { x: r.left + a.x * r.width, y: r.top + a.y * r.height };
    },
    position() {
      for (const [n, p] of pins) {
        const at = this.point(n);
        p.el.hidden = !at;
        if (at) Object.assign(p.el.style, { left: `${at.x}px`, top: `${at.y}px` });
      }
    },
    setPicking(on) {
      layer?.classList.toggle("picking", on);
    },
    any: () => pins.size > 0,
  };
  ns.teardowns.push(() => {
    layer?.remove();
    pins.clear();
  });
})();
