// The sveltekit fixture: Svelte 5's __svelte_meta, exact to the line, with
// parent for where each component is used (design.md § Finding the source),
// on a page SvelteKit renders on the server and then hydrates. The edge
// cases, Svelte 4's 0-based lines among them, are unit tests over captured
// metadata (test/extension/svelte.test.js); this proves the wiring.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, open, setup, skipReason, tracer } from "./harness/index.js";

const fixture = loadFixture("sveltekit");

describe("sveltekit", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
  }

  test("the probe gives the element's place and its usage sites, and writes nothing onto the page", async () => {
    await open(env);
    await env.page.evaluate(() => {
      window.changed = [];
      new MutationObserver((records) => window.changed.push(...records.map((r) => `${r.target.nodeName} ${r.attributeName}`))).observe(document, {
        attributes: true,
        subtree: true,
      });
    });
    const found = await env.tab.evaluate(`ns.frameworks.svelte.map(document.querySelector(".export-button"))`);
    assert.deepEqual(
      found.map((l) => [l.role, l.name ?? "", `${l.file}:${l.line}:${l.column}`]),
      [
        ["element", "", "src/lib/Button.svelte:5:1"],
        ["usage", "Button", "src/lib/Toolbar.svelte:6:3"],
        ["usage", "Toolbar", "src/routes/+page.svelte:8:3"],
      ],
    );
    assert.deepEqual(await env.page.evaluate(() => window.changed), []);
  });
});
