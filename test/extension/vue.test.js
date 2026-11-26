// The Vue 3 mapper (design.md § Finding the source): the page probe reads
// the component instance that rendered the element and the content script
// turns it into file-only locations. Run over dumps captured from the
// vite-vue fixture (Vue 3.5.46, plugin-vue 6.0.11), saved in
// test/extension/fixtures/vue/: the element's __vnode.ctx and
// __vueParentComponent, each instance's type and parent, nested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dump, load, plain, probe } from "./probe-world.js";

// The vite-vue copy the dumps were captured from.
const V = "/private/var/folders/c4/f_jd56vn60bf888tcj7zc6500000gn/T/tweak-e2e-vite-vue-fIFb7h/src/";

test("Vue: the component's type.__file gives the element's file only; the components it's rendered inside follow, named", async () => {
  const { map, element } = load();
  assert.deepEqual(await map("vue", element(dump("vue", "export-button"))), [
    { file: `${V}Button.vue`, role: "element", via: "vue" },
    { file: `${V}Button.vue`, role: "component", via: "vue", name: "Button" },
    { file: `${V}Toolbar.vue`, role: "component", via: "vue", name: "Toolbar" },
    { file: `${V}App.vue`, role: "component", via: "vue", name: "App" },
  ]);
});

test("Vue: slot content belongs to the component whose template wrote it, not the one whose slot renders it", async () => {
  const { map, element } = load();
  // The save button is written in App, inside <Panel>: __vueParentComponent
  // is Panel, but the template it's in is App's.
  assert.deepEqual(await map("vue", element(dump("vue", "save"))), [
    { file: `${V}App.vue`, role: "element", via: "vue" },
    { file: `${V}App.vue`, role: "component", via: "vue", name: "App" },
  ]);
});

test("Vue: without a vnode's owner, the parent component is read; without either, nothing", async () => {
  const { map, element } = load();
  const { __vueParentComponent } = dump("vue", "panel-title");
  assert.deepEqual((await map("vue", element({ __vueParentComponent })))[0], { file: `${V}Panel.vue`, role: "element", via: "vue" });
  assert.deepEqual(await map("vue", element()), []);
  // A component with no __file (written in plain JS) gives no place of its own.
  const noFile = { __vnode: { ctx: { type: { name: "Inline" }, parent: dump("vue", "title").__vnode.ctx } } };
  assert.deepEqual(await map("vue", element(noFile)), [{ file: `${V}App.vue`, role: "component", via: "vue", name: "App" }]);
});

test("the probe answers vue with a JSON string, and the Vue mapper runs after React, ahead of the DOM mappers", async () => {
  const page = load();
  const el = page.element(dump("vue", "title"));
  const [heard] = probe(page, el, JSON.stringify({ id: "v1", what: "vue" }));
  assert.equal(JSON.parse(heard).id, "v1");
  assert.deepEqual(plain(page.ns.frameworks.mappers.map((m) => m.via)), ["react", "vue", "svelte"]);
  const [first] = plain(await page.ns.mappers.run(el, { rules: [] }));
  assert.deepEqual(first, { file: `${V}App.vue`, role: "element", via: "vue" });
});
