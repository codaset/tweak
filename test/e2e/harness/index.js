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
export const CARD_SUMMARY = ".panel .summary";
const text = (selector) => `root.querySelector(${JSON.stringify(selector)})?.textContent`;

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
export function setup(fixture) {
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
    env.bridge = await devBridge();
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

// A golden case through the tracer: pick it, send a tweak, let the stand-in
// work it, check the brief against the case, finish it, and see the card
// reach Done. Round-trip cases (with `edit`) will add the edit and Undo
// between work and done. The brief's and the watch line's own layout are
// golden-tested in Go; this checks the wiring.
export async function tracer(env, c, { request = `tweak the ${c.name}`, summary = `tweaked the ${c.name}` } = {}) {
  await open(env, c.path ?? "/");
  const element = await pick(env, c.pick);
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

  // The summary goes in on stdin, as `tweak done <n> -` reads it.
  await env.claude.tweakWith(`${summary}\n`, "done", String(n), "-");
  await env.tab.until(text(CARD_STATUS), { is: (s) => s === "Change saved", what: "the card to show Done" });
  assert.equal(await env.tab.evaluate(text(CARD_SUMMARY)), summary);
  await env.page.keyboard.press("Escape");
  await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the card" });
  return n;
}
