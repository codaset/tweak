// The static fixture: no framework, a server that never reloads.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { conversation, loadFixture, open, setup, skipReason, tracer, until } from "./harness/index.js";

const fixture = loadFixture("static");

describe("static", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
    test(`${c.name}: Claude asks, the developer replies from the card, then Done`, () => conversation(env, c));
  }

  // The harness itself, once, here.
  test("the test copy's message calls a worker handler: the side panel opens", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "a side panel target" });
  });

  test("after a navigation the content script handle reaches the new page, never the old one", async () => {
    await open(env);
    await env.tab.evaluate(`(globalThis.e2eMarker = "old page", true)`);
    await open(env, "/again");
    assert.equal(await env.tab.evaluate(`globalThis.e2eMarker ?? "new page"`), "new page");
  });

  test("the fixture can be served again on 127.0.0.1", async () => {
    const again = await env.serve("127.0.0.1");
    assert.equal(again.url("/"), `http://127.0.0.1:${again.port}/`);
    assert.equal((await fetch(again.url("/"))).status, 200);
  });
});
