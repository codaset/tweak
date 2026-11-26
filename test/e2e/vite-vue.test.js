// The vite-vue fixture: Vue 3's type.__file, file only, and the brief's
// Vue variant (design.md § Finding the source). The edge cases are unit
// tests over captured instances (test/extension/vue.test.js); this proves
// the wiring in a real page.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, open, setup, skipReason, tracer } from "./harness/index.js";

const fixture = loadFixture("vite-vue");

describe("vite-vue", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
  }

  test("the probe gives the component files it's rendered inside, and writes nothing onto the page", async () => {
    await open(env);
    await env.page.evaluate(() => {
      window.changed = [];
      new MutationObserver((records) => window.changed.push(...records.map((r) => `${r.target.nodeName} ${r.attributeName}`))).observe(document, {
        attributes: true,
        subtree: true,
      });
    });
    const found = await env.tab.evaluate(`ns.frameworks.vue.map(document.querySelector(".export-button"))`);
    assert.deepEqual(
      found.map((l) => [l.role, l.name ?? "", l.file.slice(l.file.lastIndexOf("/src/")), l.line ?? null]),
      [
        ["element", "", "/src/Button.vue", null],
        ["component", "Button", "/src/Button.vue", null],
        ["component", "Toolbar", "/src/Toolbar.vue", null],
        ["component", "App", "/src/App.vue", null],
      ],
    );
    assert.deepEqual(await env.page.evaluate(() => window.changed), []);
  });
});
