// The static fixture: no framework, a server that never reloads.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { contentScript } from "./harness/browser.js";
import { CARD, COMPOSER_INPUT, conversation, loadFixture, open, pick, setup, skipReason, tracer, until } from "./harness/index.js";

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

  // Overlay layering (design.md § Overlay layering): what the overlay draws
  // is what the page's own hit test finds, over a modal dialog and a popover.
  const hit = (selector) => `(() => {
    const r = root.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return Boolean(r?.width) && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === ns.overlay.host;
  })()`;
  const composing = `root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`;
  const noCard = `!root.querySelector(${JSON.stringify(CARD)})`;

  test("over a modal dialog the overlay is hittable, esc leaves the dialog open, and the host moves back on close", async () => {
    await open(env);
    await env.page.click("#open-profile");
    await pick(env, { selector: "#profile-save" });
    await env.tab.until(composing, { what: "the composer to open in the dialog with the focus" });
    await env.tab.until(hit(CARD), { what: "the composer to be hittable over the dialog" });
    await env.page.keyboard.press("Escape");
    await env.tab.until(noCard, { what: "esc to close the composer" });
    assert.equal(await env.page.evaluate(`document.getElementById("profile").open`), true, "esc in the overlay leaves the page's dialog open");
    await env.page.evaluate(`document.getElementById("profile").close()`);
    await env.tab.until(`ns.overlay.host.parentNode === document.documentElement && ns.overlay.host.matches(":popover-open")`, {
      what: "the host back on the document, shown, once the dialog closes",
    });
  });

  test("with two modal dialogs open, the host is in the one opened last, then in the one under it", async () => {
    await open(env);
    const inside = (id) => `ns.overlay.host.parentNode === document.getElementById(${JSON.stringify(id)}) && ns.overlay.host.matches(":popover-open")`;
    // #confirm comes first in the document but opens second, in the same task.
    await env.page.evaluate(`document.getElementById("profile").showModal(); document.getElementById("confirm").showModal()`);
    await env.tab.until(inside("confirm"), { what: "the host in the dialog opened last" });
    await env.page.evaluate(`document.getElementById("confirm").close()`);
    await env.tab.until(inside("profile"), { what: "the host in the dialog left open" });
    await env.page.evaluate(`document.getElementById("profile").close()`);
    await env.tab.until(`ns.overlay.host.parentNode === document.documentElement`, { what: "the host back on the document" });
  });

  test("a page popover opened while composing goes under the overlay, and the draft keeps the focus", async () => {
    await open(env);
    await pick(env, { selector: "#save" });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type("draft");
    await env.page.evaluate(`document.getElementById("help").showPopover()`);
    await env.tab.until(hit(CARD), { what: "the composer to be hittable over the page's popover" });
    assert.equal(await env.page.evaluate(`document.getElementById("help").matches(":popover-open")`), true, "the page's popover stays open");
    assert.equal(await env.tab.evaluate(composing), true, "the composer keeps the focus");
    assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(COMPOSER_INPUT)}).value`), "draft");
    await env.page.evaluate(`document.getElementById("help").hidePopover()`);
    await env.page.keyboard.press("Escape");
    await env.tab.until(noCard, { what: "esc to close the composer" });
  });

  // Client-side navigation (design.md § Pages and tabs): the page's own
  // pushState is a page change the content script hears.
  test("a pushState page change records the new path", async () => {
    await open(env);
    await env.page.evaluate(`history.pushState({}, "", "/pushed")`);
    await pick(env, { selector: "#save" });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type("tweak the save button after pushState");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    await env.tab.until(`ns.page.tweak(${n})?.page`, { is: (p) => p === env.app.url("/pushed"), what: `tweak ${n} on the new path` });
    await env.tab.until(`ns.pins.point(${n}) !== null`, { what: "the new page's pin" });
    await env.page.keyboard.press("Escape");
    await env.page.evaluate(`history.pushState({}, "", "/")`);
    await env.tab.until(`ns.pins.point(${n}) === null`, { what: "the pin to leave with its page" });
  });

  // Pages and tabs: events reach every tab showing the page; the card opens
  // only in the tab the tweak was sent from.
  test("a second tab on the page gets the pin and its changes, but not the card", async () => {
    const other = await env.browser.newPage();
    try {
      await other.setViewport({ width: 1100, height: 800 });
      const tab2 = await contentScript(other);
      await other.goto(env.app.url("/"));
      await tab2.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the second tab to connect" });
      await env.page.bringToFront();
      const n = await tracer(env, fixture.cases[0], { request: "tweak the save button from the first tab" });
      await tab2.until(`ns.page.tweak(${n})?.status`, { is: (s) => s === "done", what: `tweak ${n} to reach the second tab as done` });
      await tab2.until(`ns.pins.point(${n}) !== null`, { what: "the second tab's pin" });
      assert.equal(await tab2.evaluate(noCard), true, "no card in the second tab");
    } finally {
      await other.close();
    }
  });
});
