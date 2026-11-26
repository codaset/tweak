// The static fixture: no framework, a server that never reloads.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentScript } from "./harness/browser.js";
import { CARD, CARD_RESEND, CARD_STATUS, COMPOSER_INPUT, conversation, loadFixture, open, pick, setup, skipReason, tracer, until } from "./harness/index.js";

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
        return { first, times };
      } finally {
        style.remove();
        comments.remove();
      }
    })()`);
    t.diagnostic(`hover with 20,000 rules: ${times.times.map((ms) => ms.toFixed(1)).join(", ")} ms`);
    assert.equal(times.first, "big.css:20001", "the inline map gives #save its line");
    const median = [...times.times].sort((a, b) => a - b)[5];
    assert.ok(median < 30, `a hover takes ${median.toFixed(1)} ms (median), not well under 60`);
  });
});

// No lost tweaks (design.md): a stand-in that watches but never runs tweak
// work. Its own bridge waits 1 s instead of 3 minutes before an again: line,
// so no other test sees them.
describe("static, when Claude doesn't pick a tweak up", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture, { againAfter: "1s" });
  const status = `root.querySelector(${JSON.stringify(CARD_STATUS)})?.textContent`;
  const offered = `(() => { const b = root.querySelector(${JSON.stringify(CARD_RESEND)}); return Boolean(b) && !b.closest(".retry").hidden; })()`;
  const busy = "Claude hasn't picked this up. The session may be busy.";

  test("it comes back as again: twice, then the card offers Send again, which sends one more", async () => {
    await open(env);
    await pick(env, { selector: "#save" });
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer" });
    await env.page.keyboard.type("make the save button green");
    await env.page.keyboard.press("Enter");
    const [line, n] = await env.watcher.line(/^tweak (\d+) new: .*/);
    await env.tab.until(status, { is: (s) => s === "Claude has it", what: "the card to show Claude has it" });

    const again = new RegExp(`^tweak ${n} again: ${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    const first = await env.watcher.line(again);
    const second = await env.watcher.line(again, { from: env.watcher.lines.indexOf(first[0]) + 1 });
    assert.ok(second, "a second again: line");
    await env.tab.until(status, { is: (s) => s === busy, what: "the card to say Claude hasn't picked it up" });
    await env.tab.until(offered, { what: "Send again" });    assert.equal(await env.tab.evaluate(`ns.page.tweak(${n}).status`), "delivered", "the status stays delivered");

    const from = env.watcher.lines.length;
    await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_RESEND)}).click()`);
    await env.watcher.line(again, { from });
    await env.tab.until(status, { is: (s) => s === "Claude has it", what: "the card to wait for Claude again" });
    assert.equal(await env.tab.evaluate(offered), false, "Send again goes while the line is on its way");
    await env.tab.until(status, { is: (s) => s === busy, what: "the card to say so again once that goes unanswered" });
    assert.equal(env.watcher.lines.filter((l) => again.test(l)).length, 3, "the bridge sent it again only twice by itself");

    await env.claude.work(n);
    await env.tab.until(status, { is: (s) => s?.startsWith("Claude is working on it"), what: "work to confirm it" });
    assert.equal(await env.tab.evaluate(offered), false, "no Send again once Claude has it");
  });

  // Send waits for the mappers if they haven't finished. A send given back
  // meanwhile (the port went) never resumes: only the retry is sent.
  test("a send given back while it waits for the mappers isn't sent; only its retry is", async () => {
    await open(env);
    await env.tab.evaluate(`(() => {
      const locate = ns.context.locate;
      ns.context.locate = (...a) => new Promise((done) => (globalThis.e2eMapped = () => locate(...a).then(done)));
      globalThis.e2eCreates = 0;
      const post = ns.worker.post;
      ns.worker.post = (msg) => (msg.type === "create" && e2eCreates++, post(msg));
      globalThis.e2eRestore = () => ((ns.context.locate = locate), (ns.worker.post = post));
      return true;
    })()`);
    try {
      await pick(env, { selector: "#name" });
      await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("tweak the name field once");
      await env.page.keyboard.press("Enter");
      await env.tab.evaluate(`ns.panel.unsent("Not connected to Tweak")`);
      await env.page.keyboard.press("Enter"); // the retry, still waiting
      const from = env.watcher.lines.length;
      await env.tab.evaluate(`e2eMapped()`);
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.tab.until(`ns.panel.showing()`, { is: (s) => s === n, what: `the card of tweak ${n}` });
      assert.equal(await env.tab.evaluate("e2eCreates"), 1, "one create, from the retry");
    } finally {
      await env.tab.evaluate("e2eRestore()");
      await env.page.keyboard.press("Escape");
    }
  });
});
