// The rails fixture: Rails 8, server-rendered, started twice. With template
// annotations on, the Rails mapper reads real BEGIN/END comments; with them
// off, there are search clues only, and the side panel suggests turning
// them on, once per site.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, open, setup, skipReason, tracer, until } from "./harness/index.js";

const fixture = loadFixture("rails");
const skip = skipReason(fixture) ?? false;
const off = { ...fixture, env: { ...fixture.env, ANNOTATE_VIEWS: "0" } };

describe("rails, annotations on", { skip }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases.filter((c) => c.annotations !== false)) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
  }

  test("an annotated app needs no suggestion", async () => {
    await open(env);
    assert.deepEqual(await env.tab.evaluate("ns.improvements.suggestions()"), []);
  });
});

describe("rails, annotations off", { skip }, () => {
  const env = setup(off);

  for (const c of fixture.cases.filter((c) => c.annotations === false)) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
  }

  test("the suggestion is still offered after the page's own pushState", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    const target = await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "the side panel" });
    const panel = await target.asPage();
    const shown = () => panel.evaluate(`!document.getElementById("rails-annotations").hidden`);
    await until(shown, { what: "the suggestion in the side panel" });
    await env.page.evaluate(`history.pushState({}, "", "/plans")`);
    await env.tab.until(`location.pathname === "/plans"`, { what: "the new path" });
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(await shown(), true, "the suggestion survives an in-app navigation");
  });

  test("the side panel suggests the annotations for the tab in front, and a dismissal is kept for the site", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    const target = await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "the side panel" });
    const panel = await target.asPage();
    const shown = () => panel.evaluate(`!document.getElementById("rails-annotations").hidden`);
    await until(shown, { what: "the suggestion in the side panel" });
    await panel.click("[data-dismiss=rails-annotations]");
    await until(async () => !(await shown()), { what: "the suggestion to go once dismissed" });
    await open(env);
    await env.tab.until(`ns.worker.connection === "connected"`, { what: "the page to connect again" });
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(await shown(), false, "a dismissed suggestion stays dismissed for the site");
  });
});
