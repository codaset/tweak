import { test } from "node:test";
import assert from "node:assert/strict";
import { frame, paced } from "../../extension/lib/screenshot.js";

const viewport = { width: 1100, height: 800 };
const at2x = { width: 2200, height: 1600 };

test("the crop is the rects plus a 48 CSS-px margin, in device pixels, with the outlines placed in it", () => {
  const f = frame([{ kind: "element", number: 1, x: 100, y: 200, width: 300, height: 40 }], viewport, at2x);
  // 52..448 × 152..288 CSS px, doubled.
  assert.deepEqual(f.crop, { x: 104, y: 304, width: 792, height: 272 });
  assert.deepEqual(f.size, { width: 792, height: 272 });
  assert.deepEqual(f.outlines, [{ kind: "element", number: 1, x: 96, y: 96, width: 600, height: 80 }]);
  assert.equal(f.unit, 2, "output pixels per CSS pixel");
});

test("the crop covers the union of every rect", () => {
  const f = frame(
    [
      { kind: "element", number: 1, x: 100, y: 100, width: 50, height: 50 },
      { kind: "element", number: 2, x: 400, y: 300, width: 100, height: 20 },
    ],
    viewport,
    { width: 1100, height: 800 },
  );
  assert.deepEqual(f.crop, { x: 52, y: 52, width: 496, height: 316 });
  assert.deepEqual(
    f.outlines.map((o) => [o.number, o.x, o.y]),
    [
      [1, 48, 48],
      [2, 348, 248],
    ],
  );
});

test("the margin is clipped to the viewport", () => {
  const f = frame([{ kind: "element", number: 1, x: 0, y: 760, width: 50, height: 100 }], viewport, at2x);
  // 0..98 × 712..800 CSS px: the element runs off the bottom.
  assert.deepEqual(f.crop, { x: 0, y: 1424, width: 196, height: 176 });
});

test("the longest side is scaled down to 1600 px, the outlines with it", () => {
  const f = frame([{ kind: "area", x: 0, y: 0, width: 1100, height: 800 }], viewport, at2x);
  assert.deepEqual(f.crop, { x: 0, y: 0, width: 2200, height: 1600 });
  assert.deepEqual(f.size, { width: 1600, height: 1164 });
  assert.equal(f.outlines[0].width, 1600);
  assert.ok(Math.abs(f.unit - 1600 / 1100) < 1e-9);
});

test("with nothing on screen to outline, the crop is the whole viewport", () => {
  for (const rects of [[], [{ kind: "element", number: 1, x: 0, y: -900, width: 100, height: 100 }], [{ kind: "text", x: 5, y: 5, width: 0, height: 0 }]]) {
    assert.deepEqual(frame(rects, viewport, viewport).crop, { x: 0, y: 0, width: 1100, height: 800 }, JSON.stringify(rects));
  }
});

// A fake clock: wait(ms) moves it on.
function clock() {
  const c = { t: 0, starts: [] };
  c.now = () => c.t;
  c.wait = async (ms) => {
    c.t += ms;
  };
  return c;
}

test("captures run one at a time, at most two a second", async () => {
  const c = clock();
  const run = paced({ now: c.now, wait: c.wait });
  const results = await Promise.all([1, 2, 3].map((n) => run(async () => (c.starts.push(c.t), n))));
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(c.starts, [0, 550, 1100]);
});

test("a capture after a pause starts at once, and a failed one still counts", async () => {
  const c = clock();
  const run = paced({ now: c.now, wait: c.wait });
  await assert.rejects(run(async () => {
    c.starts.push(c.t);
    throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
  }));
  await run(async () => c.starts.push(c.t));
  c.t = 5000;
  await run(async () => c.starts.push(c.t));
  assert.deepEqual(c.starts, [0, 550, 5000]);
});
