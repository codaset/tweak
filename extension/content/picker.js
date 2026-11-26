// Picking an element: hold ⌥ and the element under the pointer is outlined
// and labelled; ⌥-click picks it. The whole click is swallowed (pointer and
// mouse down and up, and the click), so links and buttons don't fire. The
// listeners go on window in the capture phase, ahead of the page's own.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  let outline = null;
  let tag = null;
  let hovered = null;
  let pointer = null; // the last pointer position, to outline at once on ⌥
  let swallowing = false; // between an ⌥ pointerdown and its click
  let enabled = () => true; // set by the page wiring: off while dormant

  const pickable = (el) => el && el.nodeType === 1 && el !== document.documentElement && el !== document.body && el !== ns.overlay.host;

  function under(x, y) {
    const el = document.elementFromPoint(x, y);
    return pickable(el) ? el : null;
  }

  function draw(el, picked = false) {
    const root = ns.overlay.root;
    if (!root) return;
    if (!outline) {
      outline = ns.overlay.el("div", "outline");
      tag = ns.overlay.el("div", "tag");
      root.append(outline, tag);
    }
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    outline.classList.toggle("picked", picked);
    tag.replaceChildren(ns.overlay.el("span", "", ns.describe.label(el)), ns.overlay.el("span", "size", `${Math.round(r.width)}×${Math.round(r.height)}`));
    // Above the element, or inside its top edge when there's no room.
    const top = r.top >= 24 ? r.top - 22 : Math.max(2, r.top + 2);
    Object.assign(tag.style, { left: `${Math.max(2, Math.min(r.left, innerWidth - 200))}px`, top: `${top}px` });
    outline.hidden = tag.hidden = false;
  }

  function clear() {
    hovered = null;
    if (outline) outline.hidden = tag.hidden = true;
    setPicking(false);
    if (ns.picker.held?.isConnected) draw(ns.picker.held, true);
  }

  function setPicking(on) {
    ns.pins?.setPicking(on);
  }

  function hover(x, y) {
    const el = under(x, y);
    if (!el) return clear();
    hovered = el;
    setPicking(true);
    draw(el);
  }

  const onMove = (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (!e.altKey || !enabled() || ns.overlay.contains(e)) {
      if (hovered) clear();
      return;
    }
    hover(e.clientX, e.clientY);
  };

  const onKey = (e) => {
    if (e.key !== "Alt") return;
    if (e.type === "keydown" && pointer && enabled()) hover(pointer.x, pointer.y);
    if (e.type === "keyup") clear();
  };

  const stop = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onDown = (e) => {
    swallowing = false; // an earlier ⌥ press that never got its click
    if (e.button !== 0 || !e.altKey || !enabled() || ns.overlay.contains(e)) return;
    stop(e);
    swallowing = true;
  };
  const onUp = (e) => {
    if (swallowing) stop(e);
  };
  const onClick = (e) => {
    if (!swallowing) return;
    stop(e);
    swallowing = false;
    const el = under(e.clientX, e.clientY);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const anchor = { x: clamp((e.clientX - r.left) / (r.width || 1)), y: clamp((e.clientY - r.top) / (r.height || 1)) };
    clear();
    ns.picker.held = el;
    draw(el, true);
    ns.panel.compose(el, anchor);
  };

  const listeners = [
    ["pointermove", onMove],
    ["keydown", onKey],
    ["keyup", onKey],
    ["pointerdown", onDown],
    ["mousedown", onUp],
    ["pointerup", onUp],
    ["mouseup", onUp],
    ["click", onClick],
    ["pointercancel", () => (swallowing = false)],
    ["blur", () => clear()],
  ];
  const opts = { capture: true };
  for (const [type, fn] of listeners) window.addEventListener(type, fn, opts);

  ns.picker = {
    held: null, // the element being written about, outlined while composing
    enable(fn) {
      enabled = fn;
    },
    // follow keeps the picked outline on its element as the page moves.
    follow() {
      if (this.held?.isConnected && !hovered) draw(this.held, true);
    },
    release() {
      this.held = null;
      clear();
    },
  };
  ns.teardowns.push(() => {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, opts);
    outline?.remove();
    tag?.remove();
  });
})();
