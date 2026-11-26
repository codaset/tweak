// The context per element's pure parts, loaded as the classic script it is.
// The DOM parts run in the browser proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const src = readFileSync(new URL("../../extension/content/context.js", import.meta.url), "utf8");
const ns = { ready: false, teardowns: [] };
runInNewContext(src, { codasetTweak: ns, globalThis: { codasetTweak: ns } });
const { styles, trimHTML, role } = ns.context;

// computed is a stand-in CSSStyleDeclaration; Chrome gives "" for a
// shorthand whose longhands can't be one value.
const computed = (values) => ({ getPropertyValue: (k) => values[k] ?? "" });

// Values as Chrome 158 computes them for a plain <div>.
const plainDiv = {
  display: "block", position: "static", "font-family": "Times", "font-size": "16px", "font-weight": "400",
  "line-height": "normal", color: "rgb(0, 0, 0)", "background-color": "rgba(0, 0, 0, 0)", padding: "0px",
  margin: "0px", gap: "normal", border: "0px none rgb(0, 0, 0)", "border-radius": "0px", "box-shadow": "none",
};

test("styles leave out the values that say nothing", () => {
  assert.deepEqual({ ...styles(computed(plainDiv)) }, {
    display: "block", "font-family": "Times", "font-size": "16px", "font-weight": "400", color: "rgb(0, 0, 0)",
  });
});

test("styles keep what was set, in the fixed key order", () => {
  const got = styles(computed({
    ...plainDiv, "box-shadow": "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px", position: "relative", padding: "8px 16px",
    border: "1px solid rgb(229, 231, 235)", gap: "8px", "background-color": "rgb(37, 99, 235)",
  }));
  assert.deepEqual(Object.keys(got), ["display", "position", "font-family", "font-size", "font-weight", "color",
    "background-color", "padding", "gap", "border", "box-shadow"]);
  assert.equal(got.border, "1px solid rgb(229, 231, 235)");
});

test("a border on some sides only lists those sides", () => {
  const got = styles(computed({
    ...plainDiv, border: "", "border-top": "0px none rgb(0, 0, 0)", "border-right": "0px none rgb(0, 0, 0)",
    "border-bottom": "1px solid rgb(229, 231, 235)", "border-left": "0px none rgb(0, 0, 0)",
  }));
  assert.equal(got.border, "bottom 1px solid rgb(229, 231, 235)");
});

test("a style value is one line, at most 120 characters", () => {
  const got = styles(computed({ ...plainDiv, "font-family": `"A\nB", ${"x".repeat(200)}` }));
  assert.equal([...got["font-family"]].length, 120);
  assert.ok(got["font-family"].startsWith('"A B", x') && got["font-family"].endsWith("…"));
});

test("HTML is trimmed to the characters that read, at most 1600", () => {
  assert.equal(trimHTML('<ul>\n  <li class="a">One</li>\n  <li>Two\n   three</li>\n</ul>'), '<ul><li class="a">One</li><li>Two three</li></ul>');
  const long = trimHTML(`<p>${"é".repeat(2000)}</p>`);
  assert.equal([...long].length, 1600);
  assert.ok(long.endsWith("…"));
});

test("a nested rule's selector is made absolute against its parent's", () => {
  const { nest } = ns.context;
  assert.equal(nest(".a", null), ".a");
  assert.equal(nest("& .button", ".container"), ":is(.container) .button");
  assert.equal(nest("&:hover, .x &", ".b"), ":is(.b):hover, .x :is(.b)");
  assert.equal(nest(".button", ".container"), ":is(.container) :is(.button)");
  assert.equal(nest("> .button", ".container"), ":is(.container) > .button");
});

// el is a stand-in element with attributes.
const el = (localName, attrs = {}, props = {}) => ({
  localName, ...props,
  getAttribute: (a) => attrs[a] ?? null,
  hasAttribute: (a) => a in attrs,
});

test("an element's role is its explicit one, or the implicit one", () => {
  assert.equal(role(el("div", { role: "tab selected" })), "tab");
  assert.equal(role(el("button")), "button");
  assert.equal(role(el("a", { href: "/x" })), "link");
  assert.equal(role(el("a")), "");
  assert.equal(role(el("input", {}, { type: "checkbox" })), "checkbox");
  assert.equal(role(el("input", {}, { type: "email" })), "textbox");
  assert.equal(role(el("input", {}, { type: "hidden" })), "");
  assert.equal(role(el("h2")), "heading");
  assert.equal(role(el("div")), "");
});

test("a nested selector list nests each branch", () => {
  const { nest } = ns.context;
  assert.equal(nest("> .a, > .b", ".container"), ":is(.container) > .a, :is(.container) > .b");
  assert.equal(nest("& > .a, .b", ".c"), ":is(.c) > .a, :is(.c) :is(.b)");
  // Commas inside parentheses, brackets and strings aren't branches.
  assert.equal(nest(':is(.a, .b) [title="x, y"]', ".c"), ':is(.c) :is(:is(.a, .b) [title="x, y"])');
});
