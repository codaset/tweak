// The Svelte mapper (design.md § Finding the source): the page probe reads
// the element's __svelte_meta and the content script turns it into
// locations. Run over metadata captured from real Vite dev builds, saved in
// test/extension/fixtures/: svelte5/ from the sveltekit fixture (Svelte
// 5.59.2, SvelteKit 3.4.1; the repo's path replaced by /home/dev/tweak), and
// svelte4/ from a Svelte 4.2.20 app on Vite 5.4.21 (plugin-svelte 3.1.2)
// with the same components, which has no fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dump, load, probe } from "./probe-world.js";

test("Svelte 5: loc gives the element's file, line and column; parent gives where each component is used, named", async () => {
  const { map, element } = load();
  // Button.svelte:5:1 is the <button> tag; Toolbar.svelte:6:3 is <Button>;
  // +page.svelte:8:3 is <Toolbar>. SvelteKit's own components (in
  // node_modules) and the blocks between (if, snippets) are left out.
  assert.deepEqual(await map("svelte", element(dump("svelte5", "export-button"))), [
    { file: "src/lib/Button.svelte", line: 5, column: 1, role: "element", via: "svelte" },
    { file: "src/lib/Toolbar.svelte", line: 6, column: 3, role: "usage", via: "svelte", name: "Button" },
    { file: "src/routes/+page.svelte", line: 8, column: 3, role: "usage", via: "svelte", name: "Toolbar" },
  ]);
});

test("Svelte 5: children passed to a component stay in the file that wrote them; the component is used there", async () => {
  const { map, element } = load();
  assert.deepEqual(await map("svelte", element(dump("svelte5", "save"))), [
    { file: "src/routes/+page.svelte", line: 10, column: 5, role: "element", via: "svelte" },
    { file: "src/routes/+page.svelte", line: 9, column: 3, role: "usage", via: "svelte", name: "Panel" },
  ]);
  // The page's own markup is used only by SvelteKit: no usage.
  assert.deepEqual(await map("svelte", element(dump("svelte5", "title"))), [
    { file: "src/routes/+page.svelte", line: 7, column: 3, role: "element", via: "svelte" },
  ]);
});

test("Svelte 5: a parent without a type (as earlier 5.x gave them) counts as a component's usage", async () => {
  const { map, element } = load();
  const meta = { loc: { file: "src/Card.svelte", line: 5, column: 2 }, parent: { file: "src/App.svelte", line: 4, column: 38, parent: null } };
  assert.deepEqual(await map("svelte", element({ __svelte_meta: meta })), [
    { file: "src/Card.svelte", line: 5, column: 3, role: "element", via: "svelte" },
    { file: "src/App.svelte", line: 4, column: 39, role: "usage", via: "svelte" },
  ]);
});

test("Svelte 4: loc's 0-based line is made 1-based; there is no usage site", async () => {
  const { map, element } = load();
  // <button> is on line 5 of Button.svelte; Svelte 4 says 4.
  assert.deepEqual(await map("svelte", element(dump("svelte4", "export-button"))), [
    { file: "src/Button.svelte", line: 5, column: 1, role: "element", via: "svelte" },
  ]);
  assert.deepEqual(await map("svelte", element(dump("svelte4", "save"))), [
    { file: "src/App.svelte", line: 10, column: 5, role: "element", via: "svelte" },
  ]);
});

test("Svelte: an element without metadata, or with a malformed loc, gives nothing", async () => {
  const { map, element } = load();
  assert.deepEqual(await map("svelte", element()), []);
  assert.deepEqual(await map("svelte", element({ __svelte_meta: { loc: { line: 3 } } })), []);
  // A file with no usable line is file only.
  assert.deepEqual(await map("svelte", element({ __svelte_meta: { loc: { file: "src/A.svelte", line: -1 }, parent: null } })), [
    { file: "src/A.svelte", role: "element", via: "svelte" },
  ]);
});

test("the probe answers svelte with a JSON string, the parents copied (they're circular in the page)", () => {
  const page = load();
  const d = dump("svelte5", "save");
  d.__svelte_meta.component = d.__svelte_meta; // as circular as the page's
  const [heard] = probe(page, page.element(d), JSON.stringify({ id: "s1", what: "svelte" }));
  assert.equal(JSON.parse(heard).id, "s1");
  assert.ok(JSON.parse(heard).svelte);
});
