// The e2e harness (design.md § The runner, § Round trips). One test file
// per fixture calls setup(fixture) inside its describe, then adds a test per
// case. See test/e2e/static.test.js.
import { after, before } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { contentScript, inWorker, launch, until } from "./browser.js";
import { devBridge, standIn } from "./claude.js";
import { testCopy } from "./extension.js";
import { startFixture } from "./fixture.js";
import { briefProblems } from "./golden.js";

export { loadFixture, skipReason } from "./fixture.js";
export { until } from "./browser.js";

// Starts everything one fixture's tests share, before its first test, and
// stops it all after its last, failures included:
// - the fixture app, on a free port;
// - a development bridge, which the stand-in's first tweak claim starts;
// - Chrome with the extension's test copy;
// - the stand-in for Claude, which has claimed the app's origin and is
//   running tweak watch.
// The returned object is filled in by the time a test runs.
export function setup(fixture) {
  const env = {};
  before(async (t) => {
    env.app = await startFixture(fixture);
    t.diagnostic(`${fixture.name} ready in ${env.app.bootMs} ms`);
    env.bridge = await devBridge();
    env.extension = testCopy({ bridgePort: env.bridge.port });
    env.claude = standIn(env.bridge, { folder: env.app.folder });
    await env.claude.claim(`${env.app.url("")}/*`);
    env.watcher = env.claude.watch();
    env.browser = await launch(env.extension);
    // A page loaded while the worker is still registering the claim's
    // scripts can miss them, so the first page waits for the registration.
    const registered = await until(() => inWorker(env.browser, `chrome.scripting.getRegisteredContentScripts().then((r) => r.length > 0)`));
    assert.ok(registered, "the extension registered the claim's scripts");
    env.page = await env.browser.newPage();
    await env.page.setViewport({ width: 1100, height: 800 });
    env.tab = await contentScript(env.page);
  });
  after(async () => {
    await env.browser?.close().catch(() => {});
    env.claude?.stop();
    await env.bridge?.stop();
    await env.app?.stop();
    if (env.extension) rmSync(env.extension, { recursive: true, force: true });
  });
  return env;
}

// Opens a page of the app and waits for the content script to connect.
export async function open(env, path = "/") {
  await env.page.goto(env.app.url(path));
  const live = await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`);
  assert.ok(live, `the content script didn't connect on ${path}`);
}

// Points at a case's pick the way the developer would.
export async function pick(env, target) {
  if (!target.selector) throw new Error(`pick ${JSON.stringify(target)} isn't supported yet: only {selector}`);
  const el = await env.page.waitForSelector(target.selector, { visible: true });
  const box = await el.boundingBox();
  await env.page.keyboard.down("Alt");
  await env.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await env.page.keyboard.up("Alt");
  return env.tab.evaluate(`ns.describe.element(document.querySelector(${JSON.stringify(target.selector)}))`);
}

const CARD_STATUS = `root.querySelector(".panel .status span:last-child")?.textContent`;

// A golden case through the tracer: pick it, send a tweak, let the stand-in
// work it, check the brief against the case, finish it, and see the card
// reach Done. Round-trip cases (with `edit`) will add the edit and Undo.
export async function tracer(env, c, { request = `tweak the ${c.name}`, summary = `tweaked the ${c.name}` } = {}) {
  await open(env, c.path ?? "/");
  const element = await pick(env, c.pick);
  assert.ok(await env.tab.until(`root.activeElement === root.querySelector(".panel textarea")`), "the composer opens with the focus");
  await env.page.keyboard.type(request);
  await env.page.keyboard.press("Enter");

  const from = env.watcher.lines.length;
  const tweak = await env.claude.nextTweak(env.watcher, { from });
  const n = tweak.number;
  assert.match(tweak.line, new RegExp(`^tweak ${n} new: ${RegExp.escape(request)} \\[`));
  assert.ok(await env.tab.until(`root.querySelector(".panel .title")?.textContent === "Tweak ${n}"`), `the card is tweak ${n}`);

  // The brief, as Claude reads it: tokens, not layout.
  const { brief } = tweak;
  assert.equal(brief.split("\n")[0], `# Tweak ${n}`);
  assert.ok(brief.includes(request), "the brief has the request");
  for (const token of [element.label, element.selector]) assert.ok(brief.includes(`\`${token}\``), `the brief names \`${token}\``);
  assert.deepEqual(briefProblems(brief, c), []);
  assert.ok(await env.tab.until(`${CARD_STATUS}?.startsWith("Claude is working on it")`), "the card shows Claude working");

  await env.claude.done(n, summary);
  assert.ok(await env.tab.until(`${CARD_STATUS} === "Change saved"`), "the card shows Done");
  assert.equal(await env.tab.evaluate(`root.querySelector(".panel .summary")?.textContent`), summary);
  await env.page.keyboard.press("Escape");
  await env.tab.until(`!root.querySelector(".panel")`);
  return n;
}
