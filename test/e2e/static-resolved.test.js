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


// Withdraw, Resolve and the side panel's resolved tweaks (design.md § When
// the session goes quiet, § Side panel). Their tweaks leave the page, so each
// describe has its own bridge.
describe("static, withdrawn and resolved tweaks", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
  const c = fixture.cases.find((x) => x.edit);
  const row = (panel, n) => panel.evaluate((sel) => {
    const li = document.querySelector(sel);
    if (!li || li.closest("[hidden]")) return null;
    const pick = (s) => li.querySelector(s)?.textContent ?? null;
    return { status: pick(".tweak-status"), request: pick(".tweak-request"), change: pick(".tweak-change"), undo: pick(".tweak-undo button"), note: pick(".tweak-undo > p") };
  }, RESOLVED_ROW(n));

  test("Withdraw while Claude works: the session hears it, the pin goes, and Claude's decline keeps the change for the side panel's Undo", async () => {
    const path = join(env.app.folder, c.edit.file);
    const original = readFileSync(path);
    try {
      await open(env, c.path ?? "/");
      await pick(env, c.pick);
      await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
      await env.page.keyboard.type("label it Save draft");
      const from = env.watcher.lines.length;
      await env.page.keyboard.press("Enter");
      const { number: n } = await env.claude.nextTweak(env.watcher, { from });
      await env.tab.until(`root.querySelector(${JSON.stringify(CARD_STATUS)})?.textContent`, { is: (s) => s?.startsWith("Claude is working on it"), what: "Claude working" });
      await env.claude.edit(c.edit);

      const heard = env.watcher.lines.length;
      await finishFromCard(env, n, "Stop and withdraw");
      await env.tab.until(text(".toasts"), { is: (s) => s?.includes(`Tweak ${n} withdrawn`), what: "a toast saying where it went" });
      await env.watcher.line(new RegExp(`^tweak ${n} withdrawn$`), { from: heard });
      assert.equal(await env.claude.tweak("decline", String(n), "withdrawn"), `tweak ${n}: withdrawn, change kept for Undo\n`);
      assert.equal(await env.claude.work(n), `tweak ${n}: withdrawn, skip it\n`);

      const panel = await sidePanel(env);
      const listed = await until(() => row(panel, n), { is: (r) => r?.undo === "Undo", what: `tweak ${n} in the side panel with Undo` });
      assert.equal(listed.status, "Withdrawn");
      assert.equal(listed.request, "label it Save draft");
      assert.equal(listed.change, "1 file changed");
      await panel.focus(`${RESOLVED_ROW(n)} .tweak-undo button`);
      await panel.keyboard.press("Enter");
      await until(() => row(panel, n), { is: (r) => r?.note === "Undone", what: "the side panel to say Undone" });
      assert.ok(readFileSync(path).equals(original), `${c.edit.file} is back as it was`);
    } finally {
      writeFileSync(path, original);
    }
  });

  test("Resolve on a finished tweak takes its pin off the page, and lists it in the side panel", async () => {
    const n = await tracer(env, c, { edit: null, summary: "nothing to change" });
    await env.tab.evaluate(`ns.panel.show(${n}, { focus: true })`);
    await finishFromCard(env, n, "Resolve");
    await env.tab.until(text(".toasts"), { is: (s) => s?.includes(`Tweak ${n} resolved`), what: "a toast saying where it went" });
    const panel = await sidePanel(env);
    const listed = await until(() => row(panel, n), { what: `tweak ${n} in the side panel` });
    assert.equal(listed.status, "Change saved");
    // A reload brings back no pin for it.
    await open(env, c.path ?? "/");
    assert.equal(await env.tab.evaluate(`[...root.querySelectorAll(".pin")].some((p) => p.dataset.number === "${n}")`), false);

    // On a tab whose address it can't read (127.0.0.1: this copy has no
    // access there), the list is about no site, so it lists none, and says why.
    const app = await env.serve("127.0.0.1");
    await env.page.goto(app.url("/"));
    const shown = await until(
      () => panel.evaluate(() => {
        const note = document.getElementById("resolved-access");
        return note.hidden || note.closest("[hidden]") ? null : { note: note.textContent, rows: document.querySelectorAll("#resolved-list li").length };
      }),
      { what: "the side panel to say why it lists no resolved tweaks" },
    );
    assert.deepEqual(shown, { note: "Tweak needs site access to list this site's resolved tweaks.", rows: 0 });
  });
});

// An Undo from the side panel on a page no session claims: it waits, and
// the list says which /tweak brings a session (the card is hidden there).
describe("static, a resolved tweak's undo with no session", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);
  const c = fixture.cases.find((x) => x.edit);

  test("the side panel's Undo conflicts with no claim, and says to run /tweak with the command to copy", async () => {
    const path = join(env.app.folder, c.edit.file);
    const original = readFileSync(path);
    try {
      const n = await tracer(env, c, { undo: false });
      await env.tab.evaluate(`ns.panel.show(${n}, { focus: true })`);
      await finishFromCard(env, n, "Resolve");
      writeFileSync(path, readFileSync(path, "utf8").replace(c.edit.replace, c.edit.replace.replace("<", " now<"))); // edited again since
      await env.claude.release();
      await env.watcher.exited;

      const panel = await sidePanel(env);
      await until(() => panel.evaluate((sel) => document.querySelector(`${sel} .tweak-undo button`)?.textContent, RESOLVED_ROW(n)), { is: (s) => s === "Undo", what: "Undo in the side panel" });
      await panel.click(`${RESOLVED_ROW(n)} .tweak-undo button`);
      const origin = new URL(env.app.url("/")).origin;
      const waiting = await until(
        () => panel.evaluate((sel) => ({ text: document.querySelector(`${sel} .tweak-undo > p`)?.textContent, command: document.querySelector(`${sel} .tweak-undo code`)?.textContent }), RESOLVED_ROW(n)),
        { is: (w) => w.command, what: "the waiting text and its command" },
      );
      assert.deepEqual(waiting, { text: "Needs a session to resolve: run", command: `/tweak ${origin}` });
      assert.equal(await panel.evaluate((sel) => document.querySelector(`${sel} .tweak-undo .copy`)?.textContent, RESOLVED_ROW(n)), "Copy");
    } finally {
      writeFileSync(path, original);
    }
  });
});

// Retention (design.md § Storage): its bridge keeps a resolved tweak 1.5 s
// instead of 7 days (TWEAK_TEST_KEEP_RESOLVED).
describe("static, resolved tweaks are deleted after they're kept", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture, { keepResolved: "1.5s" });

  test("a withdrawn tweak, its change and its screenshot go, and the side panel drops it", async () => {
    await open(env);
    await pick(env, { selector: "#name" });
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
    await env.page.keyboard.type("tweak the name field");
    const from = env.watcher.lines.length;
    await env.page.keyboard.press("Enter");
    const { number: n } = await env.claude.nextTweak(env.watcher, { from });
    const shot = join(env.bridge.state, "screenshots", `${n}.png`);
    mkdirSync(dirname(shot), { recursive: true });
    writeFileSync(shot, "\x89PNG"); // as the screenshot upload stores it
    const panel = await sidePanel(env);
    await finishFromCard(env, n, "Stop and withdraw");
    await until(() => panel.evaluate((sel) => Boolean(document.querySelector(sel)), RESOLVED_ROW(n)), { what: `tweak ${n} listed` });
    await env.claude.tweak("decline", String(n), "withdrawn"); // its capture ends: until then it's kept
    await until(() => !existsSync(shot), { timeout: 15_000, what: "the screenshot to be deleted" });
    await assert.rejects(env.claude.work(n), new RegExp(`there is no tweak ${n}`));
    await until(() => panel.evaluate((sel) => !document.querySelector(sel), RESOLVED_ROW(n)), { what: `tweak ${n} gone from the side panel` });
  });
});
