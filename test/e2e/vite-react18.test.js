// The vite-react18 fixture: React 18's _debugSource on a Vite dev server
// (design.md § Finding the source). The edge cases are unit tests over
// captured fibers (test/extension/react.test.js); this proves the wiring in
// a real page.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { loadFixture, open, setup, skipReason, tracer } from "./harness/index.js";

const fixture = loadFixture("vite-react18");

describe("vite-react18", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
  }

  test("the probe gives the components it's rendered inside, each in its own file", async () => {
    await open(env);
    const found = await env.tab.evaluate(`ns.frameworks.react.map(document.querySelector(".export-button"))`);
    const folder = realpathSync(env.app.folder);
    const at = (l) => `${realpathSync(l.file).slice(folder.length)}:${l.line}:${l.column}`;
    assert.deepEqual(
      found.map((l) => [l.role, l.name ?? "", at(l)]),
      [
        ["element", "", "/src/Button.jsx:3:5"],
        ["component", "Button", "/src/Button.jsx:3:5"],
        ["component", "Toolbar", "/src/Toolbar.jsx:6:7"],
        ["component", "App", "/src/App.jsx:8:7"],
      ],
    );
  });
});
