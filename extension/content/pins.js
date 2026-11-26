// Pins: one per tweak on this page, at the point you clicked, coloured by
// status. A pin re-attaches by its element's selector, at the same fraction
// of the element's box, so it follows scrolling, resizing and reloads. A pin
// whose element is gone is hidden, and the worker hears of it, for the side
// panel's list. Clicking one opens its card. ⌥⇧H hides the site's pins
// (storage.local's pinsHidden, by origin), and the side panel's switch too.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const pins = new Map(); // number -> {el, tweak, target}
  let layer = null;
  let hidden = false; // this site's pins, hidden with ⌥⇧H
  let gone = ""; // the numbers last said gone, joined

  const hiddenFrom = (setting) => Boolean(setting?.[location.origin]);
  const showHidden = () => layer?.classList.toggle("hidden", hidden);
  chrome.storage.local.get("pinsHidden").then(({ pinsHidden }) => {
    hidden = hiddenFrom(pinsHidden);
    showHidden();
  }, () => {});
  const onStorage = (changes, area) => {
    if (area !== "local" || !("pinsHidden" in changes)) return;
    hidden = hiddenFrom(changes.pinsHidden.newValue);
    showHidden();
  };
  chrome.storage.onChanged.addListener(onStorage);

  // sayGone tells the worker which pins have no element on the page, when
  // that changes, and again after its port reconnects.
  function sayGone(numbers) {
    const key = numbers.join();
    if (key === gone) return;
    gone = key;
    ns.worker.post({ type: "gone", numbers });
  }
  const offWorker = ns.worker.on((msg) => {
    if (msg.type === "open") {
      gone = "";
      ns.pins?.position();
    }
  });

  function find(tweak) {
    const sel = tweak.targets?.elements?.[0]?.selector;
    return sel ? ns.util.find(sel) : null;
  }

  ns.pins = {
    // render shows exactly these tweaks' pins.
    render(tweaks) {
      if (!ns.overlay.root) return;
      if (!layer) {
        layer = ns.overlay.el("div", "pins");
        ns.overlay.root.prepend(layer);
        showHidden();
      }
      // Faded while the bridge is down: they're from the last snapshot.
      layer.classList.toggle("offline", ns.worker.down());
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
        const { text: status } = ns.describe.status(tweak);
        const text = ns.worker.down() ? `${status} (not connected to Tweak)` : status;
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
      const missing = [];
      for (const [n, p] of pins) {
        const at = this.point(n);
        p.el.hidden = !at;
        if (at) Object.assign(p.el.style, { left: `${at.x}px`, top: `${at.y}px` });
        else if (!p.target) missing.push(n); // not found by its selector: gone, not just hidden
      }
      sayGone(missing);
    },
    hidden: () => hidden,
    setPicking(on) {
      layer?.classList.toggle("picking", on);
    },
    any: () => pins.size > 0,
  };
  ns.teardowns.push(() => {
    chrome.storage.onChanged.removeListener(onStorage);
    offWorker();
    layer?.remove();
    pins.clear();
  });
})();
