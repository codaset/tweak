// Source maps (design.md § Finding the source, Source maps): our own VLQ
// decoder, over real maps esbuild wrote (test/extension/fixtures/css).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = (name) => read(`./fixtures/css/${name}`);
// plain copies a value out of the script's realm, so deepEqual compares values.
const plain = (v) => JSON.parse(JSON.stringify(v));

// load gives a fresh copy of the classic script, with fetch stubbed.
function load(fetch = () => Promise.reject(new Error("no fetch"))) {
  const ns = { ready: false, teardowns: [] };
  runInNewContext(read("../../extension/content/sourcemap.js"), {
    codasetTweak: ns, globalThis: { codasetTweak: ns }, atob, TextDecoder, URL, fetch,
  });
  return ns.sourcemap;
}

test("VLQ values decode, negative and multi-character ones included", () => {
  const { vlq } = load();
  assert.deepEqual(plain(vlq("AAgBC")), [0, 0, 16, 1]);
  assert.deepEqual(plain(vlq("D")), [-1]);
  assert.deepEqual(plain(vlq("2H")), [123]);
  assert.deepEqual(plain(vlq("nB")), [-19]);
});

test("a position in the built sheet maps to its source line and column, 1-based", () => {
  const sm = load();
  const map = sm.parse(fixture("theme.css.map"), "http://localhost:3000/theme.css.map");
  // Built line 5 is `  & .plan-title {`, written at src/theme.css:10:3.
  assert.deepEqual(plain(sm.lookup(map, 4, 2)), { source: "http://localhost:3000/src/theme.css", line: 10, column: 3 });
  // Built line 13 is `.note,`, from src/theme.css:20:1.
  assert.deepEqual(plain(sm.lookup(map, 12, 0)), { source: "http://localhost:3000/src/theme.css", line: 20, column: 1 });
  assert.equal(sm.lookup(map, 400, 0), null);
});

test("a one-field segment starts unmapped code: a position after it maps to nothing", () => {
  const sm = load();
  const map = { sources: ["a.css"], lines: sm.decode("AAAA,K") };
  assert.deepEqual(plain(sm.lookup(map, 0, 2)), { source: "a.css", line: 1, column: 1 });
  assert.equal(sm.lookup(map, 0, 5), null);
});

test("a minified sheet's inline map is read from its data URL", async () => {
  const sm = load();
  const text = fixture("buttons.min.css");
  const map = await sm.forText(text, "http://localhost:3000/assets/buttons.min.css");
  // `.btn-primary` starts at column 22 of the one built line: src/buttons.css:5:1.
  assert.deepEqual(plain(sm.lookup(map, 0, 22)), { source: "http://localhost:3000/assets/src/buttons.css", line: 5, column: 1 });
});

test("an external map is fetched once per URL, relative to the sheet", async () => {
  const fetched = [];
  const sm = load(async (url) => {
    fetched.push(url);
    return { ok: true, text: async () => fixture("theme.css.map") };
  });
  const text = fixture("theme.css");
  const one = await sm.forText(text, "http://localhost:3000/theme.css");
  const two = await sm.forText(text, "http://localhost:3000/theme.css");
  assert.equal(one, two);
  assert.deepEqual(fetched, ["http://localhost:3000/theme.css.map"]);
  assert.equal(sm.cached("http://localhost:3000/theme.css.map"), one);
});

test("a sheet with no map, or a map that won't load, has none", async () => {
  const sm = load(async () => ({ ok: false, text: async () => "" }));
  assert.equal(await sm.forText(".a { color: red }", "http://localhost:3000/a.css"), null);
  assert.equal(await sm.forText(fixture("theme.css"), "http://localhost:3000/theme.css"), null);
  assert.equal(await sm.forText("/*# sourceMappingURL=data:application/json;base64,!!!! */", "http://localhost:3000/b.css"), null);
});

test("without fetching, only a cached map is given", async () => {
  const sm = load(async () => ({ ok: true, text: async () => fixture("theme.css.map") }));
  const text = fixture("theme.css");
  assert.equal(await sm.forText(text, "http://localhost:3000/theme.css", { fetch: false }), null);
  await sm.forText(text, "http://localhost:3000/theme.css");
  assert.ok(await sm.forText(text, "http://localhost:3000/theme.css", { fetch: false }));
});
