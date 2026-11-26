// The browser while the bridge is down (design.md § When the bridge or
// extension is down), on the static fixture: the development bridge is
// stopped mid-test and started again on the same database.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inWorker } from "./harness/browser.js";
import { freePort } from "./harness/fixture.js";
import { CARD_STATUS, CARD_TITLE, COMPOSER_INPUT, REPLY_INPUT, REPLY_SEND, loadFixture, open, pick, setup, skipReason, until } from "./harness/index.js";

const fixture = loadFixture("static");

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
    await pick(env, { selector: "#save" });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type("make the save button green");

    await down();
    await reload();
    await env.tab.until(`ns.panel.targets()?.elements[0]?.selector`, { is: (s) => s === "#save", what: "the composer to reopen on #save" });
    await env.tab.until(value(COMPOSER_INPUT), { is: (v) => v === "make the save button green", what: "its text, restored" });
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
});
