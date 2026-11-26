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

describe("static", { skip: skipReason(fixture) ?? false }, () => {
  const env = setup(fixture);

  for (const c of fixture.cases) {
    test(`${c.name}: the tracer reaches Done, checked against the brief`, () => tracer(env, c));
    test(`${c.name}: Claude asks, the developer replies from the card, then Done`, () => conversation(env, c));
  }

  // An Undo around a later edit on the same line conflicts: nothing is
  // written, and the session reverses it by hand.
  test("an Undo that conflicts goes to Claude, which reverses it by hand with tweak undo and tweak undone", async () => {
    const c = fixture.cases.find((x) => x.edit);
    const path = join(env.app.folder, c.edit.file);
    const original = readFileSync(path);
    try {
      await conflictByHand(c, path, original);
    } finally {
      writeFileSync(path, original); // later tests share the copy
    }
  });

  async function conflictByHand(c, path, original) {
    const n = await tracer(env, c, { undo: false });
    const later = readFileSync(path, "utf8").replace(c.edit.replace, c.edit.replace.replace("<", " now<"));
    writeFileSync(path, later); // the developer edits the changed line again

    await open(env, c.path ?? "/");
    await env.tab.evaluate(`ns.panel.show(${n}, { focus: true })`);
    // The card takes the focus a frame later. Pressed before that, Undo
    // loses it to the card, and the Enter does nothing.
    await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(CARD)})`, { what: "the card to take the focus" });
    const from = env.watcher.lines.length;
    await undoFromCard(env, { note: "Undo needs Claude: 1 of 1 files changed since" });
    assert.equal(readFileSync(path, "utf8"), later, "nothing was written");
    await env.watcher.line(new RegExp(`^tweak ${n} undo-conflict: 1 of 1 files need resolving$`), { from });

    const change = await env.claude.tweak("undo", String(n));
    assert.ok(change.includes(`## \`${c.edit.file}\`: conflicts`), `tweak undo marks the conflict:\n${change}`);
    writeFileSync(path, original); // reversed by hand
    assert.equal(await env.claude.tweak("undone", String(n), "put the label back"), `tweak ${n}: undone\n`);
    await env.tab.until(`root.querySelector(".panel .undo .undo-note")?.textContent`, { is: (s) => s === "Undone", what: "the card to say Undone" });
    await env.page.keyboard.press("Escape");
  }

  // The mappers run while you type: a source map that comes later than
  // 300 ms after the pick, but before Send, still places the rule.
});
