// The e2e harness (design.md § The runner, § Round trips). One test file
// per fixture calls setup(fixture) inside its describe, then adds a test per
// case. See test/e2e/static.test.js.
import { after, before } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { contentScript, inWorker, launch } from "./browser.js";
import { devBridge, standIn } from "./claude.js";
import { testCopy } from "./extension.js";
import { startFixture } from "./fixture.js";
import { briefProblems } from "./golden.js";
import { until } from "./util.js";

export { loadFixture, skipReason } from "./fixture.js";
export { until } from "./util.js";

// The overlay's parts, as selectors inside its shadow root (`root`).
export const COMPOSER_INPUT = ".panel textarea";
export const CARD = ".panel";
export const CARD_TITLE = ".panel .title";
export const CARD_STATUS = ".panel .status span:last-child";
export const CARD_SUMMARY = ".panel .entry.kind-summary .entry-text";
// The conversation under the request: one .entry per entry, its kind in a
// kind-<kind> class; the reply box while Claude has a question.
export const CARD_ENTRY = ".panel .entry";
export const REPLY_INPUT = ".panel .answer textarea";
export const REPLY_SEND = ".panel .answer .send";
// Send again, while Claude hasn't picked a tweak up.
export const CARD_RESEND = ".panel .retry .send";
// What a finished tweak changed: its title ("Files changed", "No edits
// recorded", "No files changed") and the recorded files' paths.
export const CARD_CHANGE = ".panel .change .entry-label";
export const CARD_FILES = ".panel .change > .files .path";
const text = (selector) => `root.querySelector(${JSON.stringify(selector)})?.textContent`;
const entryText = (kind) => text(`.panel .entry.kind-${kind} .entry-text`);

// Starts everything one fixture's tests share, before its first test, and
// stops it all after its last, failures included. Returns an object that's
// filled in by the time a test runs:
// - app: the fixture on a free port, served as localhost (startFixture's
//   app: folder, port, host, bootMs, url(path), output(), stop());
// - bridge: the development bridge's port, state folder and env; the
//   stand-in's first tweak claim starts it;
// - extension: the test copy's folder;
// - claude: the stand-in (standIn), which has claimed the app's origin;
// - watcher: its running tweak watch;
// - browser, page: Chrome with the test copy, and the page tests drive;
// - tab: the content script in that page (contentScript);
// - serve(host): the same fixture again on another host, e.g. 127.0.0.1
//   for the activeTab path, stopped with the rest.
// Options go to devBridge: againAfter shortens the bridge's 3-minute wait
// before an again: line. Give such a setup its own describe, so its again:
// lines and card text reach no other test.
export function setup(fixture, options = {}) {
  const extra = [];
  const env = {
    async serve(host) {
      const app = await startFixture(fixture, { host });
      extra.push(app);
      return app;
    },
  };
  before(async (t) => {
    env.app = await startFixture(fixture);
    t.diagnostic(`${fixture.name} ready in ${env.app.bootMs} ms`);
    env.bridge = await devBridge(options);
    env.extension = testCopy({ bridgePort: env.bridge.port });
    env.claude = standIn(env.bridge, { folder: env.app.folder });
    await env.claude.claim(`${env.app.url("")}/*`);
    env.watcher = env.claude.watch();
    env.browser = await launch(env.extension);
    // A page loaded before the worker registers the claim's scripts never
    // gets them: the worker injects into open tabs only with <all_urls>,
    // which the copy doesn't grant. So the first page waits for them.
    await until(() => inWorker(env.browser, `chrome.scripting.getRegisteredContentScripts().then((r) => r.length > 0)`), {
      what: "the extension to register the claim's scripts",
    });
    env.page = await env.browser.newPage();
    await env.page.setViewport({ width: 1100, height: 800 });
    env.tab = await contentScript(env.page);
  });
  after(async () => {
    await env.browser?.close().catch(() => {});
    env.claude?.stop();
    await env.bridge?.stop();
    await Promise.all([env.app, ...extra].map((app) => app?.stop()));
    if (env.extension) rmSync(env.extension, { recursive: true, force: true });
  });
  return env;
}

// Opens a page of the app and waits for the content script to connect.
export async function open(env, path = "/") {
  await env.page.goto(env.app.url(path));
  await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: `the content script to connect on ${path}` });
}

// Points at a case's pick the way the developer would, and returns how the
// extension describes the element: {label, text, selector}.
export async function pick(env, target) {
  if (!target.selector) throw new Error(`pick ${JSON.stringify(target)} isn't supported yet: only {selector}`);
  const el = await env.page.waitForSelector(target.selector, { visible: true });
  const box = await el.boundingBox();
  await env.page.keyboard.down("Alt");
  try {
    await env.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } finally {
    await env.page.keyboard.up("Alt");
  }
  return env.tab.evaluate(`ns.describe.element(document.querySelector(${JSON.stringify(target.selector)}))`);
}

// Answers Claude's question from the open card the way the developer would:
// types into the reply box and presses ↵. It resolves once the card says the
// reply is on its way back to Claude.
export async function replyFromCard(env, answer) {
  await env.tab.until(`(() => { const a = root.querySelector(".panel .answer"); return Boolean(a) && !a.hidden; })()`, {
    what: "the card's reply box",
  });
  await env.tab.evaluate(`root.querySelector(${JSON.stringify(REPLY_INPUT)}).focus()`);
  await env.page.keyboard.type(answer);
  await env.page.keyboard.press("Enter");
  await env.tab.until(text(CARD_STATUS), { is: (s) => s === "Reply sent" || s === "Claude has your reply", what: "the card to show the reply sent" });
}

// A golden case as a conversation: pick it and send a tweak, let the
// stand-in work it and ask a question, which opens the card without taking
// the focus; reply from the card; the reply reaches the watcher; work again
// gets the brief with the Latest line and the conversation; then done.
export async function conversation(env, c, { request = `tweak the ${c.name}`, question = "Which colour?", answer = "green", summary = `made the ${c.name} green` } = {}) {
  await pickCase(env, c);
  await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
  await env.page.keyboard.type(request);
  const from = env.watcher.lines.length;
  await env.page.keyboard.press("Enter");
  const { number: n } = await env.claude.nextTweak(env.watcher, { from });
  await env.tab.until(text(CARD_TITLE), { is: (t) => t === `Tweak ${n}`, what: `the card to be tweak ${n}` });

  // Close the card: the question opens it again by itself.
  await env.page.keyboard.press("Escape");
  await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the card" });
  await env.claude.tweak("ask", String(n), question);
  await env.tab.until(text(CARD_STATUS), { is: (s) => s === "Claude has a question", what: "the question to open the card" });
  assert.equal(await env.tab.evaluate(entryText("question")), question);
  assert.equal(await env.tab.evaluate("root.activeElement"), null, "the question doesn't take the focus");

  const replied = env.watcher.lines.length;
  await replyFromCard(env, answer);
  await env.watcher.line(new RegExp(`^tweak ${n} reply: ${answer}$`), { from: replied });
  const brief = await env.claude.work(n);
  assert.ok(brief.includes(`**Latest:** the developer replied to your question: "${answer}".`), "the brief leads with the reply");
  assert.ok(brief.includes("## Conversation"), "the brief has the conversation");

  await env.claude.tweakWith(`${summary}\n`, "done", String(n), "-");
  await env.tab.until(text(CARD_STATUS), { is: (s) => s === "Change saved", what: "the card to show Done" });
  assert.equal(await env.tab.evaluate(text(CARD_SUMMARY)), summary);
  await env.page.keyboard.press("Escape");
  await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the card" });
  return n;
}

// pickCase opens a case's page, clicks its `first` control if it has one
// (such as the button that opens a dialog), and makes its pick.
async function pickCase(env, c) {
  await open(env, c.path ?? "/");
  if (c.first?.click) await env.page.click(c.first.click);
  return pick(env, c.pick);
}

// A golden case through the tracer: pick it, send a tweak, let the stand-in
// work it, check the brief against the case, finish it, and see the card
// reach Done. A round-trip case (with `edit`) makes its edit through the
// edit hook between work and done, and the Done card lists the file; Undo
// is still to come. The brief's and the watch line's own layout are
// golden-tested in Go; this checks the wiring.
export async function tracer(env, c, { request = `tweak the ${c.name}`, summary = `tweaked the ${c.name}`, edit = c.edit } = {}) {
  const element = await pickCase(env, c);
  await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
  await env.page.keyboard.type(request);
  // Before the send: its line can arrive while press() is still resolving.
  const from = env.watcher.lines.length;
  await env.page.keyboard.press("Enter");

  const { number: n, brief } = await env.claude.nextTweak(env.watcher, { from });
  await env.tab.until(text(CARD_TITLE), { is: (t) => t === `Tweak ${n}`, what: `the card to be tweak ${n}` });

  // What the page sent reached the brief Claude reads.
  assert.ok(brief.includes(request), "the brief has the request");
  for (const token of [element.label, element.selector]) assert.ok(brief.includes(`\`${token}\``), `the brief names \`${token}\``);
  assert.deepEqual(briefProblems(brief, c), []);
  await env.tab.until(text(CARD_STATUS), { is: (s) => s?.startsWith("Claude is working on it"), what: "the card to show Claude working" });

  // A round-trip case's edit, through the edit hook, as Claude makes it.
  // A case's edit is made once, by its own tracer test: other tests reuse
  // the case on the same copy, and pass edit: null.
  if (edit) await env.claude.edit(edit);

  // The summary goes in on stdin, as `tweak done <n> -` reads it.
  await env.claude.tweakWith(`${summary}\n`, "done", String(n), "-");
  await env.tab.until(text(CARD_STATUS), { is: (s) => s === "Change saved", what: "the card to show Done" });
  assert.equal(await env.tab.evaluate(text(CARD_SUMMARY)), summary);
  if (edit) {
    // The card lists the file the hook recorded. Undo comes with #40.
    await env.tab.until(text(CARD_CHANGE), { is: (s) => s === "Files changed", what: "the card to list the files changed" });
    assert.deepEqual(await env.tab.evaluate(`[...root.querySelectorAll(${JSON.stringify(CARD_FILES)})].map((f) => f.textContent)`), [edit.file]);
  }
  await env.page.keyboard.press("Escape");
  await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the card" });
  return n;
}
