// The e2e harness (design.md § The runner, § Round trips). One test file
// per fixture calls setup(fixture) inside its describe, then adds a test per
// case. See test/e2e/static.test.js.
import { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
export const CARD_STATUS = ".panel .status .status-text";
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
// Undo below it: the button (Undo, or Ask Claude to undo), and the note:
// where an undo with Claude stands, or Undone.
export const CARD_UNDO = ".panel .undo .send";
export const CARD_UNDO_NOTE = ".panel .undo .undo-note";
// The card's foot: Withdraw while Claude is on it, Resolve once it's finished.
export const CARD_ACTION = ".panel .actions .send";
// The side panel's resolved tweaks: one row per tweak, by number.
export const RESOLVED_ROW = (n) => `#resolved-list li[data-number="${n}"]`;
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
// before an again: line, lapseAfter its 10-minute claim lapse, and
// unwatchedAfter its minute before "no watcher running", keepResolved its 7
// days before a resolved tweak is deleted. Give such a setup
// its own describe, so what they make happen reaches no other test. allUrls
// gives the test copy <all_urls>, as after Allow access, which screenshots
// need; deviceScaleFactor sets the page's.
export function setup(fixture, options = {}) {
  const extra = [];
  const env = {
    fixture,
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
    env.extension = testCopy({ bridgePort: env.bridge.port, allUrls: options.allUrls });
    env.claude = standIn(env.bridge, { folder: env.app.folder });
    await env.claude.claim(`${env.app.url("")}/*`);
    env.watcher = env.claude.watch();
    env.browser = await launch(env.extension, { deviceScaleFactor: options.deviceScaleFactor });
    // A page loaded before the worker registers the claim's scripts never
    // gets them: the worker injects into open tabs only with <all_urls>,
    // which the copy doesn't grant. So the first page waits for them.
    await until(() => inWorker(env.browser, `chrome.scripting.getRegisteredContentScripts().then((r) => r.length > 0)`), {
      what: "the extension to register the claim's scripts",
    });
    // Auto-reload starts off for the app, so a Done in a test that isn't a
    // round trip reloads nothing under it; round trips turn it on.
    await autoReload(env, false);
    env.page = await env.browser.newPage();
    await env.page.setViewport({ width: 1100, height: 800, deviceScaleFactor: options.deviceScaleFactor ?? 1 });
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

// Opens a page of the app and waits for the content script to connect,
// and for the fixture's `loaded` selector, if it has one (a page rendered on
// the server is hydrated later: SvelteKit's metadata comes with hydration).
// goto: false waits on the page already there, as after a reload.
export async function open(env, path = "/", { goto = true } = {}) {
  if (goto) await env.page.goto(env.app.url(path));
  if (env.fixture?.loaded) await env.page.waitForSelector(env.fixture.loaded);
  await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: `the content script to connect on ${path}` });
}

// Points at a case's pick the way the developer would, and waits for the
// composer to open on it:
// - {selector}: ⌥-click the element;
// - {selectors: [a, b, …]}: ⌥-click a, then ⌥⇧-click each of the others;
// - {text, in?}: select the first occurrence of text in the element `in`
//   (default body), then ⌥-click it;
// - {area: {x, y, width, height}}: ⌥-drag that box, in viewport CSS pixels;
//   {area: {around: [selectors], margin}}: the box around those elements,
//   so the case doesn't hang on the platform's fonts.
// It returns how the extension describes element 1 ({label, text,
// selector}), with the composer's targets.
export async function pick(env, target) {
  const { page } = env;
  const centre = async (selector) => {
    const box = await (await page.waitForSelector(selector, { visible: true })).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const selectors = target.selectors ?? (target.selector ? [target.selector] : null);
  let at = null;
  if (target.text) at = await select(page, target.text, target.in ?? "body");
  else if (selectors) at = await centre(selectors[0]);
  else if (!target.area) throw new Error(`pick ${JSON.stringify(target)}: give a selector, selectors, text or an area`);
  const before = await composerTargets(env);
  await page.keyboard.down("Alt");
  try {
    if (target.area) {
      const { x, y, width, height } = target.area.around ? await around(page, target.area.around, target.area.margin ?? 0) : target.area;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + width, y + height, { steps: 8 });
      await page.mouse.up();
    } else {
      await page.mouse.click(at.x, at.y);
      if (selectors?.length > 1) await env.tab.until(`ns.panel.targets()?.elements.length === 1`, { what: "the composer on element 1" });
      for (const [i, s] of (selectors ?? []).slice(1).entries()) {
        const c = await centre(s);
        await page.keyboard.down("Shift");
        try {
          await page.mouse.click(c.x, c.y);
        } finally {
          await page.keyboard.up("Shift");
        }
        await env.tab.until(`ns.panel.targets()?.elements.length`, { is: (n) => n === i + 2, what: `element ${i + 2} added` });
      }
    }
  } finally {
    await page.keyboard.up("Alt");
  }
  const targets = await env.tab.until(`ns.panel.targets()`, {
    is: (t) => Boolean(t) && JSON.stringify(t) !== JSON.stringify(before),
    what: `the composer to open on ${JSON.stringify(target)}`,
  });
  const { label, text: words, selector } = targets.elements[0];
  return { label, text: words, selector, targets };
}

const composerTargets = (env) => env.tab.evaluate(`ns.panel.targets()`);

// around is the box holding the elements, plus a margin, in viewport pixels.
async function around(page, selectors, margin) {
  const boxes = await Promise.all(selectors.map(async (s) => (await page.waitForSelector(s, { visible: true })).boundingBox()));
  const x = Math.min(...boxes.map((b) => b.x)) - margin;
  const y = Math.min(...boxes.map((b) => b.y)) - margin;
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + margin;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + margin;
  return { x, y, width: right - x, height: bottom - y };
}

// select selects the first occurrence of text inside the element `within`
// on the page, as the developer would by dragging over it, and returns
// the middle of its first line box.
function select(page, text, within) {
  return page.evaluate(
    (text, within) => {
      const root = document.querySelector(within);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const r = range.getClientRects()[0];
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      throw new Error(`no "${text}" in ${within}`);
    },
    text,
    within,
  );
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
  try {
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
  } catch (err) {
    await strandNothing(env, n);
    throw err;
  }
  return n;
}

// strandNothing finishes tweak n and closes its card; after a failure in
// the test that sent it, so a tweak left working (or asking) holds no later
// test back. A test's own failure is what it reports.
export async function strandNothing(env, n) {
  await env.claude.tweakWith("finished after a failed test\n", "done", String(n), "-").catch(() => {});
  await env.page.keyboard.press("Escape").catch(() => {});
}

// pickCase opens a case's page, clicks its `first` control if it has one
// (such as the button that opens a dialog), and makes its pick.
async function pickCase(env, c) {
  await open(env, c.path ?? "/");
  if (c.first?.click) await env.page.click(c.first.click);
  return pick(env, c.pick);
}

// Clicks the open card's Undo (or Ask Claude to undo) the way the
// developer would, and resolves once the card says where the undo stands:
// the note's text, such as "Undone".
export async function undoFromCard(env, { label = "Undo", note = "Undone" } = {}) {
  // Shown, not just built: a card opened before its tweak arrives has a
  // hidden Undo already labelled.
  const button = `(() => { const b = root.querySelector(${JSON.stringify(CARD_UNDO)}); return b && !b.hidden && !b.closest("[hidden]") && b.textContent; })()`;
  await env.tab.until(button, { is: (s) => s === label, what: `the card's ${label} button` });
  await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_UNDO)}).focus()`);
  await env.page.keyboard.press("Enter");
  await env.tab.until(text(CARD_UNDO_NOTE), { is: (s) => (note instanceof RegExp ? note.test(s ?? "") : s === note), what: `the card to say ${note}` });
}

// Clicks the open card's Withdraw or Resolve the way the developer would,
// and resolves once the tweak has left the page: its card has closed and
// its pin has gone.
export async function finishFromCard(env, n, label) {
  await env.tab.until(text(CARD_ACTION), { is: (s) => s === label, what: `the card's ${label} button` });
  // A card just shown takes the focus a frame later: focus the button after it.
  const button = `root.querySelector(${JSON.stringify(CARD_ACTION)})`;
  await env.tab.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(${button}.focus()))))`);
  await env.tab.until(`root.activeElement === ${button}`, { what: `the focus on ${label}` });
  await env.page.keyboard.press("Enter");
  await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)}) && ![...root.querySelectorAll(".pin")].some((p) => p.textContent === "${n}")`, {
    what: `tweak ${n}'s card and pin to leave the page`,
  });
}

// The side panel, opened as the developer would (the toolbar's context
// menu, through the test copy's handler), as a page tests can drive. It
// follows the tab in front: env.page.
export async function sidePanel(env) {
  await env.tab.handler("side-panel");
  const target = await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "the side panel" });
  const panel = await target.asPage();
  await panel.waitForFunction(() => document.getElementById("status").dataset.connection === "connected");
  return panel;
}

// autoReload turns the app's per-site auto-reload setting on or off, as the
// side panel's switch does (storage.local's autoReload, {origin: false}).
export function autoReload(env, on) {
  const origin = JSON.stringify(new URL(env.app.url("/")).origin);
  return inWorker(
    env.browser,
    `chrome.storage.local.get("autoReload").then(({ autoReload: a = {} }) => {
      if (${on}) delete a[${origin}]; else a[${origin}] = false;
      return chrome.storage.local.set({ autoReload: a });
    })`,
  );
}

// mark puts a mark in the page's own world, which a reload wipes, and
// forgets the content script's last reload decision.
export async function mark(env) {
  await env.page.evaluate(() => (window.e2eNotReloaded = true));
  await env.tab.evaluate(`(ns.reload.last = null)`);
}
export const marked = (env) => env.page.evaluate(() => window.e2eNotReloaded === true);

// The card's reason for not reloading the page, under "Change saved · Reload".
export const CARD_RELOAD = ".panel .status .reload-now";
export const CARD_RELOAD_WHY = ".panel .reload-why";
const OFF = "Not reloaded: auto-reload is off for this site.";

// updated waits for the page to show want in the picked element after a
// change, and checks how it got there. Auto-reload is off until now, so
// nothing reloads under the card's checks before this. On a fixture with
// `hot` set it's the dev server's hot update, which the probe heard
// (ns.reload.last), with no reload after it. Otherwise the card holds the
// reload back, saying auto-reload is off, and turning it on reloads the
// page by itself (the page's own world is new).
async function updated(env, c, n, want, what) {
  const { selector } = c.pick;
  const shows = () =>
    until(() => env.page.evaluate((s) => document.querySelector(s)?.textContent.trim(), selector), {
      is: (t) => t === want,
      what: `the page to show "${want}" ${what}`,
    });
  if (!env.fixture.hot) {
    await env.tab.until(text(CARD_RELOAD_WHY), { is: (s) => s === OFF, what: `the card to hold the reload back ${what}` });
    assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_RELOAD)}).hidden`), false, "Change saved · Reload");
    assert.equal(await marked(env), true, "no reload while auto-reload is off");
    await autoReload(env, true);
    try {
      await shows();
      assert.equal(await marked(env), false, `our reload shows the page ${what}`);
      await open(env, c.path ?? "/", { goto: false });
    } finally {
      await autoReload(env, false);
    }
    return;
  }
  await shows();
  const last = await env.tab.until(`ns.reload.last?.number === ${n} && ns.reload.last`, { what: `the reload decision ${what}` });
  assert.equal(last.signal, "vite", "the probe's hot context heard vite:afterUpdate");
  assert.equal(last.reloaded, undefined, "no reload follows the hot update");
  assert.equal(await marked(env), true, `the hot update shows the page ${what}, with no reload`);
}

// A golden case through the tracer: pick it, send a tweak, let the stand-in
// work it, check the brief against the case, finish it, and see the card
// reach Done. A round-trip case (with `edit`) makes its edit through the
// edit hook between work and done; the Done card lists the file, and the
// page shows the edit (edit.text is the picked element's text then), by the
// hot update or by our reload (see updated); and its Undo puts the file
// back byte for byte and the page as it was. The brief's and the watch
// line's own layout are golden-tested in Go; this checks the wiring.
// undo: false leaves the change in place, for a test that undoes it later.
export async function tracer(env, c, { request = `tweak the ${c.name}`, summary = `tweaked the ${c.name}`, edit = c.edit, undo = true } = {}) {
  const element = await pickCase(env, c);
  await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
  await env.page.keyboard.type(request);
  // A person types for longer than the mappers take, and the composer keeps
  // what they find until Send: so does the case, which presses ↵ at once.
  const want = c.locations?.length ?? 0;
  if (want) {
    await env.tab.until(`ns.panel.targets()?.elements.reduce((n, e) => n + (e.locations?.length ?? 0), 0)`, {
      is: (n) => n >= want,
      what: `the mappers' ${want} location(s)`,
    });
  }
  // Before the send: its line can arrive while press() is still resolving.
  const from = env.watcher.lines.length;
  await env.page.keyboard.press("Enter");

  const { number: n, brief } = await env.claude.nextTweak(env.watcher, { from });
  try {
    await env.tab.until(text(CARD_TITLE), { is: (t) => t === `Tweak ${n}`, what: `the card to be tweak ${n}` });

    // What the page sent reached the brief Claude reads.
    assert.ok(brief.includes(request), "the brief has the request");
    for (const token of [element.label, element.selector]) assert.ok(brief.includes(`\`${token}\``), `the brief names \`${token}\``);
    assert.deepEqual(briefProblems(brief, c), []);
    await env.tab.until(text(CARD_STATUS), { is: (s) => s?.startsWith("Claude is working on it"), what: "the card to show Claude working" });

    // A round-trip case's edit, through the edit hook, as Claude makes it.
    // A case's edit is made once, by its own tracer test: other tests reuse
    // the case on the same copy, and pass edit: null.
    const edited = edit && join(env.app.folder, edit.file);
    const original = edit && readFileSync(edited);
    const shown = edit && (await env.page.evaluate((s) => document.querySelector(s)?.textContent.trim(), c.pick.selector));
    if (edit) {
      await mark(env);
      await env.claude.edit(edit);
    }

    // The summary goes in on stdin, as `tweak done <n> -` reads it.
    await env.claude.tweakWith(`${summary}\n`, "done", String(n), "-");
    await env.tab.until(text(CARD_STATUS), { is: (s) => s === "Change saved", what: "the card to show Done" });
    assert.equal(await env.tab.evaluate(text(CARD_SUMMARY)), summary);
    if (edit) {
      // The card lists the file the hook recorded.
      await env.tab.until(text(CARD_CHANGE), { is: (s) => s === "Files changed", what: "the card to list the files changed" });
      assert.deepEqual(await env.tab.evaluate(`[...root.querySelectorAll(${JSON.stringify(CARD_FILES)})].map((f) => f.textContent)`), [edit.file]);
      // It's read out as it arrives, and the list keeps its list semantics.
      await env.tab.until(text(".panel .sr-only"), { is: (s) => s?.includes("1 file changed"), what: "the change to be read out" });
      assert.equal(await env.tab.evaluate(`root.querySelector(".panel .change > .files").getAttribute("role")`), "list");
      assert.equal(await env.tab.evaluate(`root.querySelector(".panel .change").hasAttribute("tabindex")`), false, "a short list is no tab stop");

      // The page shows the change; after our reload the card is back, Done.
      await updated(env, c, n, edit.text, "after the change");
      await env.tab.until(text(CARD_STATUS), { is: (s) => s === "Change saved", what: "the card to show Done after the update" });
    }
    if (edit && undo) {
      // Undo puts it back, byte for byte, and the page with it.
      await mark(env);
      await undoFromCard(env);
      assert.ok(readFileSync(edited).equals(original), `${edit.file} is back as it was`);
      assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_UNDO)}).hidden`), true, "no Undo once undone");
      assert.equal(await env.tab.evaluate(`root.activeElement === root.querySelector(".panel")`), true, "the focus stays in the card");
      await updated(env, c, n, shown, "undone");
      await env.tab.until(text(CARD_UNDO_NOTE), { is: (s) => s === "Undone", what: "the card to say Undone after the update" });
    }
    await env.page.keyboard.press("Escape");
    await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the card" });
  } catch (err) {
    await strandNothing(env, n);
    throw err;
  }
  return n;
}
