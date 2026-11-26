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


// The activeTab path: static again on 127.0.0.1, which the copy has no grant
// for. The toolbar button (page.triggerExtensionAction) grants activeTab: on
// a claimed page it injects the claim's scripts at once and turns pick mode
// on, so a plain click picks, and the capture works, with no reload.
describe("static on 127.0.0.1, through activeTab", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  test("the toolbar button on an unclaimed dev page opens the side panel, with the command to claim it", async () => {
    const app = await env.serve("127.0.0.1");
    await env.page.goto(app.url("/"));
    const [ext] = (await env.browser.extensions()).values();
    await env.page.triggerExtensionAction(ext);
    const panel = await panelPage(env);
    await panel.waitForFunction(
      (c) => !document.getElementById("unclaimed").hidden && document.getElementById("unclaimed-command").textContent === c,
      {},
      `/tweak ${app.url("")}`,
    );
    await closeSidePanel(env);
    await until(() => !panelTarget(env), { what: "the side panel to close" });
  });

  test("the toolbar button on an ungranted claimed page injects the scripts and picks, and the tweak gets its screenshot", async () => {
    const app = await env.serve("127.0.0.1");
    await env.claude.claim(`${app.url("")}/*`);
    await until(() => inWorker(env.browser, `chrome.scripting.getRegisteredContentScripts().then((r) => r.length >= 4)`), {
      what: "the 127.0.0.1 claim's scripts to be registered",
    });
    // No emulated viewport here: the page measures the tab's real view, which
    // is what captureVisibleTab takes.
    await env.page.setViewport(null);
    await env.page.goto(app.url("/"));
    await assert.rejects(env.tab.evaluate(`ns.ready`), /isn't running/, "no scripts before the click: no grant here");
    const [ext] = (await env.browser.extensions()).values();
    await env.page.triggerExtensionAction(ext);
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected" && ns.picker.mode`, { what: "the scripts injected, in pick mode" });
    assert.equal(panelTarget(env), undefined, "a claimed page picks: no side panel");
    const crop = await expectedCrop(env, "#save");
    await env.page.click("#save"); // pick mode: a plain click picks
    await env.tab.until(`Boolean(root.activeElement) && root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
    assert.equal(await env.tab.evaluate(`ns.picker.mode`), false, "a pick ends pick mode");
    await env.page.keyboard.type("make the save button green");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    const shot = await storedScreenshot(env, n);
    assert.deepEqual({ width: shot.width, height: shot.height }, crop);
  });
});

describe("static, the shortcuts and pins", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
  const composing = `Boolean(root.activeElement) && root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`;
  const pinOf = (n) => `[...root.querySelectorAll(".pin")].find((p) => p.dataset.number === "${n}")`;
  const pinShown = (n) => `(() => { const p = ${pinOf(n)}; return Boolean(p) && !p.hidden && p.checkVisibility({ visibilityProperty: true }); })()`;
  const toasted = (text) => `[...root.querySelectorAll(".toast")].some((t) => t.textContent === ${JSON.stringify(text)})`;
  async function send(selector, request) {
    const { n } = await sendTweak(env, { selector }, request);
    await env.page.keyboard.press("Escape");
    await env.tab.until(`!root.querySelector(${JSON.stringify(CARD)})`, { what: "esc to close the card" });
    return n;
  }

  test("⌥⇧C toggles pick mode: pins fade and let clicks through, a plain click picks, and ⌥⇧C again or esc leaves it", async () => {
    await open(env);
    const n = await send("#name", "make the name field wider");
    await env.tab.handler("pick-mode");
    await env.tab.until(`ns.picker.mode && Boolean(root.querySelector(".pins.picking"))`, { what: "pick mode, the pins faded" });
    assert.equal(await env.tab.evaluate(`getComputedStyle(${pinOf(n)}).pointerEvents`), "none", "clicks pass through the pin");
    await env.tab.handler("pick-mode");
    await env.tab.until(`!ns.picker.mode && !root.querySelector(".pins.picking")`, { what: "⌥⇧C again to leave pick mode" });

    await env.tab.handler("pick-mode");
    await env.tab.until(`ns.picker.mode`, { what: "pick mode" });
    await env.page.keyboard.press("Escape");
    await env.tab.until(`!ns.picker.mode`, { what: "esc to leave pick mode" });

    await env.tab.handler("pick-mode");
    await env.tab.until(`ns.picker.mode`, { what: "pick mode" });
    await env.page.evaluate(() => {
      globalThis.e2eClicked = 0;
      document.querySelector("#docs").addEventListener("click", (e) => (e.preventDefault(), globalThis.e2eClicked++));
    });
    await env.page.click("#docs");
    await env.tab.until(composing, { what: "a plain click in pick mode to open the composer" });
    assert.equal(await env.page.evaluate(() => globalThis.e2eClicked), 0, "the page didn't hear the click");
    assert.equal(await env.tab.evaluate(`ns.picker.mode || Boolean(root.querySelector(".pins.picking"))`), false, "the pick ended pick mode");
    await env.page.keyboard.press("Escape");
  });

  test("⌥⇧H hides the site's pins, also after a reload; the new tweak's card and finished tweaks' toasts still show", async () => {
    await open(env);
    const n = await send("#save", "make the save button bigger");
    await env.tab.until(pinShown(n), { what: `tweak ${n}'s pin` });
    await env.tab.handler("pins");
    await env.tab.until(`!${pinShown(n)}`, { what: "⌥⇧H to hide the pins" });
    assert.deepEqual(await inWorker(env.browser, `chrome.storage.local.get("pinsHidden").then((s) => s.pinsHidden)`), { [env.app.url("")]: true });
    await env.tab.until(toasted("Pins hidden on this site. ⌥⇧H shows them."), { what: "a toast saying so" });

    await env.page.reload();
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected" && Boolean(${pinOf(n)})`, { what: "the pins after the reload" });
    assert.equal(await env.tab.evaluate(pinShown(n)), false, "still hidden after a reload");

    // A new tweak's card still opens, and its finish is a toast.
    const m = await send("#name", "make the name field taller");
    await env.claude.tweakWith("made it taller\n", "done", String(m), "-");
    await env.tab.until(toasted(`Tweak ${m}: Change saved`), { what: "the finished tweak's toast" });

    await env.tab.handler("pins");
    await env.tab.until(pinShown(n), { what: "⌥⇧H again to show the pins" });
    assert.deepEqual(await inWorker(env.browser, `chrome.storage.local.get("pinsHidden").then((s) => s.pinsHidden)`), {});
  });

  test("pins re-attach by selector after a reload; one whose element is gone is listed in the side panel, whose Show opens its card", async () => {
    await open(env);
    const n = await send("#docs", "rename the docs link");
    await env.page.reload();
    await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the content script after the reload" });
    await env.tab.until(pinShown(n), { what: `tweak ${n}'s pin back on #docs` });
    const pin = await env.tab.evaluate(`ns.pins.point(${n})`);
    const box = await (await env.page.$("#docs")).boundingBox();
    assert.ok(pin.x >= box.x && pin.x <= box.x + box.width && pin.y >= box.y && pin.y <= box.y + box.height, "the pin sits on its element");

    await env.page.evaluate(() => document.querySelector("#docs").remove());
    await env.tab.until(`!${pinShown(n)}`, { what: "the pin to go with its element" });
    await env.tab.handler("side-panel");
    const panel = await panelPage(env);
    const row = `#gone li[data-number="${n}"]`;
    await panel.waitForSelector(row);
    assert.match(await panel.$eval(row, (li) => li.textContent), new RegExp(`Tweak ${n}[\\s\\S]*rename the docs link`));
    await panel.$eval(`${row} button`, (b) => b.click());
    await env.tab.until(`ns.panel.showing()`, { is: (s) => s === n, what: "Show to open the card" });
    await env.page.keyboard.press("Escape");
    await env.page.reload(); // #docs is back
    await panel.waitForFunction((r) => !document.querySelector(r), {}, row);
    await closeSidePanel(env);
  });
});

// The badge (design.md § Toolbar button), with Allow access granted: the
// worker reads tab URLs only then.
describe("static, the badge", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture, { allUrls: true });
  const tabBadge = () =>
    inWorker(
      env.browser,
      `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async ([t]) => [await chrome.action.getBadgeText({ tabId: t.id }), (await chrome.action.getBadgeBackgroundColor({ tabId: t.id })).slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")])`,
    );
  const badgeIs = (text, colour) => until(tabBadge, { is: ([t, c]) => t === text && (!colour || c === colour), what: `the badge "${text}" ${colour ?? ""}` });

  test("it counts the page's open tweaks, coloured by the most urgent, and clears once it ends", async () => {
    await open(env);
    await badgeIs("");
    env.watcher.stop(); // nobody picks it up: it stays sent
    await pick(env, { selector: "#save" });
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer" });
    await env.page.keyboard.type("make it green");
    await env.page.keyboard.press("Enter");
    const n = await env.tab.until(`ns.panel.showing()`, { what: "the card" });
    await badgeIs("1", "6d4fd0"); // purple: sent
    env.watcher = env.claude.watch();
    await env.claude.nextTweak(env.watcher);
    await badgeIs("1", "e08a00"); // amber: working
    await env.claude.tweak("ask", String(n), "Which green?");
    await badgeIs("1", "2563d9"); // blue: a question
    await env.claude.tweak("decline", String(n), "no green fits");
    await badgeIs("");
    await env.page.keyboard.press("Escape");
  });

  test("an unclaimed dev-looking page gets the grey !, recomputed as the tab navigates; another website gets none", async () => {
    const app = await env.serve("127.0.0.1");
    await env.page.goto(app.url("/"));
    await badgeIs("!", "80868b");
    await env.page.goto("data:text/html,<p>not a dev server</p>");
    await badgeIs("");
  });

  // From #81: the side panel slides in, narrowing the view over several
  // frames. A pick made meanwhile must still get the crop of what it points at.
  test("a pick made while the side panel slides in gets a screenshot of what it points at", async () => {
    await env.page.setViewport(null);
    await open(env);
    await env.tab.handler("side-panel");
    const { n } = await sendTweak(env, { selector: "#save" }, "make the save button blue");
    const shot = await storedScreenshot(env, n);
    // The crop is of the element as the page now is, with the panel open.
    const crop = await expectedCrop(env, "#save");
    assert.deepEqual({ width: shot.width, height: shot.height }, crop);
    await env.page.keyboard.press("Escape");
    await closeSidePanel(env);
  });
});
