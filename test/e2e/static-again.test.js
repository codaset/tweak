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
