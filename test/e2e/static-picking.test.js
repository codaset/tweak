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

// Picking, marks and the overlay over the page's own layers: dialogs, popovers.
describe("static, picking and marks", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

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
});
