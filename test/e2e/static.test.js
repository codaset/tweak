// The static fixture: no framework, a server that never reloads.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentScript, inWorker } from "./harness/browser.js";
import { CARD, CARD_RESEND, CARD_STATUS, COMPOSER_INPUT, conversation, loadFixture, open, pick, setup, skipReason, tracer, undoFromCard, until } from "./harness/index.js";

const fixture = loadFixture("static");

describe("static", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
    test(`${c.name}: Claude asks, the developer replies from the card, then Done`, () => conversation(env, c));
  }

  // An Undo around a later edit on the same line conflicts: nothing is
  // written, and the session reverses it by hand.
  test("an Undo that conflicts goes to Claude, which reverses it by hand with tweak undo and tweak undone", async () => {
    const c = fixture.cases.find((x) => x.edit);
    const path = join(env.app.folder, c.edit.file);
    const original = readFileSync(path);
    try {
      await conflictByHand(c, path, original);
    } finally {
      writeFileSync(path, original); // later tests share the copy
    }
  });

  async function conflictByHand(c, path, original) {
    const n = await tracer(env, c, { undo: false });
    const later = readFileSync(path, "utf8").replace(c.edit.replace, c.edit.replace.replace("<", " now<"));
    writeFileSync(path, later); // the developer edits the changed line again

    await open(env, c.path ?? "/");
    await env.tab.evaluate(`ns.panel.show(${n}, { focus: true })`);
    const from = env.watcher.lines.length;
    await undoFromCard(env, { note: "Undo needs Claude: 1 of 1 files changed since" });
    assert.equal(readFileSync(path, "utf8"), later, "nothing was written");
    await env.watcher.line(new RegExp(`^tweak ${n} undo-conflict: 1 of 1 files need resolving$`), { from });

    const change = await env.claude.tweak("undo", String(n));
    assert.ok(change.includes(`## \`${c.edit.file}\`: conflicts`), `tweak undo marks the conflict:\n${change}`);
    writeFileSync(path, original); // reversed by hand
    assert.equal(await env.claude.tweak("undone", String(n), "put the label back"), `tweak ${n}: undone\n`);
    await env.tab.until(`root.querySelector(".panel .undo .undo-note")?.textContent`, { is: (s) => s === "Undone", what: "the card to say Undone" });
    await env.page.keyboard.press("Escape");
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
  // Not null === null: the composer opens once the pick's capture is taken.
  const composing = `Boolean(root.activeElement) && root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`;
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

  // Pointing at more (design.md § Pointing at things): the gestures
  // themselves. What reaches the brief is in the golden cases above.
  const numbers = `[...root.querySelectorAll(".marks .mark.kind-element .mark-number")].map((b) => b.textContent)`;
  const untouched = async () => {
    assert.deepEqual(await env.page.evaluate(`window.heard`), [], "the page heard no click");
    assert.equal(await env.page.evaluate(`getSelection().toString()`), "", "no text on the page was selected");
  };

  test("⇧-click numbers each element on the page, takes one out again, and the card's pin sits on element 1", async () => {
    await open(env);
    await env.page.evaluate(`window.heard.length = 0; getSelection().removeAllRanges()`);
    await env.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    try {
      await pick(env, { selectors: ["#name", "#save", "#docs"] });
      await env.tab.until(numbers, { is: (n) => n?.join() === "1,2,3", what: "elements numbered 1 to 3" });
      assert.equal(await env.tab.evaluate(`getComputedStyle(root.querySelector(".marks .mark")).animationName`), "none", "no motion when it's reduced");
      assert.equal(await env.tab.evaluate(`root.querySelector(".panel .chip").textContent`), "3 elements");
      assert.equal(await env.tab.evaluate(composing), true, "the composer keeps the focus");
      await env.page.keyboard.type("make these match");

      // A plain ⇧-click (no ⌥) on one already in takes it out, and the rest renumber.
      const save = await (await env.page.$("#save")).boundingBox();
      await env.page.keyboard.down("Shift");
      await env.page.mouse.click(save.x + save.width / 2, save.y + save.height / 2);
      await env.page.keyboard.up("Shift");
      await env.tab.until(`ns.panel.targets().elements.map((e) => e.label).join()`, { is: (l) => l === "input#name,a#docs", what: "#save taken out" });
      await env.tab.until(numbers, { is: (n) => n?.join() === "1,2", what: "the rest renumbered" });
      assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(COMPOSER_INPUT)}).value`), "make these match", "the draft is kept");
      assert.match(await env.tab.evaluate(`root.querySelector(".panel [aria-live]").textContent`), /taken out/);
      await untouched();

      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.tab.until(`root.querySelector(".panel .title")?.textContent`, { is: (t) => t === `Tweak ${n}`, what: `the card of tweak ${n}` });
      await env.tab.until(numbers, { is: (l) => l?.join() === "1,2", what: "the card outlining its elements, numbered" });
      const pin = await env.tab.evaluate(`ns.pins.point(${n})`);
      const name = await (await env.page.$("#name")).boundingBox();
      assert.ok(pin.x >= name.x && pin.x <= name.x + name.width && pin.y >= name.y && pin.y <= name.y + name.height, "the pin is on element 1");
      await env.claude.tweakWith("done\n", "done", String(n), "-");
      await env.page.keyboard.press("Escape");
      await env.tab.until(noCard, { what: "esc to close the card" });
      assert.equal(await env.tab.evaluate(`root.querySelectorAll(".marks .mark").length`), 0, "no marks once the card closes");
    } finally {
      await env.page.emulateMediaFeatures([]);
    }
  });

  test("an ⌥-drag draws its box; esc cancels it, and neither the page nor the open composer hears the esc", async () => {
    await open(env);
    await pick(env, { selector: "#docs" });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.evaluate(`window.heard.length = 0; getSelection().removeAllRanges(); window.keys = []; addEventListener("keydown", (e) => keys.push(e.key))`);
    await env.page.keyboard.down("Alt");
    try {
      await env.page.mouse.move(60, 150);
      await env.page.mouse.down();
      await env.page.mouse.move(360, 230, { steps: 6 });
      await env.tab.until(`(() => { const b = root.querySelector(".area-box"); return b && !b.hidden && b.style.width; })()`, {
        is: (w) => w === "300px",
        what: "the drag box, 300px wide",
      });
      assert.equal(await env.tab.evaluate(`root.querySelector(".area-tag").textContent`), "Area300×80");
      await env.page.keyboard.press("Escape");
      await env.tab.until(`root.querySelector(".area-box").hidden`, { what: "esc to cancel the drag" });
      await env.page.mouse.move(380, 240, { steps: 2 });
      await env.page.mouse.up();
    } finally {
      await env.page.keyboard.up("Alt");
    }
    assert.equal(await env.tab.evaluate(`ns.panel.targets()?.elements[0].label`), "a#docs", "the composer is still open on its pick");
    assert.deepEqual(await env.page.evaluate(`keys.filter((k) => k === "Escape")`), [], "the page didn't hear the esc");
    await untouched();
    await env.page.keyboard.press("Escape");
    await env.tab.until(noCard, { what: "esc to close the composer" });
  });

  test("picking text over an element's composer drops its outline, and the card keeps the text marked", async () => {
    await open(env);
    await pick(env, { selector: "#docs" });
    await env.tab.until(`root.querySelector(".outline") && !root.querySelector(".outline").hidden`, { what: "the element's outline" });
    // The composer takes the focus a frame after it opens, and that clears
    // the page's selection: select the text only once it has.
    await env.tab.until(composing, { what: "the element's composer to take the focus" });
    await pick(env, { text: "no framework", in: ".lede" });
    await env.tab.until(`root.querySelector(".outline").hidden`, { what: "the earlier element's outline to go" });
    await env.tab.until(`root.querySelectorAll(".marks .mark.kind-text").length`, { what: "the selected text marked" });
    await env.tab.until(composing, { what: "the text's composer to take the focus" });
    await env.page.keyboard.type("reword this");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    await env.tab.until(`root.querySelector(".panel .title")?.textContent`, { is: (t) => t === `Tweak ${n}`, what: `the card of tweak ${n}` });
    await env.page.evaluate(`getSelection().removeAllRanges()`);
    await env.tab.until(`root.querySelectorAll(".marks .mark.kind-text").length`, { what: "the card marking the text, found again" });
    await env.claude.tweakWith("done\n", "done", String(n), "-");
    await env.page.keyboard.press("Escape");
    await env.tab.until(noCard, { what: "esc to close the card" });
  });

  test("a card marks the occurrence that was selected, not the first one like it", async () => {
    await open(env);
    // The second "keep this short", by the text around it.
    const at = await env.page.evaluate(`(() => {
      const node = document.querySelector(".twice").firstChild;
      const i = node.data.lastIndexOf("keep this short");
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + "keep this short".length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      const box = r.getClientRects()[0];
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: box.left };
    })()`);
    await env.page.keyboard.down("Alt");
    await env.page.mouse.click(at.x, at.y);
    await env.page.keyboard.up("Alt");
    await env.tab.until(composing, { what: "the composer on the selected text" });
    await env.page.keyboard.type("shorter");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    const marked = `root.querySelector(".marks .mark.kind-text")?.getBoundingClientRect().left`;
    await env.tab.until(`root.querySelector(".panel .title")?.textContent`, { is: (t) => t === `Tweak ${n}`, what: `the card of tweak ${n}` });
    await env.tab.until(marked, { is: (x) => Math.abs(x - at.left) < 1, what: "the card marking the selected occurrence" });
    await env.page.keyboard.press("Escape");
    await env.page.evaluate(`getSelection().removeAllRanges()`);
    await env.tab.evaluate(`ns.panel.show(${n})`); // a fresh card: found again from the targets alone
    await env.tab.until(marked, { is: (x) => Math.abs(x - at.left) < 1, what: "a reopened card finding the selected occurrence again" });
    await env.claude.tweakWith("done\n", "done", String(n), "-");
    await env.page.keyboard.press("Escape");
    await env.tab.until(noCard, { what: "esc to close the card" });
  });

  test("an ⌥-drag over text picks an area and leaves the page's text unselected", async () => {
    await open(env);
    await env.page.evaluate(`window.heard.length = 0; getSelection().removeAllRanges()`);
    await pick(env, { area: { x: 30, y: 140, width: 320, height: 90 } });
    await env.tab.until(`root.querySelector(".marks .mark.kind-area")`, { what: "the composer to mark the area" });
    await untouched();
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

// Screenshots (design.md § Screenshot). A tweak sent from the page, and the
// PNG the bridge stored for it: its signature and its IHDR size. It returns
// the number, and the brief the stand-in fetched at once.
async function sendTweak(env, target, request) {
  await pick(env, target);
  await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
  await env.page.keyboard.type(request);
  const from = env.watcher.lines.length;
  await env.page.keyboard.press("Enter");
  const { number, brief } = await env.claude.nextTweak(env.watcher, { from });
  await env.tab.until(`ns.panel.showing()`, { is: (s) => s === number, what: `the card of tweak ${number}` });
  return { n: number, brief };
}

async function storedScreenshot(env, n) {
  const file = join(env.bridge.state, "screenshots", `${n}.png`);
  await until(() => existsSync(file), { what: `tweak ${n}'s screenshot to be stored` });
  const png = readFileSync(file);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG signature");
  assert.equal(png.subarray(12, 16).toString(), "IHDR");
  return { file, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// The box design.md crops to, in device pixels: the element plus 48 CSS px,
// clipped to the viewport (which the side panel, once open, narrows). Taken
// before the pick, as the page then is.
async function expectedCrop(env, selector) {
  const { r, vw, vh, dpr } = await env.page.$eval(selector, (el) => ({
    r: el.getBoundingClientRect().toJSON(),
    vw: innerWidth,
    vh: innerHeight,
    dpr: devicePixelRatio,
  }));
  const left = Math.max(0, r.left - 48);
  const top = Math.max(0, r.top - 48);
  const right = Math.min(vw, r.right + 48);
  const bottom = Math.min(vh, r.bottom + 48);
  return { width: Math.ceil(right * dpr) - Math.floor(left * dpr), height: Math.ceil(bottom * dpr) - Math.floor(top * dpr) };
}

// With Allow access granted (<all_urls> in the copy), at 2× device pixels.
describe("static, with access to every site", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture, { allUrls: true, deviceScaleFactor: 2 });
  const held = () => inWorker(env.browser, "e2eHeldCaptures()");

  test("a tweak's screenshot is the element plus a margin, in device pixels, and the brief names it", async () => {
    await open(env);
    assert.equal(await env.page.evaluate("devicePixelRatio"), 2);
    const crop = await expectedCrop(env, "#save");
    const { n, brief } = await sendTweak(env, { selector: "#save" }, "make the save button green");
    const shot = await storedScreenshot(env, n);
    assert.deepEqual({ width: shot.width, height: shot.height }, crop);
    assert.equal(await held(), 0, "the capture went with the tweak");
    assert.ok(await env.tab.evaluate(`!ns.overlay.host.style.visibility`), "the overlay is shown again");
    // Fetched the moment the tweak arrived: it waited for the upload.
    assert.ok(brief.includes(`Screenshot: ${shot.file}. View it`), "the brief names the screenshot");
    await env.page.keyboard.press("Escape");
  });

  test("a big area's screenshot is scaled down to 1600 px on its longest side", async () => {
    await open(env);
    const { n } = await sendTweak(env, { area: { x: 10, y: 10, width: 1080, height: 780 } }, "tidy up this whole area");
    const shot = await storedScreenshot(env, n);
    assert.equal(Math.max(shot.width, shot.height), 1600);
    assert.ok(shot.width > shot.height, `${shot.width}×${shot.height} keeps the viewport's shape`);
    await env.page.keyboard.press("Escape");
  });

  test("a capture is held while composing and thrown away on cancel", async (t) => {
    await open(env);
    const started = performance.now();
    await pick(env, { selector: "#name" });
    t.diagnostic(`the composer opened ${Math.round(performance.now() - started)} ms after the ⌥-click, capture included`);
    await until(held, { is: (n) => n === 1, what: "the capture held for the composer" });
    await env.page.keyboard.press("Escape");
    await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the composer" });
    await until(held, { is: (n) => n === 0, what: "the capture thrown away" });
  });

  test("esc while the pick is still being captured cancels it: no composer opens", async () => {
    await open(env);
    // A slow capture, as one queued behind another is.
    await env.tab.evaluate(`(() => {
      const take = ns.screenshot.take;
      ns.screenshot.take = async function () { const id = await take.call(this); await new Promise((r) => setTimeout(r, 600)); return id; };
      globalThis.e2eRestore = () => (ns.screenshot.take = take);
      return true;
    })()`);
    try {
      const box = await (await env.page.waitForSelector("#name")).boundingBox();
      await env.page.keyboard.down("Alt");
      await env.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await env.page.keyboard.up("Alt");
      await env.page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(await env.tab.evaluate(`ns.panel.targets()`), null, "no composer opened after esc");
      await until(held, { is: (n) => n === 0, what: "the cancelled pick's capture thrown away" });
    } finally {
      await env.tab.evaluate("e2eRestore()");
    }
  });
});

// The activeTab path: static again on 127.0.0.1, which the copy has no grant
// for. The toolbar button (page.triggerExtensionAction) grants activeTab, so
// after a reload the claim's scripts run there and the capture works.
describe("static on 127.0.0.1, through activeTab", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  test("after the toolbar button, a tweak on an ungranted host gets its screenshot", async () => {
    const app = await env.serve("127.0.0.1");
    await env.claude.claim(`${app.url("")}/*`);
    await until(() => inWorker(env.browser, `chrome.scripting.getRegisteredContentScripts().then((r) => r.length >= 4)`), {
      what: "the 127.0.0.1 claim's scripts to be registered",
    });
    await env.page.goto(app.url("/"));
    // The tab's real width, behind the emulated viewport.
    const width = () => inWorker(env.browser, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t.width)`);
    const before = await width();
    const [extension] = (await env.browser.extensions()).values();
    await env.page.triggerExtensionAction(extension);
    // The button also opens the side panel, which narrows the real view, and
    // with it the capture, but not the emulated viewport the page measures.
    // Closed again, the capture is of the whole viewport, as on the granted copy.
    await until(width, { is: (w) => w < before, what: "the side panel to open" });
    await inWorker(env.browser, `chrome.windows.getLastFocused().then((w) => chrome.sidePanel.close({ windowId: w.id }))`);
    await until(width, { is: (w) => w === before, what: "the tab's real view to be whole again" });
    await env.page.reload();
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the content script on 127.0.0.1" });
    const crop = await expectedCrop(env, "#save");
    const { n } = await sendTweak(env, { selector: "#save" }, "make the save button green");
    const shot = await storedScreenshot(env, n);
    assert.deepEqual({ width: shot.width, height: shot.height }, crop);
  });
});
