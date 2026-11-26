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

// Reloading after a change, source maps served late, and the harness's own ways in.
describe("static, reloads and the harness", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
  test("a source map served late, while the request is typed, still gives the rule's line", async () => {
    const late = (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (req.url().endsWith("/theme.css.map")) setTimeout(() => req.continue().catch(() => {}), 600);
      else req.continue().catch(() => {});
    };
    await env.page.setRequestInterception(true);
    env.page.on("request", late);
    try {
      await open(env);
      const served = env.page.waitForResponse((r) => r.url().endsWith("/theme.css.map"));
      await pick(env, { selector: ".plan-title" });
      await env.tab.until(composing, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("tweak the plan title");
      await served; // as a person types, past the 300 ms
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n, brief } = await env.claude.nextTweak(env.watcher, { from });
      try {
        assert.deepEqual(briefProblems(brief, { locations: [{ file: "src/theme.css", line: 10, role: "style", via: "css" }] }), []);
      } finally {
        await strandNothing(env, n); // done, and the card closed
      }
    } finally {
      env.page.off("request", late);
      await env.page.setRequestInterception(false);
    }
  });

  // Reloading after a change (design.md § Reloading after a change): the
  // side panel's per-site switch, and a reload held back by a form's unsaved
  // input. The reasons themselves are unit tests (test/extension/reload.test.js).
  test("the side panel's switch turns auto-reload on for the site; unsaved input holds the reload back, and Reload reloads", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    const target = await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "the side panel" });
    const panel = await target.asPage();
    const site = new URL(env.app.url("/")).origin;
    await until(() => panel.evaluate(`!document.getElementById("reload-setting").hidden && document.getElementById("reload-setting").dataset.origin`), {
      is: (s) => s === site,
      what: "the reload setting for the site in front",
    });
    assert.equal(await panel.evaluate(`document.getElementById("auto-reload").checked`), false, "off, as the harness leaves it");
    const origin = JSON.stringify(new URL(env.app.url("/")).origin);
    const setting = () => panel.evaluate(`chrome.storage.local.get("autoReload").then(({ autoReload: a = {} }) => a[${origin}] ?? "on")`);
    // The switch's own click, as a press of it gives: on Linux CI the side
    // panel's page can have no box for Puppeteer's pointer to land in.
    const flip = () => panel.evaluate(`document.getElementById("auto-reload").click()`);
    await flip();
    await until(async () => (await setting()) === "on", { what: "the switch to turn auto-reload on" });
    try {
      await env.page.bringToFront();
      await pick(env, { selector: "#docs" });
      await env.tab.until(composing, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("held back");
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.claude.tweak("work", String(n));
      await env.page.type("#name", "typed, not saved");
      await env.page.evaluate(() => (window.e2eNotReloaded = true));
      await env.claude.tweakWith("done\n", "done", String(n), "-");
      await env.tab.until(`root.querySelector(".panel .reload-why")?.textContent`, {
        is: (s) => s === "Not reloaded: a form on the page has unsaved input.",
        what: "the card to say why the page hasn't reloaded",
      });
      assert.equal(await env.tab.evaluate(`root.querySelector(${JSON.stringify(CARD_STATUS)}).textContent`), "Change saved");
      assert.equal(await env.tab.evaluate(`root.querySelector(".panel .reload-now").hidden`), false, "Change saved · Reload");
      await new Promise((done) => setTimeout(done, 700)); // past a recheck: still held
      assert.equal(await env.page.evaluate(() => window.e2eNotReloaded), true, "held back while the input is unsaved");
      await env.tab.evaluate(`root.querySelector(".panel .reload-now").click()`);
      await until(() => env.page.evaluate(() => window.e2eNotReloaded === undefined && document.readyState === "complete"), { what: "Reload to reload the page" });
      await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the content script back after the reload" });
      await env.page.keyboard.press("Escape");
    } finally {
      await flip();
      await until(async () => (await setting()) === false, { what: "the switch to turn auto-reload off again" });
      await panel.close();
    }
  });

  test("a field the page's own script fills doesn't hold the reload back", async () => {
    await open(env);
    await autoReload(env, true);
    try {
      await pick(env, { selector: "#docs" });
      await env.tab.until(composing, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("not held back");
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.claude.tweak("work", String(n));
      // As a time picker checks its first slot: set by script, not by you.
      await env.page.evaluate(() => (document.querySelector("#name").value = "set by the page"));
      await mark(env);
      await env.claude.tweakWith("done\n", "done", String(n), "-");
      await until(() => env.page.evaluate(() => window.e2eNotReloaded === undefined && document.readyState === "complete"), { what: "Done to reload the page" });
      await env.tab.until(`Boolean(root) && ns.worker.connection === "connected"`, { what: "the content script back after the reload" });
      await env.page.keyboard.press("Escape");
    } finally {
      await autoReload(env, false);
    }
  });

  // The update signals a page with no Vite can give, recorded from working:
  // a stylesheet swapped, and a full reload with the card open. Either
  // means the page already shows the change, so Done reloads nothing.
  async function working(selector, words) {
    await open(env);
    await env.page.bringToFront(); // the side panel may have had it
    await pick(env, { selector });
    await env.tab.until(composing, { what: "the composer to open with the focus" });
    await env.page.keyboard.type(words);
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    await env.claude.tweak("work", String(n));
    await env.tab.until(`root.querySelector(${JSON.stringify(CARD_STATUS)})?.textContent`, {
      is: (s) => s?.startsWith("Claude is working on it"),
      what: "the card to show Claude working",
    });
    return n;
  }
  async function noReloadAfterDone(n, signal) {
    await env.claude.tweakWith("done\n", "done", String(n), "-");
    const last = await env.tab.until(`ns.reload.last?.number === ${n} && ns.reload.last`, { what: "the reload decision" });
    assert.equal(last.signal, signal);
    assert.equal(await marked(env), true, "no reload after Done");
    await env.page.keyboard.press("Escape");
  }

  test("a stylesheet swapped while Claude works means the page has updated: Done reloads nothing", async () => {
    await autoReload(env, true);
    try {
      const n = await working("#docs", "restyle this");
      await mark(env);
      // As Vite swaps a <link>: a copy with a new href, then the old one goes.
      await env.page.evaluate(() => {
        const old = document.querySelector('link[href="/styles.css"]');
        const swapped = old.cloneNode();
        swapped.href = "/styles.css?t=1";
        old.after(swapped);
        old.remove();
      });
      await noReloadAfterDone(n, "style");
    } finally {
      await autoReload(env, false);
    }
  });

  test("a full reload while Claude works, with the card open, means the page has updated: Done reloads nothing", async () => {
    await autoReload(env, true);
    try {
      const n = await working("#docs", "reload this");
      await env.page.reload();
      await open(env, "/", { goto: false });
      await env.tab.until(`root.querySelector(".panel .title")?.textContent`, { is: (t) => t === `Tweak ${n}`, what: "the card back after the reload" });
      await mark(env);
      await noReloadAfterDone(n, "reload");
    } finally {
      await autoReload(env, false);
    }
  });

  // The harness itself, once, here.
  test("the test copy's message calls a worker handler: the side panel opens", async () => {
    await open(env);
    await env.tab.handler("side-panel");
    await until(() => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html")), { what: "a side panel target" });
  });

  // The copy has http://localhost/* but not <all_urls>, as before Allow access.
  test("without site access, tweak claim says to click Allow access", async () => {
    await open(env);
    const out = await env.claude.claim(`${env.app.url("")}/*`);
    assert.match(out, /^site access not granted: open the Codaset Tweak side panel and click Allow access, or ⌥-click won't work$/m);
  });

  test("after a navigation the content script handle reaches the new page, never the old one", async () => {
    await open(env);
    await env.tab.evaluate(`(globalThis.e2eMarker = "old page", true)`);
    await open(env, "/again");
    assert.equal(await env.tab.evaluate(`globalThis.e2eMarker ?? "new page"`), "new page");
  });

  test("the fixture can be served again on 127.0.0.1", async () => {
    const again = await env.serve("127.0.0.1");
    assert.equal(again.url("/"), `http://127.0.0.1:${again.port}/`);
    assert.equal((await fetch(again.url("/"))).status, 200);
  });

  // Overlay layering (design.md § Overlay layering): what the overlay draws
  // is what the page's own hit test finds, over a modal dialog and a popover.
});
