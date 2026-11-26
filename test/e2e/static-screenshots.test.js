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
