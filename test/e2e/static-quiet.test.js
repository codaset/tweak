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
