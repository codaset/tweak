// The static fixture: no framework, a server that never reloads.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, open, setup, skipReason, tracer, until } from "./harness/index.js";

const fixture = loadFixture("static");

describe("static", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
  }

  test("the test copy's message calls a worker handler: the side panel opens", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    const panel = await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")));
    assert.ok(panel, "a side panel target appears");
  });
});
