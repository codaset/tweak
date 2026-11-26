// The DOM mappers' edge cases (design.md § Finding the source), over what
// the fixtures really serve: the rails fixture's annotated HTML and the CSS
// esbuild built, saved in test/extension/fixtures/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));

function load() {
  const ns = { ready: false, teardowns: [] };
  const context = { codasetTweak: ns, globalThis: { codasetTweak: ns }, setTimeout, clearTimeout, URL, Promise };
  runInNewContext(read("../../extension/content/mappers.js"), context);
  return ns.mappers;
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
