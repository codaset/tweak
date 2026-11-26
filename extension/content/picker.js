// Pointing at the page (docs/design.md, "Pointing at things"). Hold ⌥ and
// the element under the pointer is outlined and labelled:
// - ⌥-click picks it;
// - ⇧-click (or ⌥⇧-click) while a composer of elements is open adds the
//   element as the next numbered one, or takes it out again; ⌥⇧-click with
//   no composer open picks it like ⌥-click, and a plain ⇧-click is the
//   page's own;
// - ⌥-click on selected text picks the text;
// - ⌥-drag draws a box over any region, empty space included, and picks the
//   area. esc during the drag cancels it;
// - while the bridge is down, ⌥ outlines nothing and an ⌥-click opens the
//   side panel instead (⇧-click still changes an open composer).
// The whole gesture is swallowed (pointer and mouse down and up, the moves
// of a drag, and the click), so links and buttons don't fire and the page's
// text selection is left as it was. The listeners go on window in the
// capture phase, ahead of the page's own.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const DRAG = 4; // CSS px the pointer moves before a press becomes a drag
  const MIN_AREA = 8; // a box smaller than this either way is no area

  let outline = null;
  let tag = null;
  let box = null; // the drag rectangle
  let boxTag = null;
  let marks = null; // the selected text's line boxes, while ⌥ is over it
  let hovered = null;
  let pointer = null; // the last pointer position, to outline at once on ⌥
  let swallowing = false; // between an ⌥ pointerdown and its click
  let press = null; // {x, y}: an ⌥ press, until it's a click or a drag
  let drag = null; // {x, y, to: {x, y}}: the box being dragged
  let enabled = () => true; // set by the page wiring: off while dormant

  const pickable = (el) => el && el.nodeType === 1 && el !== document.documentElement && el !== document.body && el !== ns.overlay.host;
  const el = (...a) => ns.overlay.el(...a);

  function under(x, y) {
    const found = document.elementFromPoint(x, y);
    return pickable(found) ? found : null;
  }

  // The hover label's source: the mappers run once the pointer has rested
  // on an element for SOURCE_DELAY, without fetching (a line only from a
  // source map already loaded; else the latest matching rule's stylesheet),
  // and it's shown if that element is still the one outlined.
  const SOURCE_DELAY = 60;
  let source = { el: null, text: "" };
  let sourceTimer = 0;
  function findSource(el) {
    clearTimeout(sourceTimer);
    source = { el, text: "" };
    sourceTimer = setTimeout(async () => {
      const text = await ns.hover.source(el).catch(() => "");
      if (source.el !== el || !text) return;
      source.text = text;
      const shown = hovered ?? ns.picker.held;
      if (shown === el && outline && !outline.hidden) draw(el, el !== hovered);
    }, SOURCE_DELAY);
  }

  function ensure() {
    const root = ns.overlay.root;
    if (!root) return false;
    if (!outline) {
      outline = el("div", "outline");
      tag = el("div", "tag");
      root.append(outline, tag);
    }
    return true;
  }

  // place puts a label above a box, or inside its top edge when there's no room.
  function placeTag(t, r) {
    const top = r.top >= 24 ? r.top - 22 : Math.max(2, r.top + 2);
    Object.assign(t.style, { left: `${Math.max(2, Math.min(r.left, innerWidth - 200))}px`, top: `${top}px` });
  }

  // draw outlines el; hint, when given, leads its label ("Add as 2").
  function draw(target, picked = false, hint = "") {
    if (!ensure()) return;
    const r = target.getBoundingClientRect();
    Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    outline.classList.toggle("picked", picked);
    outline.classList.toggle("adding", Boolean(hint));
    const parts = [el("span", "", ns.describe.label(target)), el("span", "size", `${Math.round(r.width)}×${Math.round(r.height)}`)];
    if (hint) parts.unshift(el("span", "hint-word", hint));
    if (source.el === target && source.text) parts.push(el("span", "source", source.text));
    else if (source.el !== target) findSource(target);
    tag.replaceChildren(...parts);
    placeTag(tag, r);
    outline.hidden = tag.hidden = false;
  }

  // drawText marks the selected text's line boxes, labelled.
  function drawText(range) {
    if (!ensure()) return;
    if (!marks) {
      marks = el("div", "text-marks");
      ns.overlay.root.append(marks);
    }
    const rects = [...range.getClientRects()].filter((r) => r.width && r.height);
    marks.replaceChildren(
      ...rects.map((r) => {
        const m = el("div", "text-mark");
        Object.assign(m.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        return m;
      }),
    );
    marks.hidden = false;
    outline.hidden = true;
    const chars = [...range.toString()].length;
    tag.replaceChildren(el("span", "", "Selected text"), el("span", "size", `${chars} ${chars === 1 ? "character" : "characters"}`));
    if (rects[0]) placeTag(tag, rects[0]);
    tag.hidden = false;
  }

  function hideHover() {
    if (outline) outline.hidden = tag.hidden = true;
    if (marks) marks.hidden = true;
  }

  function clear() {
    hovered = null;
    hideHover();
    setPicking(false);
    if (ns.picker.held?.isConnected) draw(ns.picker.held, true);
  }

  function setPicking(on) {
    ns.pins?.setPicking(on);
    ns.busy?.set("picking", on); // pick mode holds a pending self-update back
  }

  // hover shows what an ⌥-click here would pick: the selected text under
  // the pointer, or the element, with its number to be when ⇧ adds it.
  function hover(x, y, shift) {
    if (drag) return;
    const range = !shift && ns.pointing.selectionAt(x, y);
    if (range) {
      hovered = null;
      setPicking(true);
      drawText(range);
      return;
    }
    const target = under(x, y);
    if (!target) return clear();
    hovered = target;
    setPicking(true);
    if (marks) marks.hidden = true;
    draw(target, false, shift ? ns.panel.adding(target) : "");
  }

  // The drag rectangle, from where the press was to the pointer, kept in
  // the viewport, labelled with its size.
  function dragBox() {
    const x1 = Math.min(Math.max(0, Math.min(drag.x, drag.to.x)), innerWidth);
    const y1 = Math.min(Math.max(0, Math.min(drag.y, drag.to.y)), innerHeight);
    const x2 = Math.min(Math.max(drag.x, drag.to.x), innerWidth);
    const y2 = Math.min(Math.max(drag.y, drag.to.y), innerHeight);
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  }

  function drawDrag() {
    const root = ns.overlay.root;
    if (!root) return;
    if (!box) {
      box = el("div", "area-box dragging");
      boxTag = el("div", "tag area-tag");
      box.setAttribute("aria-hidden", "true");
      root.append(box, boxTag);
    }
    const b = dragBox();
    Object.assign(box.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px` });
    boxTag.replaceChildren(el("span", "", "Area"), el("span", "size", `${Math.round(b.width)}×${Math.round(b.height)}`));
    placeTag(boxTag, { left: b.x, top: b.y });
    box.hidden = boxTag.hidden = false;
  }

  function endDrag() {
    drag = null;
    if (box) box.hidden = boxTag.hidden = true;
  }

  const onMove = (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (press?.alt && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG) {
      drag = { x: press.x, y: press.y, to: pointer };
      hovered = null;
      hideHover();
      setPicking(true);
    }
    if (drag) {
      stop(e); // the page doesn't see the moves of a drag
      if (!(e.buttons & 1)) return finishDrag(); // released outside the window
      drag.to = pointer;
      drawDrag();
      return;
    }
    if (!(e.altKey || adds(e)) || !enabled() || ns.overlay.contains(e) || (ns.worker.down() && !adds(e))) {
      if (hovered || (marks && !marks.hidden)) clear();
      return;
    }
    hover(e.clientX, e.clientY, e.shiftKey);
  };

  const onKey = (e) => {
    if (capturing && e.key === "Escape") {
      // esc while a pick is still being captured cancels it: nothing opens.
      stop(e);
      if (e.type === "keydown") cancelPick();
      return;
    }
    if (drag && e.key === "Escape") {
      // esc cancels the drag only: the page, and an open card, don't hear it.
      stop(e);
      if (e.type === "keydown") {
        endDrag();
        press = null;
        clear();
      }
      return;
    }
    if (e.key !== "Alt" && e.key !== "Shift") return;
    if (drag) return;
    const alt = e.key === "Alt" ? e.type === "keydown" : e.altKey;
    const shift = e.key === "Shift" ? e.type === "keydown" : e.shiftKey;
    const adding = shift && ns.panel.canAdd?.();
    const on = (alt && !ns.worker.down()) || adding;
    if (on && pointer && enabled()) hover(pointer.x, pointer.y, shift);
    else if (!on && (hovered || (marks && !marks.hidden))) clear();
  };

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  const onDown = (e) => {
    swallowing = false; // an earlier ⌥ press that never got its click
    press = null;
    if (e.button !== 0 || !(e.altKey || adds(e)) || !enabled() || ns.overlay.contains(e)) return;
    stop(e);
    swallowing = true;
    // While the bridge is down nothing can be sent: an ⌥-click opens the
    // side panel instead, which says how to start it. Asked now, while the
    // press is a user gesture; the rest of the click is swallowed.
    if (ns.worker.down() && !adds(e)) return ns.worker.openSidePanel();
    press = { x: e.clientX, y: e.clientY, alt: e.altKey }; // only ⌥ starts a drag
  };

  // adds says whether a plain ⇧ press here is ours: a composer of elements
  // is open, so ⇧-click adds to it.
  const adds = (e) => e.shiftKey && Boolean(ns.panel.canAdd?.());
  const onUp = (e) => {
    if (!swallowing) return;
    stop(e);
    if (e.type === "pointerup" && drag) finishDrag();
  };

  // finishDrag picks the area dragged over, if it's big enough to be one.
  // A box too small to be an area was a click that slipped: the element
  // where it started is picked.
  function finishDrag() {
    const b = dragBox();
    const start = { x: drag.x, y: drag.y };
    endDrag();
    press = null;
    clear();
    if (b.width < MIN_AREA || b.height < MIN_AREA) return pickAt(start.x, start.y);
    pick(ns.pointing.areaPick(b));
  }

  const onClick = (e) => {
    if (!swallowing) return;
    stop(e);
    swallowing = false;
    const wasPress = press;
    press = null;
    if (!wasPress) return; // the end of a drag, or one esc cancelled
    if (e.shiftKey && ns.panel.add) {
      const target = under(e.clientX, e.clientY);
      if (target && ns.panel.add(target)) {
        hover(e.clientX, e.clientY, true); // the label now says what ⇧ does next
        return;
      }
    }
    const range = !e.shiftKey && ns.pointing.selectionAt(e.clientX, e.clientY);
    if (range) return pick(ns.pointing.textPick(range, e.clientX, e.clientY));
    pickAt(e.clientX, e.clientY);
  };

  // pickAt picks the element at a point, the pin at that point on it.
  function pickAt(x, y) {
    const target = under(x, y);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const anchor = { x: clamp((x - r.left) / (r.width || 1)), y: clamp((y - r.top) / (r.height || 1)) };
    pick({ kind: "elements", elements: [target], anchor });
  }

  // pick is where every gesture ends. The screenshot is taken here, before
  // the composer opens (a hover menu may close once it has the focus); a
  // later pick made while this one captures wins.
  let picks = 0;
  let capturing = false; // a pick waiting for its capture
  function cancelPick() {
    picks++; // its turn is over: the capture, when it comes, is dropped
    capturing = false;
    ns.busy?.set("capture", false);
    ns.picker.release();
  }
  async function pick(p) {
    // One element is outlined as you write about it; more, a selection or
    // an area are drawn by the composer's marks. The held element changes
    // first, so clear() doesn't redraw an earlier pick's outline.
    ns.picker.held = p.kind === "elements" && p.elements.length === 1 ? p.elements[0] : null;
    clear();
    if (!ns.panel.canCompose()) return; // a send is on its way
    const turn = ++picks;
    const url = location.href;
    capturing = true;
    ns.busy?.set("capture", true); // so a self-update can't reload in the gap
    const shot = await ns.screenshot.take().catch(() => null);
    if (turn !== picks) return ns.screenshot.drop(shot); // a later pick, or esc
    capturing = false;
    ns.busy?.set("capture", false);
    // The page moved on meanwhile (a client-side navigation): the pick was
    // of the page before, so nothing opens.
    if (location.href !== url || !p.elements.every((e) => e.isConnected) || !enabled()) {
      ns.picker.release();
      return ns.screenshot.drop(shot);
    }
    ns.panel.compose(p, shot);
  }

  // While an ⌥ press is held, the page's own text selection and drags don't start.
  const onSelect = (e) => {
    if (swallowing) e.preventDefault();
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
    ["selectstart", onSelect],
    ["dragstart", onSelect],
    ["pointercancel", () => ((swallowing = false), (press = null), endDrag(), clear())],
    ["blur", () => ((press = null), endDrag(), clear())],
  ];
  const opts = { capture: true };
  for (const [type, fn] of listeners) window.addEventListener(type, fn, opts);

  ns.picker = {
    held: null, // the one element being written about, outlined while composing
    enable(fn) {
      enabled = fn;
    },
    // follow keeps the picked outline on its element as the page moves.
    follow() {
      if (this.held?.isConnected && !hovered && !drag) draw(this.held, true);
    },
    // hold changes the element outlined while composing, or none.
    hold(target) {
      this.held = target;
      if (!hovered) clear();
    },
    release() {
      this.held = null;
      clear();
    },
  };
  ns.teardowns.push(() => {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, opts);
    clearTimeout(sourceTimer);
    outline?.remove();
    tag?.remove();
    box?.remove();
    boxTag?.remove();
    marks?.remove();
  });
})();
