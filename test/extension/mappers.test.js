// The DOM mappers' edge cases (design.md § Finding the source), over what
// the fixtures really serve: the rails fixture's annotated HTML and the CSS
// esbuild built, saved in test/extension/fixtures/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));

// load gives a fresh copy of the mappers (and the source maps they use),
// with fetch and the gathered rules stubbed. The page's DOM isn't there,
// so the Rails and Proscenium mappers find nothing.
function load({ fetch = () => Promise.reject(new Error("no fetch")), rules = () => [] } = {}) {
  const ns = { ready: false, teardowns: [], context: { rules } };
  const context = {
    codasetTweak: ns, globalThis: { codasetTweak: ns }, setTimeout, clearTimeout, URL, Promise, atob, TextDecoder, fetch,
    location: { href: "http://localhost:3000/" },
  };
  runInNewContext(read("../../extension/content/sourcemap.js"), context);
  runInNewContext(read("../../extension/content/mappers.js"), context);
  runInNewContext(read("../../extension/content/hover.js"), context);
  return { ...ns.mappers, ...ns.hover };
}
const mappers = load();

// around splits HTML at an element's start tag, as the DOM walk sees it:
// the comments before it, nearest first, and those after it, in order.
function around(html, marker) {
  const at = html.lastIndexOf("<", html.indexOf(marker));
  const comments = (s) => [...s.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  return [comments(html.slice(0, at)).reverse(), comments(html.slice(at))];
}

const annotated = read("./fixtures/rails/annotated.html");

test("Rails: an element's templates, innermost first; closed partials before it are passed over", () => {
  assert.deepEqual(plain(mappers.templates(...around(annotated, 'data-testid="signup"'))), [
    "app/views/pages/_signup.html.erb",
    "app/views/pages/home.html.erb",
    "app/views/layouts/application.html.erb",
  ]);
  // The second of a collection's rows: the first row's partial is closed.
  assert.deepEqual(plain(mappers.templates(...around(annotated, "Team, $29"))), [
    "app/views/pages/_plan.html.erb",
    "app/views/pages/home.html.erb",
    "app/views/layouts/application.html.erb",
  ]);
  assert.deepEqual(plain(mappers.templates(...around(annotated, 'id="home"'))), [
    "app/views/shared/_header.html.erb",
    "app/views/layouts/application.html.erb",
  ]);
});

test("Rails: only balanced comments count; a BEGIN that never ends isn't a template", () => {
  const html = "<!-- BEGIN app/views/a.html.erb --><!-- BEGIN app/views/open.html.erb --><p id=x>x</p><!-- END app/views/a.html.erb -->";
  assert.deepEqual(plain(mappers.templates(...around(html, "id=x"))), ["app/views/a.html.erb"]);
  assert.deepEqual(plain(mappers.templates(...around(read("./fixtures/rails/plain.html"), 'data-testid="signup"'))), []);
  // Other comments are not Rails'.
  assert.deepEqual(plain(mappers.templates([" BEGINNING ", "TODO"], [" END app/x "])), []);
});

test("Proscenium: a dev class name gives its CSS module, from the sheet the page loaded it in", () => {
  const sheets = [
    { url: "/app/components/card/component.module.css" },
    { url: "http://localhost:3000/lib/styles.module.css", id: "_1a2b3c4d" },
    { url: "/app/assets/application.css" },
  ];
  assert.deepEqual(plain(mappers.modules(["card", "title_9f8e7d6c_app-components-card-component-module", "body_1a2b3c4d_lib-styles-module"], sheets)), [
    "/app/components/card/component.module.css",
    "/lib/styles.module.css",
  ]);
  // A Proscenium-looking name whose module the page hasn't loaded gives nothing.
  assert.deepEqual(plain(mappers.modules(["x_00000000_app-missing-module"], sheets)), []);
  assert.deepEqual(plain(mappers.modules(["btn", "title-9f8e7d6c", "a_9f8e7d6c_b"], sheets)), []);
});

const theme = read("./fixtures/css/theme.css");
const minified = read("./fixtures/css/buttons.min.css");

test("CSS: a selector is found as a whole rule prelude, its 0-based line and column", () => {
  assert.deepEqual(plain(mappers.prelude(theme, "& .plan-title")), { line: 4, column: 2 });
  assert.deepEqual(plain(mappers.prelude(theme, ".note, .badge")), { line: 12, column: 0 });
  // `.badge` is also in `.note, .badge`, which is a different prelude.
  assert.deepEqual(plain(mappers.prelude(theme, ".badge")), { line: 9, column: 0 });
  assert.deepEqual(plain(mappers.prelude(minified, ".toolbar > .btn")), { line: 0, column: 77 });
});

test("CSS: a selector written twice, or not at all, has no line", () => {
  assert.equal(mappers.prelude(minified, ".btn"), null);
  assert.equal(mappers.prelude(theme, ".missing"), null);
  assert.equal(mappers.prelude('.a { content: "}" } .b{x:y}', ".b").line, 0);
  assert.equal(mappers.prelude("/* .c { } */ .c {}", ".c").column, 13);
});

test("every mapper runs; one that fails or takes over 300 ms gives nothing, the others still count", async () => {
  const m = load();
  const loc = (via) => ({ file: `${via}.x`, role: "component", via });
  const got = await m.run({}, {
    mappers: [
      { via: "rails", map: async () => [loc("rails")] },
      { via: "proscenium", map: () => new Promise((done) => setTimeout(() => done([loc("proscenium")]), 400)) },
      { via: "css", map: () => { throw new Error("no"); } },
      { via: "vue", map: async () => [loc("vue"), { role: "element", via: "vue" }] },
    ],
  });
  assert.deepEqual(plain(got), [loc("rails"), loc("vue")]);
});

test("the hover label names the strongest place's file, its line only when there is one", () => {
  const { label } = mappers;
  assert.equal(label([]), "");
  assert.equal(label([
    { file: "http://localhost:3000/src/theme.css", line: 10, role: "style", via: "css" },
    { file: "app/views/pages/_signup.html.erb", role: "component", via: "rails" },
  ]), "pages/_signup.html.erb");
  assert.equal(label([{ file: "http://localhost:3000/src/theme.css?v=2", line: 10, column: 3, role: "style", via: "css" }]), "src/theme.css:10");
  assert.equal(label([{ file: "/Users/joel/app/components/Card.tsx", line: 4, role: "element", via: "react" }]), "components/Card.tsx:4");
});

// rule is a gathered CSS rule as context.js gives it: its source unlisted.
const rule = (selector, file, sheet) => Object.defineProperty({ selector, file }, "source", { value: { sheet, selector } });
const served = (text) => ({ ok: true, text: async () => text });

test("the hover label falls back to the stylesheet of the latest rule when nothing maps without fetching", async () => {
  const sheet = { href: "http://localhost:3000/styles.css" };
  const m = load({ rules: () => [rule(".btn", "http://localhost:3000/styles.css", sheet), rule(".btn-primary", "http://localhost:3000/theme.css", sheet)] });
  assert.equal(await m.source({}), "theme.css");
  assert.equal(await load().source({}), "");
});

test("a stylesheet replaced at the same URL is read again, and so is its map", async () => {
  const map = JSON.parse(read("./fixtures/css/theme.css.map"));
  const moved = JSON.stringify({ ...map, sources: ["../src/moved.css"] });
  const answers = { "http://localhost:3000/theme.css": [read("./fixtures/css/theme.css")], "http://localhost:3000/theme.css.map": [JSON.stringify(map), moved] };
  const m = load({ fetch: async (url) => served(answers[url].length > 1 ? answers[url].shift() : answers[url][0]) });
  const lineOf = async (sheet) => {
    const [at] = await m.ruleLines([rule(".badge", "http://localhost:3000/theme.css", sheet)]);
    return `${at.file}:${at.line}`;
  };
  const first = { href: "http://localhost:3000/theme.css" };
  assert.equal(await lineOf(first), "http://localhost:3000/src/theme.css:16");
  assert.equal(await lineOf(first), "http://localhost:3000/src/theme.css:16", "the same sheet is read once");
  assert.equal(await lineOf({ href: "http://localhost:3000/theme.css" }), "http://localhost:3000/src/moved.css:16", "a new sheet at the URL is read again");
});

test("the CSS rules mapper gives locations and leaves the gathered rules as they were", async () => {
  const m = load({ fetch: async (url) => served(read(url.endsWith(".map") ? "./fixtures/css/theme.css.map" : "./fixtures/css/theme.css")) });
  const sheet = { href: "http://localhost:3000/theme.css" };
  const rules = [rule(".badge", "http://localhost:3000/theme.css", sheet), rule(".missing", "http://localhost:3000/theme.css", sheet)];
  const got = await m.run({}, { rules });
  assert.deepEqual(plain(got), [{ file: "http://localhost:3000/src/theme.css", line: 16, column: 1, role: "style", via: "css" }]);
  assert.deepEqual(plain(rules), [{ selector: ".badge", file: "http://localhost:3000/theme.css" }, { selector: ".missing", file: "http://localhost:3000/theme.css" }]);
});

test("a <style>'s inline map is decoded once, however often it's hovered", async () => {
  const m = load();
  const text = read("./fixtures/css/buttons.min.css");
  const sheet = { href: null, ownerNode: { textContent: text } };
  const rules = [rule(".btn-primary", "", sheet)];
  const first = await m.ruleLines(rules, { fetch: false });
  sheet.ownerNode = { get textContent() { throw new Error("read again"); } };
  assert.deepEqual(plain(await m.ruleLines(rules, { fetch: false })), plain(first));
  assert.equal(first[0].line, 5);
});
