// Search clues (design.md § Finding the source, Search clues): the order,
// the limit of 8, unique first, and what's left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const ns = { ready: false, teardowns: [], describe: { text: (el) => el.text ?? "" } };
runInNewContext(readFileSync(new URL("../../extension/content/clues.js", import.meta.url), "utf8"), {
  codasetTweak: ns, globalThis: { codasetTweak: ns }, URL,
});
const plain = (v) => JSON.parse(JSON.stringify(v));

// el is a stand-in element: attributes, classes, its own text, and an
// href resolved as the browser would.
const el = (localName, attrs = {}, { text = "", href } = {}) => ({
  localName, text, href,
  getAttribute: (a) => attrs[a] ?? null,
  classList: (attrs.class ?? "").split(/\s+/).filter(Boolean),
});
// of is el's clues on a page where each `kind=value` is on counts[…]
// elements (1, unique, unless said).
const of = (element, counts = {}) =>
  plain(ns.clues.of(element, { count: (kind, value) => counts[`${kind}=${value}`] ?? 1, origin: "http://localhost:3000" }));

test("within each kind, clues unique on the page come first: test IDs too", () => {
  const row = el("tr", { "data-testid": "row", "data-qa": "invoice-row-7", id: "r7" });
  assert.deepEqual(of(row, { "data-testid=row": 5 }).map((c) => c.kind), ["data-qa", "data-testid", "id"]);
});

test("a lone word that could be part of a date is still a clue", () => {
  for (const text of ["May", "Sat", "Sun", "June", "PM"]) assert.deepEqual(of(el("span", {}, { text })), [{ kind: "text", value: text }], text);
});

test("clues come in the agreed order: test IDs, id, labels, text, classes, the link's path", () => {
  const link = el("a", {
    "data-cy": "nav-docs", "data-testid": "docs", id: "docs", "aria-label": "Read the docs", title: "Docs", class: "nav-link",
  }, { text: "Docs", href: "http://localhost:3000/guide/start?x=1" });
  assert.deepEqual(of(link), [
    { kind: "data-testid", value: "docs" },
    { kind: "data-cy", value: "nav-docs" },
    { kind: "id", value: "docs" },
    { kind: "aria-label", value: "Read the docs" },
    { kind: "title", value: "Docs" },
    { kind: "text", value: "Docs" },
    { kind: "class", value: "nav-link" },
    { kind: "href", value: "/guide/start" },
  ]);
});

test("at most 8 clues", () => {
  const busy = el("input", {
    "data-testid": "a", "data-test": "b", "data-qa": "c", "data-cy": "d", id: "e", "aria-label": "f", placeholder: "g", title: "h", class: "one two",
  });
  const got = of(busy);
  assert.equal(got.length, 8);
  assert.deepEqual(got.at(-1), { kind: "title", value: "h" });
});

test("classes unique on the page come first; common, generated and Tailwind-variant ones are left out", () => {
  const button = el("button", {
    class: "btn btn-save md:px-4 [&>svg]:size-4 css-1x2y3z sc-bdVaJa svelte-xyz123 Button_root__a1B2c title_1a2b3c4d_app-components-card-module _save_k3j2h_12 save-button",
  });
  const got = of(button, { "class=btn": 40, "class=btn-save": 3 });
  assert.deepEqual(got.filter((c) => c.kind === "class").map((c) => c.value), ["save-button", "btn-save"]);
});

test("a class on exactly 10 elements is still a clue; on 11 it's common", () => {
  const got = of(el("div", { class: "row card" }), { "class=row": 11, "class=card": 10 });
  assert.deepEqual(got.map((c) => c.value), ["card"]);
});

test("text that is only numbers or a date is skipped; other text is its first line, at most 80 characters", () => {
  for (const text of ["42", "1,234.50", "$19.99", "12:30", "2026-11-26", "26 Nov 2026", "Nov 26, 2026", "Thursday 26 November"]) {
    assert.deepEqual(of(el("span", {}, { text })), [], `${text} is skipped`);
  }
  assert.deepEqual(of(el("span", {}, { text: "3 items" })), [{ kind: "text", value: "3 items" }]);
  assert.deepEqual(of(el("span", {}, { text: "Money" })), [{ kind: "text", value: "Money" }], "a word starting like a day isn't a date");
  const long = of(el("p", {}, { text: "x".repeat(100) }))[0].value;
  assert.equal([...long].length, 80);
});

test("a link's href clue is its path on the page's origin; another origin's link gives its whole URL; none for #", () => {
  assert.deepEqual(of(el("a", {}, { href: "https://github.com/codaset/tweak" })), [{ kind: "href", value: "https://github.com/codaset/tweak" }]);
  assert.deepEqual(of(el("a", { href: "#top" }, { href: "http://localhost:3000/#top" })), []);
  assert.deepEqual(of(el("div", {}, { href: "http://localhost:3000/x" })), [], "only links have an href clue");
});
