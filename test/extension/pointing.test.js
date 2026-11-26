// The pure parts of pointing at text and areas, loaded as the classic
// script it is. The DOM parts run in the e2e cases on the static fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./probe-world.js";

const ns = { ready: false, teardowns: [] };
loadScript("pointing.js", ns);
const { around, topLevelInside, smallestContaining } = ns.pointing;

test("the text around a selection is cut furthest from it, whitespace squashed", () => {
  assert.deepEqual({ ...around("Fill in\n   the form below. ", " Nothing is sent.") }, { before: "Fill in the form below. ", after: " Nothing is sent." });
  const { before, after } = around("b".repeat(60) + "near", "near" + "a".repeat(60));
  assert.equal(before, `…${"b".repeat(35)}near`);
  assert.equal(after, `near${"a".repeat(35)}…`);
  assert.equal([...before].length, 40);
});

// A tree of boxes: [name, x, y, w, h, children]; null for no box of its own.
function tree(spec) {
  const make = ([name, ...rest]) => {
    const kids = Array.isArray(rest.at(-1)) ? rest.pop() : [];
    const node = { name, rect: rest[0] === null ? null : { x: rest[0], y: rest[1], width: rest[2], height: rest[3] }, kids: [] };
    for (const k of kids.map(make)) {
      k.parent = node;
      node.kids.push(k);
    }
    return node;
  };
  return make(spec);
}
const walk = { rect: (n) => n.rect, children: (n) => n.kids, parent: (n) => n.parent ?? null };
const names = (nodes) => [...nodes].map((n) => n.name);

const page = tree(["body", 0, 0, 1000, 1000, [
  ["header", 0, 0, 1000, 100, [["logo", 10, 10, 80, 80], ["nav", 600, 10, 390, 80, [["a1", 610, 20, 50, 20], ["a2", 670, 20, 50, 20]]]]],
  ["main", 0, 100, 1000, 900, [
    ["contents", null, [["card1", 20, 120, 200, 200], ["card2", 240, 120, 200, 200]]],
    ["card3", 460, 120, 200, 200],
  ]],
]]);

test("an area holds the top-level elements fully inside it, not their children", () => {
  const area = { x: 0, y: 0, width: 1000, height: 100 };
  assert.deepEqual(names(topLevelInside(area, page, walk)), ["header"]);
  const inHeader = { x: 5, y: 5, width: 990, height: 90 };
  assert.deepEqual(names(topLevelInside(inHeader, page.kids[0], walk)), ["logo", "nav"]);
});

test("an element only partly inside is looked into, and one with no box of its own too", () => {
  const area = { x: 600, y: 15, width: 75, height: 30 }; // over a1 and half of a2
  assert.deepEqual(names(topLevelInside(area, page, walk)), ["a1"]);
  const cards = { x: 10, y: 110, width: 660, height: 220 };
  assert.deepEqual(names(topLevelInside(cards, page, walk)), ["card1", "card2", "card3"]);
});

test("an element drawn outside its parent's box (fixed, absolute) is found inside an area", () => {
  const fixed = tree(["body", 0, 0, 1000, 1000, [["wrapper", 0, 0, 100, 100, [["fab", 400, 400, 50, 50]]]]]);
  assert.deepEqual(names(topLevelInside({ x: 380, y: 380, width: 100, height: 100 }, fixed, walk)), ["fab"]);
});

test("an area holds at most 5 elements, in document order", () => {
  const many = tree(["ul", 0, 0, 100, 800, Array.from({ length: 8 }, (_, i) => [`li${i + 1}`, 0, i * 100, 100, 100])]);
  assert.deepEqual(names(topLevelInside({ x: 0, y: 0, width: 100, height: 800 }, many, walk)), ["li1", "li2", "li3", "li4", "li5"]);
});

test("an area over empty space holds nothing, and is inside the smallest element containing it", () => {
  const gap = { x: 100, y: 20, width: 400, height: 60 }; // in the header, between the logo and the nav
  assert.equal(topLevelInside(gap, page.kids[0], walk).length, 0);
  const logo = page.kids[0].kids[0];
  assert.equal(smallestContaining(gap, logo, walk).name, "header");
  assert.equal(smallestContaining({ x: 15, y: 15, width: 10, height: 10 }, logo, walk).name, "logo");
  assert.equal(smallestContaining({ x: 900, y: 900, width: 500, height: 500 }, logo, walk).name, "body", "past the page: the top");
});
