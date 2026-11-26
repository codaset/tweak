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

// The browser while the bridge is down (design.md § When the bridge or
// extension is down): the development bridge is stopped mid-test and
// started again on the same database.
describe("static, while the bridge is down", { skip: skipReason(fixture) ?? false }, () => {
  // <all_urls>, so the badge is clear while connected: the grey ! then means down.
  const env = setup(fixture, { allUrls: true });

  const RECONNECT = 5_000; // the test copy's retries reach every second (harness/extension.js)
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
      // The close, then two tries refused (each would have been an error).
      await until(() => inWorker(env.browser, `e2eRetries()`), { is: (n) => n >= 3, what: "two tries at the bridge refused" });
      await up();
      const { runtimeErrors } = await extensions.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), id);
      assert.deepEqual(runtimeErrors.map((e) => e.message).filter((m) => /WebSocket|ERR_CONNECTION_REFUSED/.test(m)), []);
    } finally {
      await extensions.close();
    }
  });
});
