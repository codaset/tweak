// Pointing at more than one element (docs/design.md, "Pointing at things"
// and "Finding the source"): selected text, and an area dragged over the
// page. Each becomes a pick, what the composer is opened with:
//   {kind: "elements", elements, anchor}
//   {kind: "text", elements: [the element holding it], selection: {text, before, after}, range, anchor}
//   {kind: "area", elements: [inside, ...contained], area: {page, viewport}, anchor}
// The anchor is where the pin sits, as a fraction of element 1's box.
// rects(pick) are the numbered rectangles of what was pointed at, in
// viewport CSS pixels, for the screenshot's outlines. The geometry and the
// text cuts are pure, and tested in node.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // The caps are the brief's too (internal/brief): TestPointingAgreesWithTheBrief.
  const SELECTION_CAP = 2000;
  const AROUND_CAP = 40;
  const CONTAINS = 5; // elements fully inside an area
  const SKIPPED = new Set(["script", "style", "template", "noscript", "link", "meta", "head"]);

  const clamp = (v) => Math.min(1, Math.max(0, v));
  const squash = (s) => s.replace(/\s+/g, " ");

  // cut is the selection, capped; before and after are the text either side,
  // cut furthest from the selection, with … where text was left out.
  function cut(s, n) {
    const cps = [...s];
    return cps.length > n ? `${cps.slice(0, n - 1).join("")}…` : s;
  }
  function cutStart(s, n) {
    const cps = [...s];
    return cps.length > n ? `…${cps.slice(cps.length - n + 1).join("")}` : s;
  }
  const around = (before, after) => ({
    before: cutStart(squash(before).trimStart(), AROUND_CAP),
    after: cut(squash(after).trimEnd(), AROUND_CAP),
  });

  // Rectangles are {x, y, width, height}.
  const box = (r) => ({ x: r.x ?? r.left, y: r.y ?? r.top, width: r.width, height: r.height });
  const within = (outer, inner) =>
    inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
  const empty = (r) => !r || r.width <= 0 || r.height <= 0;

  // topLevelInside walks a tree in document order and returns its top-level
  // nodes fully inside the box, at most CONTAINS: a node inside is taken
  // whole (its children aren't looked at); any other is looked into, since
  // a descendant can be drawn outside its parent's box (fixed, absolute,
  // overflowing). At most VISITS nodes are looked at.
  const VISITS = 5000;
  function topLevelInside(area, root, { rect, children }) {
    const out = [];
    let visits = 0;
    const walk = (node) => {
      for (const child of children(node)) {
        if (out.length === CONTAINS || ++visits > VISITS) return;
        const r = rect(child);
        if (!empty(r) && within(area, r)) out.push(child);
        else walk(child);
      }
    };
    walk(root);
    return out;
  }

  // smallestContaining is the nearest node, from start up through parent,
  // whose box holds the whole area; the last one when none does.
  function smallestContaining(area, start, { rect, parent }) {
    let node = start;
    for (let up = start; up; up = parent(up)) {
      node = up;
      const r = rect(up);
      if (!empty(r) && within(r, area)) return up;
    }
    return node;
  }

  // anchorIn is a point as a fraction of el's box, kept inside it.
  function anchorIn(el, x, y) {
    const r = el.getBoundingClientRect();
    return { x: clamp((x - r.left) / (r.width || 1)), y: clamp((y - r.top) / (r.height || 1)) };
  }

  const host = () => ns.overlay?.host;
  const elementOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
  const pageable = (el) => el && el !== document.documentElement && el !== host() && !host()?.contains?.(el);

  // selectionAt is the page's selected text when the point is on it: the
  // range, or null. Text in the overlay, or a selection across nothing,
  // doesn't count.
  function selectionAt(x, y) {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.toString().trim() || !pageable(elementOf(range.commonAncestorContainer))) return null;
    for (const r of range.getClientRects()) {
      if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return range;
    }
    return null;
  }

  // textPick is a pick of the selected text in range: the element holding
  // it is element 1. The text around it is read from the nearest ancestor
  // with enough text either side, so it tells one occurrence from another.
  function textPick(range, x, y) {
    let el = elementOf(range.commonAncestorContainer);
    if (el === document.documentElement) el = document.body;
    const text = cut(range.toString(), SELECTION_CAP);
    let context = el;
    while (context !== document.body && context.parentElement && (context.textContent ?? "").length < text.length + 2 * AROUND_CAP) {
      context = context.parentElement;
    }
    const part = (from, to) => {
      const r = document.createRange();
      r.setStart(...from);
      r.setEnd(...to);
      return r.toString();
    };
    const { before, after } = around(
      part([context, 0], [range.startContainer, range.startOffset]),
      part([range.endContainer, range.endOffset], [context, context.childNodes.length]),
    );
    const first = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return {
      kind: "text",
      elements: [el],
      selection: { text, ...(before && { before }), ...(after && { after }) },
      range: range.cloneRange(),
      anchor: anchorIn(el, first ? first.left : x, first ? first.top : y),
    };
  }

  // areaPick is a pick of a box dragged in the viewport: the smallest
  // element containing it is element 1, then the top-level elements fully
  // inside it.
  function areaPick(viewportBox) {
    const v = viewportBox;
    const points = [
      [v.x + v.width / 2, v.y + v.height / 2],
      [v.x + 1, v.y + 1],
      [v.x + v.width - 1, v.y + 1],
      [v.x + 1, v.y + v.height - 1],
      [v.x + v.width - 1, v.y + v.height - 1],
    ];
    const hits = points.map(([x, y]) => document.elementsFromPoint(x, y).find(pageable)).filter(Boolean);
    // The deepest element that holds every hit, then up until its box holds the area.
    let start = hits[0] ?? document.body;
    while (start && !hits.every((h) => start.contains(h))) start = start.parentElement;
    const rect = (el) => box(el.getBoundingClientRect());
    let inside = smallestContaining(v, start ?? document.body, {
      rect,
      parent: (el) => (el === document.body ? null : el.parentElement),
    });
    if (!pageable(inside)) inside = document.body;
    const contained = topLevelInside(v, inside, {
      rect: (el) => (el.localName === "body" ? null : rect(el)),
      children: (el) => [...el.children].filter((c) => pageable(c) && !SKIPPED.has(c.localName)),
    });
    const round = (n) => Math.round(n * 100) / 100;
    const at = (x, y) => ({ x: round(x), y: round(y), width: round(v.width), height: round(v.height) });
    return {
      kind: "area",
      elements: [inside, ...contained],
      area: { page: at(v.x + scrollX, v.y + scrollY), viewport: at(v.x, v.y) },
      anchor: anchorIn(inside, v.x, v.y),
    };
  }

  // rects are what a pick points at as numbered rectangles in the viewport,
  // CSS pixels: {kind: "element", number, x, y, width, height} per element,
  // the selection's line boxes as kind "text", the area as kind "area".
  // Taken at pick time, for the screenshot's outlines (#38).
  function rects(pick) {
    const numbered = (el, number) => ({ kind: "element", number, ...box(el.getBoundingClientRect()) });
    if (pick.kind === "text") {
      return [numbered(pick.elements[0], 1), ...[...pick.range.getClientRects()].map((r) => ({ kind: "text", ...box(r) }))];
    }
    const out = pick.elements.map((el, i) => numbered(el, i + 1));
    if (pick.kind === "area") out.push({ kind: "area", ...pick.area.viewport });
    return out;
  }

  ns.pointing = { selectionAt, textPick, areaPick, rects, around, within, topLevelInside, smallestContaining, CONTAINS };
})();
