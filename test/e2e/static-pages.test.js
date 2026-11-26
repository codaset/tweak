// The static fixture: no framework, a server that never reloads.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { standIn } from "./harness/claude.js";
import { sleep } from "./harness/util.js";
import { basename, dirname, join } from "node:path";
import { contentScript, inWorker } from "./harness/browser.js";
import { freePort } from "./harness/fixture.js";
import { briefProblems } from "./harness/golden.js";
import {
  autoReload,
  CARD,
  CARD_RESEND,
  CARD_STATUS,
  CARD_TITLE,
  CARD_UNDO,
  CARD_ACTION,
  COMPOSER_INPUT,
  REPLY_INPUT,
  REPLY_SEND,
  RESOLVED_ROW,
  conversation,
  finishFromCard,
  loadFixture,
  mark,
  marked,
  open,
  pick,
  setup,
  sidePanel,
  skipReason,
  strandNothing,
  tracer,
  undoFromCard,
  until,
} from "./harness/index.js";
import { composing, noCard, hit, text, sendTweak, storedScreenshot, expectedCrop, panelTarget, closeSidePanel, panelPage } from "./static-shared.js";

const fixture = loadFixture("static");

// Navigation, other tabs, and finding sources: @scope rules, Rails templates, a large stylesheet.
describe("static, pages, tabs and sources", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
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
      const n = await tracer(env, fixture.cases[0], { request: "tweak the save button from the first tab", edit: null });
      await tab2.until(`ns.page.tweak(${n})?.status`, { is: (s) => s === "done", what: `tweak ${n} to reach the second tab as done` });
      await tab2.until(`ns.pins.point(${n}) !== null`, { what: "the second tab's pin" });
      assert.equal(await tab2.evaluate(noCard), true, "no card in the second tab");
    } finally {
      await other.close();
    }
  });

  test("a question opens only in the tab its tweak was sent from; with that tab gone, it's a toast in the others", async () => {
    await open(env);
    const page = await env.browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    const sender = { ...env, page, tab: await contentScript(page) };
    await open(sender);
    await page.bringToFront();
    const send = async (selector, request) => {
      await pick(sender, { selector });
      await sender.tab.until(composing, { what: "the composer to open with the focus" });
      await page.keyboard.type(request);
      const from = env.watcher.lines.length;
      await page.keyboard.press("Enter");
      const { number } = await env.claude.nextTweak(env.watcher, { from });
      await sender.tab.until(`root.querySelector(".panel .title")?.textContent`, { is: (t) => t === `Tweak ${number}`, what: `the card of tweak ${number}` });
      await page.keyboard.press("Escape");
      await sender.tab.until(noCard, { what: "esc to close the card" });
      return number;
    };
    const first = await send("#name", "tweak the name field, then ask");
    const second = await send("#docs", "tweak the docs link, ask once I've gone");

    await env.claude.tweak("ask", String(first), "Which colour?");
    await sender.tab.until(`ns.panel.showing()`, { is: (n) => n === first, what: "the question to open its card in the sending tab" });
    await env.tab.until(`ns.page.tweak(${first})?.status`, { is: (s) => s === "question", what: "the question to reach the other tab" });
    assert.equal(await env.tab.evaluate(noCard), true, "no card in the other tab");
    assert.equal(await env.tab.evaluate(`root.querySelector(".toast") === null`), true, "no toast while the sending tab is there");

    await page.close();
    await env.page.bringToFront();
    await env.claude.tweak("ask", String(second), "Which shade?");
    await env.tab.until(`root.querySelector(".toast")?.textContent`, {
      is: (t) => t === `Claude has a question about tweak ${second}`,
      what: "a toast once the sending tab has gone",
    });
    assert.equal(await env.tab.evaluate(noCard), true, "the toast doesn't open the card");
  });

  // Rule gathering needs the CSSOM, so these run in the page: :scope in an
  // @scope is the scope root, never the element itself.
  test("a rule in an @scope matches from its scope root: :scope is the root", async () => {
    await open(env);
    const rules = await env.tab.evaluate(`(() => {
      const style = document.createElement("style");
      style.textContent = "@scope (.card) { :scope > button { color: red } :scope { color: blue } & > .x { color: green } }";
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = "<button>in</button><p><button>deeper</button></p><span class='x'>x</span>";
      const outside = document.createElement("button");
      document.body.append(style, card, outside);
      const selectors = (el) => (ns.context.element(el).rules ?? []).map((r) => r.selector).filter((s) => s.startsWith("@scope"));
      const got = {
        child: selectors(card.querySelector("button")),
        deeper: selectors(card.querySelector("p button")),
        root: selectors(card),
        amp: selectors(card.querySelector(".x")),
        outside: selectors(outside),
      };
      style.remove(), card.remove(), outside.remove();
      return got;
    })()`);
    assert.deepEqual(rules, {
      child: ["@scope (.card) { :scope > button }"],
      deeper: [],
      root: ["@scope (.card) { :scope }"],
      amp: ["@scope (.card) { & > .x }"],
      outside: [],
    });
  });

  // The Rails mapper's walk is the browser's own TreeWalker, so it runs
  // here, over the rails fixture's captured annotated HTML.
  test("Rails templates are found over the captured annotated HTML, and again once a partial is added", async () => {
    await open(env);
    const html = readFileSync(new URL("../extension/fixtures/rails/annotated.html", import.meta.url), "utf8");
    const got = await env.tab.evaluate(`(async () => {
      const doc = new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html");
      const files = async (selector) => (await ns.mappers.run(doc.querySelector(selector), { rules: [] })).map((l) => l.file);
      const signup = await files("[data-testid=signup]");
      const team = await files(".plan-row:nth-child(2)");
      const header = await files("#home");
      // A partial rendered in later, as Turbo or a live update would.
      const main = doc.querySelector("main");
      main.append(doc.createComment(" BEGIN app/views/pages/_later.html.erb\\n"), Object.assign(doc.createElement("p"), { id: "later" }), doc.createComment(" END app/views/pages/_later.html.erb "));
      await new Promise((done) => setTimeout(done));
      const later = await files("#later");
      return { signup, team, header, later };
    })()`);
    const layout = "app/views/layouts/application.html.erb";
    assert.deepEqual(got, {
      signup: ["app/views/pages/_signup.html.erb", "app/views/pages/home.html.erb", layout],
      team: ["app/views/pages/_plan.html.erb", "app/views/pages/home.html.erb", layout],
      header: ["app/views/shared/_header.html.erb", layout],
      later: ["app/views/pages/_later.html.erb", layout],
    });
  });

  // Hovering stays cheap on a big page: 20,000 rules in a <style> with a
  // large inline source map, and thousands of comments. Each hover is well
  // under the label's 60 ms debounce.
  test("repeated hovers on a page with 20,000 rules and a large inline map stay well under 60 ms", async (t) => {
    await open(env);
    const times = await env.tab.evaluate(`(async () => {
      const n = 20000;
      const css = Array.from({ length: n }, (_, i) => ".r" + i + " { color: red }").join("\\n") + "\\n#save { color: blue }";
      const map = { version: 3, sources: ["big.css"], names: [], mappings: "AAAA" + ";AACA".repeat(n) };
      const style = document.createElement("style");
      style.textContent = css + "\\n/*# sourceMappingURL=data:application/json;base64," + btoa(JSON.stringify(map)) + " */";
      const comments = document.createElement("div");
      for (let i = 0; i < 5000; i++) comments.append(document.createComment(" note " + i));
      document.head.append(style);
      document.body.append(comments);
      const el = document.getElementById("save");
      try {
        const first = await ns.hover.source(el);
        const times = [];
        for (let i = 0; i < 10; i++) {
          const t0 = performance.now();
          await ns.hover.source(el);
          times.push(performance.now() - t0);
        }
        const t1 = performance.now();
        for (let i = 0; i < 10; i++) ns.context.rules(el);
        return { first, times, walk: (performance.now() - t1) / 10 };
      } finally {
        style.remove();
        comments.remove();
      }
    })()`);
    t.diagnostic(`hover with 20,000 rules: ${times.times.map((ms) => ms.toFixed(1)).join(", ")} ms; the CSSOM walk alone ${times.walk.toFixed(1)} ms`);
    assert.equal(times.first, "big.css:20001", "the inline map gives #save its line");
    const median = [...times.times].sort((a, b) => a - b)[5];
    // What a hover repeats is cached, so it costs about the CSSOM walk the
    // element needs anyway (about 10 ms here, 30 on a busy CI runner).
    assert.ok(median < times.walk * 1.5 + 5, `a hover takes ${median.toFixed(1)} ms (median), the walk alone ${times.walk.toFixed(1)} ms`);
    assert.ok(median < 60, `a hover takes ${median.toFixed(1)} ms (median): over the 60 ms debounce`);
  });
});
