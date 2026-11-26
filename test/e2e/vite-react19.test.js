// The vite-react19 fixture: React 19's _debugStack, frame 1 mapped through
// the inline source map of the module Vite served (design.md § Finding the
// source). The edge cases are unit tests over captured fibers
// (test/extension/react.test.js); this proves the wiring in a real page.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, open, setup, skipReason, tracer } from "./harness/index.js";

const fixture = loadFixture("vite-react19");

describe("vite-react19", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
  }

  test("the probe gives the components it's rendered inside, through the maps, and writes nothing onto the page", async () => {
    await open(env);
    // Every attribute change in the page, from its own world.
    await env.page.evaluate(() => {
      window.changed = [];
      new MutationObserver((records) => window.changed.push(...records.map((r) => `${r.target.nodeName} ${r.attributeName}`))).observe(document, {
        attributes: true,
        subtree: true,
      });
    });
    const found = await env.tab.evaluate(`ns.frameworks.react.map(document.querySelector(".export-button"))`);
    const at = (l) => `${new URL(l.file).pathname}:${l.line}:${l.column}`;
    assert.deepEqual(
      found.map((l) => [l.role, l.name ?? "", at(l)]),
      [
        ["element", "", "/src/Button.jsx:3:5"],
        ["component", "Button", "/src/Button.jsx:3:5"],
        ["component", "Toolbar", "/src/Toolbar.jsx:6:7"],
        ["component", "App", "/src/App.jsx:8:7"],
      ],
    );
    assert.deepEqual(await env.page.evaluate(() => window.changed), []);
  });
});
