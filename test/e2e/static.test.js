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
    // The card takes the focus a frame later. Pressed before that, Undo
    // loses it to the card, and the Enter does nothing.
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(CARD)})`, { what: "the card to take the focus" });
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

  // The mappers run while you type: a source map that comes later than
  // 300 ms after the pick, but before Send, still places the rule.
  test("a source map served late, while the request is typed, still gives the rule's line", async () => {
    const late = (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (req.url().endsWith("/theme.css.map")) setTimeout(() => req.continue().catch(() => {}), 600);
      else req.continue().catch(() => {});
    };
    await env.page.setRequestInterception(true);
    env.page.on("request", late);
    try {
      await open(env);
      const served = env.page.waitForResponse((r) => r.url().endsWith("/theme.css.map"));
      await pick(env, { selector: ".plan-title" });
      await env.tab.until(composing, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("tweak the plan title");
      await served; // as a person types, past the 300 ms
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n, brief } = await env.claude.nextTweak(env.watcher, { from });
      try {
        assert.deepEqual(briefProblems(brief, { locations: [{ file: "src/theme.css", line: 10, role: "style", via: "css" }] }), []);
      } finally {
        await strandNothing(env, n); // done, and the card closed
      }
    } finally {
      env.page.off("request", late);
      await env.page.setRequestInterception(false);
    }
  });

  // Reloading after a change (design.md § Reloading after a change): the
  // side panel's per-site switch, and a reload held back by a form's unsaved
  // input. The reasons themselves are unit tests (test/extension/reload.test.js).
  test("the side panel's switch turns auto-reload on for the site; unsaved input holds the reload back, and Reload reloads", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    const target = await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "the side panel" });
    const panel = await target.asPage();
    const site = new URL(env.app.url("/")).origin;
    await until(() => panel.evaluate(`!document.getElementById("reload-setting").hidden && document.getElementById("reload-setting").dataset.origin`), {
      is: (s) => s === site,
      what: "the reload setting for the site in front",
    });
    assert.equal(await panel.evaluate(`document.getElementById("auto-reload").checked`), false, "off, as the harness leaves it");
    const origin = JSON.stringify(new URL(env.app.url("/")).origin);
    const setting = () => panel.evaluate(`chrome.storage.local.get("autoReload").then(({ autoReload: a = {} }) => a[${origin}] ?? "on")`);
    // The switch's own click, as a press of it gives: on Linux CI the side
    // panel's page can have no box for Puppeteer's pointer to land in.
    const flip = () => panel.evaluate(`document.getElementById("auto-reload").click()`);
    await flip();
    await until(async () => (await setting()) === "on", { what: "the switch to turn auto-reload on" });
    try {
      await env.page.bringToFront();
      await pick(env, { selector: "#docs" });
      await env.tab.until(composing, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("held back");
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.claude.tweak("work", String(n));
      await env.page.type("#name", "typed, not saved");
      await env.page.evaluate(() => (window.e2eNotReloaded = true));
      await env.claude.tweakWith("done\n", "done", String(n), "-");
      await env.tab.until(`root.querySelector(".panel .reload-why")?.textContent`, {
        is: (s) => s === "Not reloaded: a form on the page has unsaved input.",
        what: "the card to say why the page hasn't reloaded",
      });
      assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_STATUS)}).textContent`), "Change saved");
      assert.equal(await env.tab.evaluate(`root.querySelector(".panel .reload-now").hidden`), false, "Change saved · Reload");
      await new Promise((done) => setTimeout(done, 700)); // past a recheck: still held
      assert.equal(await env.page.evaluate(() => window.e2eNotReloaded), true, "held back while the input is unsaved");
      await env.tab.evaluate(`root.querySelector(".panel .reload-now").click()`);
      await until(() => env.page.evaluate(() => window.e2eNotReloaded === undefined && document.readyState === "complete"), { what: "Reload to reload the page" });
      await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the content script back after the reload" });
      await env.page.keyboard.press("Escape");
    } finally {
      await flip();
      await until(async () => (await setting()) === false, { what: "the switch to turn auto-reload off again" });
      await panel.close();
    }
  });

  test("a field the page's own script fills doesn't hold the reload back", async () => {
    await open(env);
    await autoReload(env, true);
    try {
      await pick(env, { selector: "#docs" });
      await env.tab.until(composing, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("not held back");
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.claude.tweak("work", String(n));
      // As a time picker checks its first slot: set by script, not by you.
      await env.page.evaluate(() => (document.querySelector("#name").value = "set by the page"));
      await mark(env);
      await env.claude.tweakWith("done\n", "done", String(n), "-");
      await until(() => env.page.evaluate(() => window.e2eNotReloaded === undefined && document.readyState === "complete"), { what: "Done to reload the page" });
      await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the content script back after the reload" });
      await env.page.keyboard.press("Escape");
    } finally {
      await autoReload(env, false);
    }
  });

  // The update signals a page with no Vite can give, recorded from working:
  // a stylesheet swapped, and a full reload with the card open. Either
  // means the page already shows the change, so Done reloads nothing.
  async function working(selector, words) {
    await open(env);
    await env.page.bringToFront(); // the side panel may have had it
    await pick(env, { selector });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type(words);
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    await env.claude.tweak("work", String(n));
    await env.tab.until(`root.querySelector(${JSON.stringify(CARD_STATUS)})?.textContent`, {
      is: (s) => s?.startsWith("Claude is working on it"),
      what: "the card to show Claude working",
    });
    return n;
  }
  async function noReloadAfterDone(n, signal) {
    await env.claude.tweakWith("done\n", "done", String(n), "-");
    const last = await env.tab.until(`ns.reload.last?.number === ${n} && ns.reload.last`, { what: "the reload decision" });
    assert.equal(last.signal, signal);
    assert.equal(await marked(env), true, "no reload after Done");
    await env.page.keyboard.press("Escape");
  }

  test("a stylesheet swapped while Claude works means the page has updated: Done reloads nothing", async () => {
    await autoReload(env, true);
    try {
      const n = await working("#docs", "restyle this");
      await mark(env);
      // As Vite swaps a <link>: a copy with a new href, then the old one goes.
      await env.page.evaluate(() => {
        const old = document.querySelector('link[href="/styles.css"]');
        const swapped = old.cloneNode();
        swapped.href = "/styles.css?t=1";
        old.after(swapped);
        old.remove();
      });
      await noReloadAfterDone(n, "style");
    } finally {
      await autoReload(env, false);
    }
  });

  test("a full reload while Claude works, with the card open, means the page has updated: Done reloads nothing", async () => {
    await autoReload(env, true);
    try {
      const n = await working("#docs", "reload this");
      await env.page.reload();
      await open(env, "/", { goto: false });
      await env.tab.until(`root.querySelector(".panel .title")?.textContent`, { is: (t) => t === `Tweak ${n}`, what: "the card back after the reload" });
      await mark(env);
      await noReloadAfterDone(n, "reload");
    } finally {
      await autoReload(env, false);
    }
  });

  // The harness itself, once, here.
  test("the test copy's message calls a worker handler: the side panel opens", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "a side panel target" });
  });

  // The copy has http://localhost/* but not <all_urls>, as before Allow access.
  test("without site access, tweak claim says to click Allow access", async () => {
    await open(env);
    const out = await env.claude.claim(`${env.app.url("")}/*`);
    assert.match(out, /^site access not granted: open the Codaset Tweak side panel and click Allow access, or ⌥-click won't work$/m);
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

      // Pointing at a row highlights it and its element on the page.
      const row = await env.tab.evaluate(`(() => { const r = root.querySelectorAll(".picked li")[1].getBoundingClientRect(); return { x: r.x + r.width / 3, y: r.y + r.height / 2 }; })()`);
      await env.page.mouse.move(row.x, row.y);
      await env.tab.until(`[...root.querySelectorAll(".marks .mark.hot")].map((m) => m.textContent).join()`, { is: (s) => s === "2", what: "element 2 highlighted on the page" });
      assert.deepEqual(await env.tab.evaluate(`[...root.querySelectorAll(".picked li")].map((li) => li.classList.contains("hot"))`), [false, true, false], "and its row");
      await env.page.mouse.move(5, 5);
      await env.tab.until(`root.querySelectorAll(".marks .mark.hot, .picked li.hot").length`, { is: (n) => n === 0, what: "the highlight gone with the pointer" });
      assert.equal(await env.tab.evaluate(composing), true, "the composer still has the focus");
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
      // A number on the pin would read as a count: it's the pin's name, not its text.
      const pinEl = `[...root.querySelectorAll(".pin")].find((p) => p.dataset.number === "${n}")`;
      await env.tab.until(`${pinEl}?.getAttribute("aria-label")`, { is: (l) => l?.startsWith(`Tweak ${n}: `), what: `tweak ${n}'s pin, named` });
      assert.equal(await env.tab.evaluate(`${pinEl}.textContent`), "", "no number on the pin");
      assert.equal(await env.tab.evaluate(`root.querySelector(".panel .chip").hidden`), true, "the card has no chip: the composer's was enough");
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

  test("with site access, tweak claim has no access warning", async () => {
    await open(env);
    assert.doesNotMatch(await env.claude.claim(`${env.app.url("")}/*`), /site access/);
  });

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

// When the session goes quiet (design.md): a bridge whose claims lapse after
// 2 s without a check-in instead of 10 minutes, and whose commands warn after
// 1 s without a watcher instead of a minute. The tests run in order: the
// stand-in's claim lapses and comes back, then is lost to a second session.
describe("static, when the session goes quiet", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture, { lapseAfter: "2s", unwatchedAfter: "1s" });
  const pattern = () => `${env.app.url("")}/*`;
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statusOf = (n) => `ns.page.tweak(${n})?.status`;
  const text = (selector) => `root.querySelector(${JSON.stringify(selector)})?.textContent`;
  const send = async (selector, request) => {
    await open(env);
    await pick(env, { selector });
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer" });
    await env.page.keyboard.type(request);
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const [, n] = await env.watcher.line(/^tweak (\d+) new: .*/, { from });
    await env.page.keyboard.press("Escape");
    return Number(n);
  };

  // The card and the side panel, built from the snapshot as well as events,
  // so a reload says the same.
  test("the card says the session isn't listening, then stopped responding, and the side panel offers the page to another session", async () => {
    const card = `root.querySelector(${JSON.stringify(CARD_STATUS)})?.textContent`;
    const deaf = /^Waiting for the session in .+, which isn't listening right now$/;
    const lapsed = "The session stopped responding · Waiting for a session";
    const n = await send("#save", "make the save button green");
    await env.tab.until(statusOf(n), { is: (s) => s === "delivered", what: "the tweak delivered" });
    await env.tab.evaluate(`ns.panel.show(${n})`);
    env.watcher.stop();
    // Each command checks in, so the claim can't lapse while this waits.
    const listening = async (re) => {
      await until(async () => (await env.claude.tweakBoth("claims"), re.test((await env.tab.evaluate(card)) ?? "")), { what: `the card to say ${re}` });
    };
    await listening(deaf);
    // The session's folder, as code (the bridge sees it resolved: /private/var for /var).
    assert.ok((await env.tab.evaluate(`root.querySelector(".panel .status code")?.textContent`))?.endsWith(basename(env.app.folder)), "the folder as code");
    await env.page.reload();
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the page back after the reload" });
    await listening(deaf);

    // No more check-ins: the claim lapses. The page is unclaimed, but keeps the card.
    await env.tab.until(card, { is: (s) => s === lapsed, what: "the card to say the session stopped responding" });
    assert.equal(await env.tab.evaluate(`ns.pins.any()`), true, "the pin stays");
    // The lapsed claim's own registration, so a reload gets the scripts.
    const lapsedScripts = `chrome.scripting.getRegisteredContentScripts().then((r) => r.some((s) => s.id.startsWith("claim-lapsed-")))`;
    await until(() => inWorker(env.browser, lapsedScripts), { what: "the lapsed claim's registration" });
    await env.page.reload();
    await env.tab.until(card, { is: (s) => s === lapsed, what: "the card to say so after a reload" });

    await env.tab.handler("side-panel");
    const target = await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "the side panel" });
    const panel = await target.asPage();
    const said = () => panel.evaluate(`document.getElementById("lapsed").hidden ? "" : document.querySelector("#lapsed p").textContent.replace(/\\s+/g, " ").trim()`);
    const status = await until(said, { what: "the side panel's claim status" });
    assert.match(status, /^The session in .+ stopped responding (just now|1 min ago)\. It gets this page back if it returns, or claim it from another session with:$/);
    assert.equal(await panel.evaluate(`document.getElementById("lapsed-command").textContent`), `/tweak ${pattern()}`);
    assert.match(await panel.evaluate(`document.getElementById("page-said").textContent`), /^The session in .+ stopped responding$/);

    // The session comes back: the claim, and the tweak, are as they were.
    env.watcher = env.claude.watch();
    await env.watcher.line(new RegExp(`^claim restored: ${escaped(pattern())}$`));
    await env.tab.until(card, { is: (s) => s === "Claude has it", what: "the card to wait on Claude again" });
    await until(async () => (await said()) === "", { what: "the side panel's claim status to go" });
    await env.claude.work(n);
    await env.claude.done(n, "made it green");
  });

  test("a lapsed claim comes back at the next check-in, with its tweak as it was", async () => {
    const n = await send("#save", "make the save button green");
    await env.tab.until(statusOf(n), { is: (s) => s === "delivered", what: "the tweak delivered" });
    env.watcher.stop();
    await env.tab.until(statusOf(n), { is: (s) => s === "sent", what: "the lapse to send the tweak back to waiting" });
    env.watcher = env.claude.watch();
    await env.watcher.line(new RegExp(`^claim restored: ${escaped(pattern())}$`));
    await env.tab.until(statusOf(n), { is: (s) => s === "delivered", what: "the tweak back as delivered" });
    assert.equal(env.watcher.lines.filter((l) => l.startsWith(`tweak ${n} `)).length, 0, "no line for the tweak again");
    await env.claude.work(n);
    await env.claude.done(n, "made it green");
  });

  test("a working tweak lapses to the next session to claim the page, with a notice; the first session's claim is lost", async () => {
    const n = await send("#docs", "reword the docs link");
    await env.claude.work(n);
    await env.claude.edit({ file: "public/index.html", find: ">Docs<", replace: ">Read the docs<" });
    await env.tab.evaluate(`ns.panel.show(${n})`);
    await env.tab.until(text(CARD_STATUS), { is: (s) => s?.startsWith("Claude is working on it · "), what: "the card to count the time worked" });
    env.watcher.stop();
    await env.tab.until(statusOf(n), { is: (s) => s === "sent", what: "the lapse to send the tweak back to waiting" });
    // While lapsed: the files it already changed, and no Undo.
    await env.tab.until(`ns.describe.change(ns.page.tweak(${n}))?.kind`, { is: (k) => k === "partial", what: "the files already changed" });
    assert.deepEqual(await env.tab.evaluate(`ns.describe.change(ns.page.tweak(${n})).files.map((f) => f.path)`), ["public/index.html"]);
    assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_UNDO)}).hidden`), true, "no Undo");

    const second = standIn(env.bridge, { folder: env.app.folder, session: `claude-second-${process.pid}` });
    try {
      await second.claim(pattern());
      const { number, brief } = await second.nextTweak(second.watch());
      assert.equal(number, n);
      assert.match(brief, /The session in .+ stopped responding\. Files already changed: public\/index\.html\./);
      // The notice shows on the card too.
      await env.tab.until(text(".panel .entry.kind-notice .entry-text"), { is: (s) => /stopped responding\. Files already changed: public\/index\.html\.$/.test(s ?? ""), what: "the notice on the card" });
      assert.equal(await env.tab.evaluate(text(".panel .entry.kind-notice .entry-label")), "Tweak");
      await second.done(n, "reworded the docs link");
      await env.tab.until(statusOf(n), { is: (s) => s === "done", what: "the second session to finish it" });

      const lost = new RegExp(`^claim lost: ${escaped(pattern())} is now claimed by the session in .+\\n$`);
      assert.match((await env.claude.tweakBoth("claims")).stderr, lost);
      await assert.rejects(env.claude.done(n, "me too"), /claim lost: /);
    } finally {
      second.stop();
    }
  });

  test("the SessionEnd hook releases the session's claims, and its watcher stops", async () => {
    const third = standIn(env.bridge, { folder: env.app.folder, session: `claude-third-${process.pid}` });
    try {
      await third.claim("http://elsewhere.localhost/*");
      const watcher = third.watch();
      // Once a second has passed since the claim, no warning means its watcher is listening.
      await sleep(1100);
      await until(async () => (await third.tweakBoth("claims")).stderr === "", { what: "the third session's watcher to listen" });
      await third.end("clear");
      await watcher.line(/^claim released: http:\/\/elsewhere\.localhost\/\*$/);
      assert.equal(await watcher.exited, 0);
    } finally {
      third.stop();
    }
  });
});

// The browser while the bridge is down (design.md § When the bridge or
// extension is down): the development bridge is stopped mid-test and
// started again on the same database.
describe("static, while the bridge is down", { skip: skipReason(fixture) ?? false }, () => {
  // <all_urls>, so the badge is clear while connected: the grey ! then means down.
  const env = setup(fixture, { allUrls: true });

  const RECONNECT = 25_000; // the worker's retries reach every 10 s
  const composing = `Boolean(root.activeElement) && root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`;
  const value = (selector) => `root.querySelector(${JSON.stringify(selector)})?.value`;
  const badge = () => inWorker(env.browser, `chrome.action.getBadgeText({})`);
  const faded = `Boolean(root.querySelector(".pins.offline")) && Boolean(root.querySelector(".panel.offline"))`;

  // down stops the bridge; the watcher goes first, as any tweak command
  // would start the bridge again.
  async function down() {
    env.watcher.stop();
    await env.bridge.shutdown();
    await env.tab.until(`ns.worker.connection`, { is: (c) => c === "disconnected", what: "the tab to hear the bridge is down" });
  }
  // up starts it again, as the next tweak command would, with a new watcher.
  async function up() {
    await env.claude.claim(`${env.app.url("")}/*`);
    env.watcher = env.claude.watch();
    await env.tab.until(`ns.worker.connection`, { is: (c) => c === "connected", timeout: RECONNECT, what: "the worker to reconnect" });
  }
  // reload reloads the page while the bridge is down: open() would wait for a connection.
  async function reload() {
    await env.page.reload();
    await env.tab.until(`Boolean(root) && ns.worker.connection === "disconnected"`, { what: "the content script, not connected" });
  }
  async function send(selector, request) {
    await pick(env, { selector });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type(request);
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number } = await env.claude.nextTweak(env.watcher, { from });
    await env.tab.until(`root.querySelector(${JSON.stringify(CARD_TITLE)})?.textContent`, { is: (t) => t === `Tweak ${number}`, what: `the card of tweak ${number}` });
    return number;
  }
  const sidePanel = () => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html"));

  test("a finished tweak's Undo is refused while down, and works once connected", async () => {
    const c = fixture.cases.find((x) => x.edit);
    const n = await tracer(env, c, { undo: false });
    await env.tab.evaluate(`ns.panel.show(${n}, { focus: true })`);
    await env.tab.until(`root.querySelector(${JSON.stringify(CARD_UNDO)})?.hidden === false`, { what: "the card's Undo" });

    await down();
    await env.tab.until(`root.querySelector(${JSON.stringify(CARD_UNDO)}).disabled`, { what: "Undo to be refused" });
    assert.equal(await env.tab.evaluate(`root.querySelector(".panel .undo .error").textContent`), "Not connected to Tweak");

    await up();
    await undoFromCard(env); // puts the fixture copy back, too
  });

  test("Withdraw is refused while down, and withdraws the tweak once connected", async () => {
    await open(env);
    await env.page.keyboard.press("Escape"); // an earlier test's card, which may cover the title
    await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "no card open" });
    const n = await send(".plan-title", "make the plan title bolder");
    const action = `root.querySelector(${JSON.stringify(CARD_ACTION)})`;
    await env.tab.until(`${action}?.getAttribute("aria-label")`, { is: (s) => s === "Stop and withdraw", what: "the card's Withdraw" });

    await down();
    await env.tab.until(`${action}.disabled`, { what: "Withdraw to be refused" });
    assert.equal(await env.tab.evaluate(`root.querySelector(".panel .actions .error").textContent`), "Not connected to Tweak");
    await env.tab.evaluate(`${action}.click()`); // refused, not held
    assert.equal(await env.tab.evaluate(`ns.page.tweak(${n})?.status`), "working", "nothing was withdrawn");

    await up();
    const from = env.watcher.lines.length;
    await finishFromCard(env, n, "Stop and withdraw");
    await env.watcher.line(new RegExp(`^tweak ${n} withdrawn$`), { from });
  });

  test("pins and the card stay, faded and read-only; ⌥-click opens the side panel; a half-written reply survives a reload and is sent once connected", async () => {
    await open(env);
    const n = await send("#name", "make the name field wider");
    await env.claude.tweak("ask", String(n), "How much wider?");
    await env.tab.until(`root.querySelector(".panel .answer")?.hidden === false`, { what: "the reply box" });
    await env.tab.evaluate(`root.querySelector(${JSON.stringify(REPLY_INPUT)}).focus()`);
    await env.page.keyboard.type("twice as");
    assert.equal(await badge(), "", "no badge while connected");

    await down();
    await env.tab.until(faded, { what: "the pins and card to fade" });
    assert.equal(await badge(), "!", "the grey ! while the bridge is down");
    assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(REPLY_SEND)}).disabled`), true, "Reply is refused");
    assert.equal(await env.tab.evaluate(`root.querySelector(".panel .answer .error").textContent`), "Not connected to Tweak");
    await env.page.keyboard.press("Enter"); // refused, not held: nothing is sent, the text stays
    assert.equal(await env.tab.evaluate(value(REPLY_INPUT)), "twice as");

    // A reload while down: the cached pin and card are back, with the reply.
    await reload();
    await env.tab.until(`ns.panel.showing()`, { is: (s) => s === n, what: "the card to reopen from the cache" });
    await env.tab.until(faded, { what: "the reopened card and pin, faded" });
    await env.tab.until(value(REPLY_INPUT), { is: (v) => v === "twice as", what: "the half-written reply, restored" });
    assert.equal(await env.tab.evaluate(`ns.page.tweak(${n})?.status`), "question");

    // ⌥-click picks nothing: it opens the side panel, which says how to start Tweak.
    assert.equal(sidePanel(), undefined, "no side panel yet");
    const docs = await (await env.page.waitForSelector("#docs")).boundingBox();
    await env.page.keyboard.down("Alt");
    await env.page.mouse.click(docs.x + docs.width / 2, docs.y + docs.height / 2);
    await env.page.keyboard.up("Alt");
    const target = await until(sidePanel, { what: "the side panel to open" });
    const panel = await target.asPage();
    const command = `/tweak ${env.app.url("")}`;
    await panel.waitForFunction((c) => document.getElementById("command")?.textContent === c && !document.getElementById("not-connected").hidden, {}, command);
    assert.match(await panel.evaluate(() => document.getElementById("not-connected").textContent), /Not connected to Tweak[\s\S]*Start it from Claude Code with/);
    assert.equal(await env.tab.evaluate(`ns.panel.showing()`), n, "the ⌥-click opened no composer");
    await inWorker(env.browser, `chrome.windows.getLastFocused().then((w) => chrome.sidePanel.close({ windowId: w.id }))`);

    // Back up: the snapshot replaces the cache, and the reply goes.
    await up();
    await env.tab.until(`!root.querySelector(".pins.offline") && !root.querySelector(".panel.offline")`, { what: "the fade to lift" });
    await until(badge, { is: (b) => b === "", what: "the badge to clear" });
    await env.tab.evaluate(`root.querySelector(${JSON.stringify(REPLY_INPUT)}).focus()`);
    await env.page.keyboard.type(" wide");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    await env.watcher.line(new RegExp(`^tweak ${n} reply: twice as wide$`), { from });
    await env.tab.until(`root.querySelector(${JSON.stringify(CARD_STATUS)})?.textContent`, { is: (s) => s === "Reply sent" || s === "Claude has your reply", what: "the reply sent" });
    await env.page.keyboard.press("Escape");
  });

  test("a composer's draft survives a reload while down and is sent once connected; esc clears a draft", async () => {
    await open(env);
    await pick(env, { selector: "#open-profile" });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type("make the profile button green");

    await down();
    await reload();
    await env.tab.until(`ns.panel.targets()?.elements[0]?.selector`, { is: (s) => s === "#open-profile", what: "the composer to reopen on #open-profile" });
    await env.tab.until(value(COMPOSER_INPUT), { is: (v) => v === "make the profile button green", what: "its text, restored" });
    assert.equal(await env.tab.evaluate(`root.querySelector(".panel .send").disabled`), true, "Send is refused");
    assert.equal(await env.tab.evaluate(`root.querySelector(".panel .error").textContent`), "Not connected to Tweak");

    await up();
    await env.tab.until(`root.querySelector(".panel .send")?.disabled === false`, { what: "Send to come back" });
    await env.tab.evaluate(`root.querySelector(${JSON.stringify(COMPOSER_INPUT)}).focus()`);
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number } = await env.claude.nextTweak(env.watcher, { from });
    await env.tab.until(`ns.panel.showing()`, { is: (s) => s === number, what: "the card of the tweak sent" });

    // Sent, the draft is gone: a reload reopens the card, not the composer.
    await env.page.reload();
    await env.tab.until(`ns.panel.showing()`, { is: (s) => s === number, what: "the card after a reload" });
    assert.equal(await env.tab.evaluate(`ns.panel.targets()`), null);

    // esc clears a draft: a reload opens nothing.
    await env.page.keyboard.press("Escape");
    await pick(env, { selector: "#docs" });
    await env.tab.until(composing, { what: "a new composer" });
    await env.page.keyboard.type("bold");
    await env.page.keyboard.press("Escape");
    await env.tab.until(`ns.panel.targets() === null`, { what: "esc to close the composer" });
    await open(env);
    await env.tab.until(`Boolean(ns.page.tweak(${number}))`, { what: "the page's tweaks" });
    assert.equal(await env.tab.evaluate(`ns.panel.targets()`), null, "no composer after esc and a reload");
  });

  test("a question asked while the extension's socket was down opens its card in its own tab on reconnect", async () => {
    await open(env);
    const n = await send("#docs", "make the docs link bolder");
    await env.page.keyboard.press("Escape");
    await env.tab.until(`ns.panel.showing() === null`, { what: "esc to close the card" });

    // The socket goes (a port nothing answers on); the bridge stays up and Claude asks.
    const dead = await freePort();
    await inWorker(env.browser, `chrome.storage.local.set({ port: ${dead} })`);
    await env.tab.until(`ns.worker.connection`, { is: (c) => c === "disconnected", what: "the socket to go" });
    await env.claude.tweak("ask", String(n), "How bold?");
    await inWorker(env.browser, `chrome.storage.local.remove("port")`);
    await env.tab.until(`ns.worker.connection`, { is: (c) => c === "connected", timeout: RECONNECT, what: "the socket back" });
    await env.tab.until(`ns.panel.showing()`, { is: (s) => s === n, what: "the question in the snapshot to open its card" });
    assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_STATUS)}).textContent`), "Claude has a question");
  });


  test("a composer's draft on a selection longer than the brief's cap opens again from the draft", async () => {
    await open(env);
    await env.page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "long";
      p.textContent = "lorem ipsum ".repeat(200).trim();
      document.body.append(p);
    });
    const text = await env.page.evaluate(() => document.getElementById("long").textContent);
    await pick(env, { text, in: "#long" });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type("shorten this");
    const draft = await env.tab.evaluate(`ns.drafts.compose()`);
    await env.page.keyboard.press("Escape");
    await env.tab.until(`ns.panel.targets() === null`, { what: "esc to close the composer" });
    // As after a reload: the same page, the same text.
    await env.tab.evaluate(`ns.panel.restore(${JSON.stringify(draft)})`);
    assert.equal(await env.tab.evaluate(value(COMPOSER_INPUT)), "shorten this");
    assert.equal(await env.tab.evaluate(`ns.panel.targets()?.selection?.text.length`), 2000, "the selection sent is still the capped one");
    await env.page.keyboard.press("Escape");
  });

  test("while down, pick mode (the toolbar button, ⌥⇧C) opens the side panel instead, and ⌥⇧H still hides the pins", async () => {
    await open(env);
    await down();
    try {
      await env.tab.handler("pick-mode");
      const target = await until(sidePanel, { what: "the side panel to open" });
      const panel = await target.asPage();
      await panel.waitForFunction(() => !document.getElementById("not-connected").hidden);
      assert.equal(await env.tab.evaluate(`ns.picker.mode`), false, "no pick mode while down");
      await inWorker(env.browser, `chrome.windows.getLastFocused().then((w) => chrome.sidePanel.close({ windowId: w.id }))`);
      const hidden = () => inWorker(env.browser, `chrome.storage.local.get("pinsHidden").then((s) => s.pinsHidden ?? {})`);
      await env.tab.handler("pins");
      await until(hidden, { is: (h) => h[env.app.url("")] === true, what: "⌥⇧H to hide the pins while down" });
      await env.tab.until(`root.querySelector(".pins")?.classList.contains("hidden") ?? true`, { what: "the pins layer hidden" });
      await env.tab.handler("pins");
      await until(hidden, { is: (h) => !h[env.app.url("")], what: "⌥⇧H to show them again" });
    } finally {
      await up();
    }
  });

  test("a page going into the back/forward cache puts nothing on chrome://extensions' Errors page", async () => {
    const extensions = await env.browser.newPage();
    try {
      await extensions.goto("chrome://extensions");
      await extensions.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
      const id = await inWorker(env.browser, `chrome.runtime.id`);
      await open(env);
      await env.page.bringToFront();
      // Away and back: the page and its port go into the cache, and come out.
      await env.page.evaluate(() => addEventListener("pageshow", (e) => (window.e2eFromCache = e.persisted)));
      await env.page.goto(env.app.url("/?away"));
      await env.page.goBack();
      await until(() => env.page.evaluate(() => window.e2eFromCache), { is: (v) => v === true, what: "the page back from the back/forward cache" });
      await sleep(1000); // for the worker to hear the port go and come back
      const { runtimeErrors } = await extensions.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), id);
      assert.deepEqual(runtimeErrors.map((e) => e.message).filter((m) => /back\/forward cache|Unchecked runtime\.lastError/.test(m)), []);
    } finally {
      await extensions.close();
    }
  });

  test("tries at a bridge that's down put nothing on chrome://extensions' Errors page", async () => {
    // The Errors page records only in developer mode, which loading an
    // unpacked extension needs anyway.
    const extensions = await env.browser.newPage();
    try {
      await extensions.goto("chrome://extensions");
      await extensions.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
      const id = await inWorker(env.browser, `chrome.runtime.id`);
      await open(env);
      await down();
      await sleep(4000); // the worker's first two tries (backoff.js: 1 s, then 2 s)
      await up();
      const { runtimeErrors } = await extensions.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), id);
      assert.deepEqual(runtimeErrors.map((e) => e.message).filter((m) => /WebSocket|ERR_CONNECTION_REFUSED/.test(m)), []);
    } finally {
      await extensions.close();
    }
  });
});

const text = (selector) => `root.querySelector(${JSON.stringify(selector)})?.textContent`;

// Withdraw, Resolve and the side panel's resolved tweaks (design.md § When
// the session goes quiet, § Side panel). Their tweaks leave the page, so each
// describe has its own bridge.
describe("static, withdrawn and resolved tweaks", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
  const c = fixture.cases.find((x) => x.edit);
  const row = (panel, n) => panel.evaluate((sel) => {
    const li = document.querySelector(sel);
    if (!li || li.closest("[hidden]")) return null;
    const pick = (s) => li.querySelector(s)?.textContent ?? null;
    return { status: pick(".tweak-status"), request: pick(".tweak-request"), change: pick(".tweak-change"), undo: pick(".tweak-undo button"), note: pick(".tweak-undo > p") };
  }, RESOLVED_ROW(n));

  test("Withdraw while Claude works: the session hears it, the pin goes, and Claude's decline keeps the change for the side panel's Undo", async () => {
    const path = join(env.app.folder, c.edit.file);
    const original = readFileSync(path);
    try {
      await open(env, c.path ?? "/");
      await pick(env, c.pick);
      await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("label it Save draft");
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.tab.until(`root.querySelector(${JSON.stringify(CARD_STATUS)})?.textContent`, { is: (s) => s?.startsWith("Claude is working on it"), what: "Claude working" });
      await env.claude.edit(c.edit);

      const heard = env.watcher.lines.length;
      await finishFromCard(env, n, "Stop and withdraw");
      await env.tab.until(text(".toasts"), { is: (s) => s?.includes(`Tweak ${n} withdrawn`), what: "a toast saying where it went" });
      await env.watcher.line(new RegExp(`^tweak ${n} withdrawn$`), { from: heard });
      assert.equal(await env.claude.tweak("decline", String(n), "withdrawn"), `tweak ${n}: withdrawn, change kept for Undo\n`);
      assert.equal(await env.claude.work(n), `tweak ${n}: withdrawn, skip it\n`);

      const panel = await sidePanel(env);
      const listed = await until(() => row(panel, n), { is: (r) => r?.undo === "Undo", what: `tweak ${n} in the side panel with Undo` });
      assert.equal(listed.status, "Withdrawn");
      assert.equal(listed.request, "label it Save draft");
      assert.equal(listed.change, "1 file changed");
      await panel.focus(`${RESOLVED_ROW(n)} .tweak-undo button`);
      await panel.keyboard.press("Enter");
      await until(() => row(panel, n), { is: (r) => r?.note === "Undone", what: "the side panel to say Undone" });
      assert.ok(readFileSync(path).equals(original), `${c.edit.file} is back as it was`);
    } finally {
      writeFileSync(path, original);
    }
  });

  test("Resolve on a finished tweak takes its pin off the page, and lists it in the side panel", async () => {
    const n = await tracer(env, c, { edit: null, summary: "nothing to change" });
    await env.tab.evaluate(`ns.panel.show(${n}, { focus: true })`);
    await finishFromCard(env, n, "Resolve");
    await env.tab.until(text(".toasts"), { is: (s) => s?.includes(`Tweak ${n} resolved`), what: "a toast saying where it went" });
    const panel = await sidePanel(env);
    const listed = await until(() => row(panel, n), { what: `tweak ${n} in the side panel` });
    assert.equal(listed.status, "Change saved");
    // A reload brings back no pin for it.
    await open(env, c.path ?? "/");
    assert.equal(await env.tab.evaluate(`[...root.querySelectorAll(".pin")].some((p) => p.dataset.number === "${n}")`), false);

    // On a tab whose address it can't read (127.0.0.1: this copy has no
    // access there), the list is about no site, so it lists none, and says why.
    const app = await env.serve("127.0.0.1");
    await env.page.goto(app.url("/"));
    const shown = await until(
      () => panel.evaluate(() => {
        const note = document.getElementById("resolved-access");
        return note.hidden || note.closest("[hidden]") ? null : { note: note.textContent, rows: document.querySelectorAll("#resolved-list li").length };
      }),
      { what: "the side panel to say why it lists no resolved tweaks" },
    );
    assert.deepEqual(shown, { note: "Tweak needs site access to list this site's resolved tweaks.", rows: 0 });
  });
});

// An Undo from the side panel on a page no session claims: it waits, and
// the list says which /tweak brings a session (the card is hidden there).
describe("static, a resolved tweak's undo with no session", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
  const c = fixture.cases.find((x) => x.edit);

  test("the side panel's Undo conflicts with no claim, and says to run /tweak with the command to copy", async () => {
    const path = join(env.app.folder, c.edit.file);
    const original = readFileSync(path);
    try {
      const n = await tracer(env, c, { undo: false });
      await env.tab.evaluate(`ns.panel.show(${n}, { focus: true })`);
      await finishFromCard(env, n, "Resolve");
      writeFileSync(path, readFileSync(path, "utf8").replace(c.edit.replace, c.edit.replace.replace("<", " now<"))); // edited again since
      await env.claude.release();
      await env.watcher.exited;

      const panel = await sidePanel(env);
      await until(() => panel.evaluate((sel) => document.querySelector(`${sel} .tweak-undo button`)?.textContent, RESOLVED_ROW(n)), { is: (s) => s === "Undo", what: "Undo in the side panel" });
      await panel.click(`${RESOLVED_ROW(n)} .tweak-undo button`);
      const origin = new URL(env.app.url("/")).origin;
      const waiting = await until(
        () => panel.evaluate((sel) => ({ text: document.querySelector(`${sel} .tweak-undo > p`)?.textContent, command: document.querySelector(`${sel} .tweak-undo code`)?.textContent }), RESOLVED_ROW(n)),
        { is: (w) => w.command, what: "the waiting text and its command" },
      );
      assert.deepEqual(waiting, { text: "Needs a session to resolve: run", command: `/tweak ${origin}` });
      assert.equal(await panel.evaluate((sel) => document.querySelector(`${sel} .tweak-undo .copy`)?.textContent, RESOLVED_ROW(n)), "Copy");
    } finally {
      writeFileSync(path, original);
    }
  });
});

// Retention (design.md § Storage): its bridge keeps a resolved tweak 3 s
// instead of 7 days (TWEAK_TEST_KEEP_RESOLVED).
describe("static, resolved tweaks are deleted after they're kept", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture, { keepResolved: "3s" });

  test("a withdrawn tweak, its change and its screenshot go, and the side panel drops it", async () => {
    await open(env);
    await pick(env, { selector: "#name" });
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
    await env.page.keyboard.type("tweak the name field");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    const shot = join(env.bridge.state, "screenshots", `${n}.png`);
    mkdirSync(dirname(shot), { recursive: true });
    writeFileSync(shot, "\x89PNG"); // as the screenshot upload stores it
    const panel = await sidePanel(env);
    await finishFromCard(env, n, "Stop and withdraw");
    await until(() => panel.evaluate((sel) => Boolean(document.querySelector(sel)), RESOLVED_ROW(n)), { what: `tweak ${n} listed` });
    await env.claude.tweak("decline", String(n), "withdrawn"); // its capture ends: until then it's kept
    await until(() => !existsSync(shot), { timeout: 15_000, what: "the screenshot to be deleted" });
    await assert.rejects(env.claude.work(n), new RegExp(`there is no tweak ${n}`));
    await until(() => panel.evaluate((sel) => !document.querySelector(sel), RESOLVED_ROW(n)), { what: `tweak ${n} gone from the side panel` });
  });
});

// The toolbar button, the shortcuts and the side panel (design.md § Toolbar
// button, § Pins, § Side panel). Real shortcuts can't be pressed headlessly,
// so the tests call their handlers through the test copy's message.
const panelTarget = (env) => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html"));
const closeSidePanel = (env) => inWorker(env.browser, `chrome.windows.getLastFocused().then((w) => chrome.sidePanel.close({ windowId: w.id }))`);
async function panelPage(env) {
  const target = await until(() => panelTarget(env), { what: "the side panel to open" });
  return target.asPage();
}

// The activeTab path: static again on 127.0.0.1, which the copy has no grant
// for. The toolbar button (page.triggerExtensionAction) grants activeTab: on
// a claimed page it injects the claim's scripts at once and turns pick mode
// on, so a plain click picks, and the capture works, with no reload.
describe("static on 127.0.0.1, through activeTab", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  test("the toolbar button on an unclaimed dev page opens the side panel, with the command to claim it", async () => {
    const app = await env.serve("127.0.0.1");
    await env.page.goto(app.url("/"));
    const [ext] = (await env.browser.extensions()).values();
    await env.page.triggerExtensionAction(ext);
    const panel = await panelPage(env);
    await panel.waitForFunction(
      (c) => !document.getElementById("unclaimed").hidden && document.getElementById("unclaimed-command").textContent === c,
      {},
      `/tweak ${app.url("")}`,
    );
    await closeSidePanel(env);
    await until(() => !panelTarget(env), { what: "the side panel to close" });
  });

  test("the toolbar button on an ungranted claimed page injects the scripts and picks, and the tweak gets its screenshot", async () => {
    const app = await env.serve("127.0.0.1");
    await env.claude.claim(`${app.url("")}/*`);
    await until(() => inWorker(env.browser, `chrome.scripting.getRegisteredContentScripts().then((r) => r.length >= 4)`), {
      what: "the 127.0.0.1 claim's scripts to be registered",
    });
    // No emulated viewport here: the page measures the tab's real view, which
    // is what captureVisibleTab takes.
    await env.page.setViewport(null);
    await env.page.goto(app.url("/"));
    await assert.rejects(env.tab.evaluate(`ns.ready`), /isn't running/, "no scripts before the click: no grant here");
    const [ext] = (await env.browser.extensions()).values();
    await env.page.triggerExtensionAction(ext);
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected" && ns.picker.mode`, { what: "the scripts injected, in pick mode" });
    assert.equal(panelTarget(env), undefined, "a claimed page picks: no side panel");
    const crop = await expectedCrop(env, "#save");
    await env.page.click("#save"); // pick mode: a plain click picks
    await env.tab.until(`Boolean(root.activeElement) && root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
    assert.equal(await env.tab.evaluate(`ns.picker.mode`), false, "a pick ends pick mode");
    await env.page.keyboard.type("make the save button green");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    const shot = await storedScreenshot(env, n);
    assert.deepEqual({ width: shot.width, height: shot.height }, crop);
  });
});

describe("static, the shortcuts and pins", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
  const composing = `Boolean(root.activeElement) && root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`;
  const pinOf = (n) => `[...root.querySelectorAll(".pin")].find((p) => p.dataset.number === "${n}")`;
  const pinShown = (n) => `(() => { const p = ${pinOf(n)}; return Boolean(p) && !p.hidden && p.checkVisibility({ visibilityProperty: true }); })()`;
  const toasted = (text) => `[...root.querySelectorAll(".toast")].some((t) => t.textContent === ${JSON.stringify(text)})`;
  async function send(selector, request) {
    const { n } = await sendTweak(env, { selector }, request);
    await env.page.keyboard.press("Escape");
    await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the card" });
    return n;
  }

  test("⌥⇧C toggles pick mode: pins fade and let clicks through, a plain click picks, and ⌥⇧C again or esc leaves it", async () => {
    await open(env);
    const n = await send("#name", "make the name field wider");
    await env.tab.handler("pick-mode");
    await env.tab.until(`ns.picker.mode && Boolean(root.querySelector(".pins.picking"))`, { what: "pick mode, the pins faded" });
    assert.equal(await env.tab.evaluate(`getComputedStyle(${pinOf(n)}).pointerEvents`), "none", "clicks pass through the pin");
    await env.tab.handler("pick-mode");
    await env.tab.until(`!ns.picker.mode && !root.querySelector(".pins.picking")`, { what: "⌥⇧C again to leave pick mode" });

    await env.tab.handler("pick-mode");
    await env.tab.until(`ns.picker.mode`, { what: "pick mode" });
    await env.page.keyboard.press("Escape");
    await env.tab.until(`!ns.picker.mode`, { what: "esc to leave pick mode" });

    await env.tab.handler("pick-mode");
    await env.tab.until(`ns.picker.mode`, { what: "pick mode" });
    await env.page.evaluate(() => {
      globalThis.e2eClicked = 0;
      document.querySelector("#docs").addEventListener("click", (e) => (e.preventDefault(), globalThis.e2eClicked++));
    });
    await env.page.click("#docs");
    await env.tab.until(composing, { what: "a plain click in pick mode to open the composer" });
    assert.equal(await env.page.evaluate(() => globalThis.e2eClicked), 0, "the page didn't hear the click");
    assert.equal(await env.tab.evaluate(`ns.picker.mode || Boolean(root.querySelector(".pins.picking"))`), false, "the pick ended pick mode");
    await env.page.keyboard.press("Escape");
  });

  test("⌥⇧H hides the site's pins, also after a reload; the new tweak's card and finished tweaks' toasts still show", async () => {
    await open(env);
    const n = await send("#save", "make the save button bigger");
    await env.tab.until(pinShown(n), { what: `tweak ${n}'s pin` });
    await env.tab.handler("pins");
    await env.tab.until(`!${pinShown(n)}`, { what: "⌥⇧H to hide the pins" });
    assert.deepEqual(await inWorker(env.browser, `chrome.storage.local.get("pinsHidden").then((s) => s.pinsHidden)`), { [env.app.url("")]: true });
    await env.tab.until(toasted("Pins hidden on this site. ⌥⇧H shows them."), { what: "a toast saying so" });

    await env.page.reload();
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected" && Boolean(${pinOf(n)})`, { what: "the pins after the reload" });
    assert.equal(await env.tab.evaluate(pinShown(n)), false, "still hidden after a reload");

    // A new tweak's card still opens, and its finish is a toast.
    const m = await send("#name", "make the name field taller");
    await env.claude.tweakWith("made it taller\n", "done", String(m), "-");
    await env.tab.until(toasted(`Tweak ${m}: Change saved`), { what: "the finished tweak's toast" });

    await env.tab.handler("pins");
    await env.tab.until(pinShown(n), { what: "⌥⇧H again to show the pins" });
    assert.deepEqual(await inWorker(env.browser, `chrome.storage.local.get("pinsHidden").then((s) => s.pinsHidden)`), {});
  });

  test("pins re-attach by selector after a reload; one whose element is gone is listed in the side panel, whose Show opens its card", async () => {
    await open(env);
    const n = await send("#docs", "rename the docs link");
    await env.page.reload();
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the content script after the reload" });
    await env.tab.until(pinShown(n), { what: `tweak ${n}'s pin back on #docs` });
    const pin = await env.tab.evaluate(`ns.pins.point(${n})`);
    const box = await (await env.page.$("#docs")).boundingBox();
    assert.ok(pin.x >= box.x && pin.x <= box.x + box.width && pin.y >= box.y && pin.y <= box.y + box.height, "the pin sits on its element");

    await env.page.evaluate(() => document.querySelector("#docs").remove());
    await env.tab.until(`!${pinShown(n)}`, { what: "the pin to go with its element" });
    await env.tab.handler("side-panel");
    const panel = await panelPage(env);
    const row = `#gone li[data-number="${n}"]`;
    await panel.waitForSelector(row);
    assert.match(await panel.$eval(row, (li) => li.textContent), new RegExp(`Tweak ${n}[\\s\\S]*rename the docs link`));
    await panel.$eval(`${row} button`, (b) => b.click());
    await env.tab.until(`ns.panel.showing()`, { is: (s) => s === n, what: "Show to open the card" });
    await env.page.keyboard.press("Escape");
    await env.page.reload(); // #docs is back
    await panel.waitForFunction((r) => !document.querySelector(r), {}, row);
    await closeSidePanel(env);
  });
});

// The badge (design.md § Toolbar button), with Allow access granted: the
// worker reads tab URLs only then.
describe("static, the badge", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture, { allUrls: true });
  const tabBadge = () =>
    inWorker(
      env.browser,
      `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async ([t]) => [await chrome.action.getBadgeText({ tabId: t.id }), (await chrome.action.getBadgeBackgroundColor({ tabId: t.id })).slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")])`,
    );
  const badgeIs = (text, colour) => until(tabBadge, { is: ([t, c]) => t === text && (!colour || c === colour), what: `the badge "${text}" ${colour ?? ""}` });

  test("it counts the page's open tweaks, coloured by the most urgent, and clears once it ends", async () => {
    await open(env);
    await badgeIs("");
    env.watcher.stop(); // nobody picks it up: it stays sent
    await pick(env, { selector: "#save" });
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer" });
    await env.page.keyboard.type("make it green");
    await env.page.keyboard.press("Enter");
    const n = await env.tab.until(`ns.panel.showing()`, { what: "the card" });
    await badgeIs("1", "6d4fd0"); // purple: sent
    env.watcher = env.claude.watch();
    await env.claude.nextTweak(env.watcher);
    await badgeIs("1", "e08a00"); // amber: working
    await env.claude.tweak("ask", String(n), "Which green?");
    await badgeIs("1", "2563d9"); // blue: a question
    await env.claude.tweak("decline", String(n), "no green fits");
    await badgeIs("");
    await env.page.keyboard.press("Escape");
  });

  test("an unclaimed dev-looking page gets the grey !, recomputed as the tab navigates; another website gets none", async () => {
    const app = await env.serve("127.0.0.1");
    await env.page.goto(app.url("/"));
    await badgeIs("!", "80868b");
    await env.page.goto("data:text/html,<p>not a dev server</p>");
    await badgeIs("");
  });

  // From #81: the side panel slides in, narrowing the view over several
  // frames. A pick made meanwhile must still get the crop of what it points at.
  test("a pick made while the side panel slides in gets a screenshot of what it points at", async () => {
    await env.page.setViewport(null);
    await open(env);
    await env.tab.handler("side-panel");
    const { n } = await sendTweak(env, { selector: "#save" }, "make the save button blue");
    const shot = await storedScreenshot(env, n);
    // The crop is of the element as the page now is, with the panel open.
    const crop = await expectedCrop(env, "#save");
    assert.deepEqual({ width: shot.width, height: shot.height }, crop);
    await env.page.keyboard.press("Escape");
    await closeSidePanel(env);
  });
});
