// Screenshots (docs/design.md, "Screenshot"): the geometry of the crop and
// its outlines, the pace of captures, and drawing the outlines. The worker
// does the capturing and the canvas work; this is what's testable in node.

const MARGIN = 48; // CSS px around what was pointed at
const LONGEST = 1600; // px, the longest side of the stored image
const QUOTA_GAP = 550; // ms between captures: Chrome allows two a second

// frame works out a screenshot from the pick's rects ({kind, number?, x, y,
// width, height}, viewport CSS px), the viewport's size in CSS px and the
// capture's in device px:
// - crop: the union of the rects plus MARGIN, clipped to the viewport, in
//   device px (the whole viewport when nothing is on screen);
// - size: the stored image, its longest side at most LONGEST;
// - outlines: the rects, placed in the stored image;
// - unit: stored pixels per CSS pixel, for line widths and labels.
export function frame(rects, viewport, image) {
  const sx = image.width / viewport.width;
  const sy = image.height / viewport.height;
  const shown = rects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      left: Math.max(0, r.x - MARGIN),
      top: Math.max(0, r.y - MARGIN),
      right: Math.min(viewport.width, r.x + r.width + MARGIN),
      bottom: Math.min(viewport.height, r.y + r.height + MARGIN),
    }))
    .filter((b) => b.right > b.left && b.bottom > b.top);
  const u = shown.length
    ? {
        left: Math.min(...shown.map((b) => b.left)),
        top: Math.min(...shown.map((b) => b.top)),
        right: Math.max(...shown.map((b) => b.right)),
        bottom: Math.max(...shown.map((b) => b.bottom)),
      }
    : { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const x = Math.floor(u.left * sx);
  const y = Math.floor(u.top * sy);
  const crop = { x, y, width: Math.min(image.width, Math.ceil(u.right * sx)) - x, height: Math.min(image.height, Math.ceil(u.bottom * sy)) - y };
  const k = Math.min(1, LONGEST / Math.max(crop.width, crop.height));
  const size = { width: Math.max(1, Math.round(crop.width * k)), height: Math.max(1, Math.round(crop.height * k)) };
  const outlines = rects.map((r) => ({
    ...r,
    x: (r.x * sx - crop.x) * k,
    y: (r.y * sy - crop.y) * k,
    width: r.width * sx * k,
    height: r.height * sy * k,
  }));
  return { crop, size, outlines, unit: sx * k };
}

// paced runs captures one at a time, each starting at least QUOTA_GAP after
// the one before, failed ones included: Chrome refuses a third call within
// a second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND).
export function paced({ now = () => Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let queue = Promise.resolve();
  let last = -Infinity;
  return (fn) => {
    const turn = queue.then(async () => {
      const due = last + QUOTA_GAP - now();
      if (due > 0) await wait(due);
      last = now();
      return fn();
    });
    queue = turn.catch(() => {});
    return turn;
  };
}

// The outlines' colours: the overlay's accent, with a white keyline so they
// show on dark and light pages alike.
const ACCENT = "#4c5fd5";
const KEYLINE = "rgb(255 255 255 / 0.9)";

// draw puts the outlines on a 2D context the stored image's size: elements
// outlined and numbered, selected text highlighted, an area's box dashed.
// Elements go last, so their numbers sit on top.
export function draw(ctx, { outlines, unit }) {
  const u = Math.max(1, unit);
  const order = { text: 0, area: 1, element: 2 };
  const sorted = [...outlines].sort((a, b) => (order[a.kind] ?? 2) - (order[b.kind] ?? 2));
  for (const o of sorted) {
    if (o.kind === "text") {
      ctx.fillStyle = "rgb(76 95 213 / 0.28)";
      ctx.fillRect(o.x, o.y, o.width, o.height);
      continue;
    }
    ctx.setLineDash(o.kind === "area" ? [6 * u, 4 * u] : []);
    stroke(ctx, o, u);
    if (o.number) badge(ctx, o, u);
  }
  ctx.setLineDash([]);
}

function stroke(ctx, o, u) {
  ctx.lineJoin = "round";
  ctx.strokeStyle = KEYLINE;
  ctx.lineWidth = 4 * u;
  ctx.strokeRect(o.x, o.y, o.width, o.height);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2 * u;
  ctx.strokeRect(o.x, o.y, o.width, o.height);
}

// badge is the element's number in a pill on its top-left corner, kept
// inside the image.
function badge(ctx, o, u) {
  const label = String(o.number);
  ctx.font = `600 ${11 * u}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const h = 18 * u;
  const w = Math.max(h, ctx.measureText(label).width + 10 * u);
  const x = Math.max(0, o.x - u);
  const y = o.y - h - 2 * u >= 0 ? o.y - h - 2 * u : Math.max(0, o.y + 2 * u);
  ctx.fillStyle = KEYLINE;
  pill(ctx, x - u, y - u, w + 2 * u, h + 2 * u);
  ctx.fillStyle = ACCENT;
  pill(ctx, x, y, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + 0.5 * u);
}

function pill(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
}
