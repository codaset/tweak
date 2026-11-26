// The content script's status text, loaded as the classic script it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const src = readFileSync(new URL("../../extension/content/describe.js", import.meta.url), "utf8");
const ns = { ready: false, teardowns: [] };
runInNewContext(src, { codasetTweak: ns, globalThis: { codasetTweak: ns } });
const { status } = ns.describe;

const at = (iso, ms) => Date.parse(iso) + ms;

test("each status reads as the card shows it", () => {
  assert.equal(status({ status: "sent" }).text, "Waiting for a session");
  assert.equal(status({ status: "delivered" }).text, "Claude has it");
  assert.equal(status({ status: "done" }).text, "Change saved");
  assert.equal(status({ status: "done" }).tone, "done");
});

test("while working, the card counts the time since it started", () => {
  const t = { status: "working", statusAt: "2026-11-26T10:00:00.000Z" };
  assert.equal(status(t, at(t.statusAt, 12_400)).text, "Claude is working on it · 12 s");
  assert.equal(status(t, at(t.statusAt, 6 * 60_000 + 5_000)).text, "Claude is working on it · 6 min");
  assert.equal(status(t, at(t.statusAt, 65 * 60_000)).text, "Claude is working on it · 1 h 5 min");
  assert.equal(status(t, at(t.statusAt, -3_000)).text, "Claude is working on it · 0 s");
});

test("pins and the card share the status classes: the tone, and working", () => {
  const { classes } = ns.describe;
  assert.equal(classes({ status: "working" }), "tone-working working");
  assert.equal(classes({ status: "question" }), "tone-question");
  assert.equal(classes({ status: "withdrawn" }), "tone-ended");
  assert.equal(classes(undefined), "tone-sent"); // a card whose tweak hasn't arrived yet
});

test("every status reads as the card shows it, and declined is never success", () => {
  const read = (s) => ({ ...status({ status: s }) });
  assert.deepEqual(read("queued"), { text: "Queued", tone: "sent" });
  assert.deepEqual(read("question"), { text: "Claude has a question", tone: "question" });
  assert.deepEqual(read("declined"), { text: "Declined", tone: "ended" });
  assert.equal(ns.describe.classes({ status: "declined" }), "tone-ended");
});

test("after a reply the tweak waits for Claude again, and says so", () => {
  const replied = { status: "sent", entries: [{ kind: "request" }, { kind: "question" }, { kind: "reply" }] };
  assert.deepEqual({ ...status(replied) }, { text: "Reply sent", tone: "sent" });
  assert.equal(status({ ...replied, status: "delivered" }).text, "Claude has your reply");
});

test("the thread is the conversation after the request, each entry labelled", () => {
  const { thread } = ns.describe;
  const t = {
    entries: [
      { from: "you", kind: "request", text: "make it green" },
      { from: "claude", kind: "plan", text: "Editing buttons.css" },
      { from: "claude", kind: "question", text: "Solid or outline?" },
      { from: "you", kind: "reply", text: "outline" },
      { from: "claude", kind: "reason", text: "it comes from the CMS" },
      { from: "claude", kind: "summary", text: "made it green" },
    ],
  };
  assert.deepEqual(
    thread(t).map((e) => [e.kind, e.label, e.text]),
    [
      ["plan", "Claude's plan", "Editing buttons.css"],
      ["question", "Claude asks", "Solid or outline?"],
      ["reply", "You replied", "outline"],
      ["reason", "Why Claude declined", "it comes from the CMS"],
      ["summary", "Claude", "made it green"],
    ],
  );
  assert.equal(thread(undefined).length, 0);
});

test("each entry carries its classes, and whether to announce it", () => {
  const { thread } = ns.describe;
  const t = {
    entries: [
      { from: "you", kind: "request", text: "make it green" },
      { from: "claude", kind: "question", text: "Solid or outline?" },
      { from: "you", kind: "reply", text: "outline" },
      { from: "bridge", kind: "notice", text: "passed to another session" },
    ],
  };
  assert.deepEqual(
    thread(t).map((e) => [e.className, e.announce]),
    [
      ["entry kind-question from-claude", "Claude asks: Solid or outline?"],
      ["entry kind-reply from-you", ""], // the developer's own words aren't read back
      ["entry kind-notice from-bridge", "Tweak: passed to another session"],
    ],
  );
});

test("a card whose tweak hasn't arrived yet reads Sending", () => {
  assert.deepEqual({ ...status(undefined) }, { text: "Sending…", tone: "sent" });
});

test("a delivered tweak Claude hasn't picked up after two resends says so, from the wait and the resends", () => {
  const { unanswered } = ns.describe;
  const waiting = { status: "delivered", resends: 2, againAt: "2026-11-26T10:09:00.000Z" };
  const busy = "Claude hasn't picked this up. The session may be busy.";
  assert.equal(status(waiting, at(waiting.againAt, -1)).text, "Claude has it", "still waiting");
  assert.equal(unanswered(waiting, at(waiting.againAt, -1)), false);
  assert.deepEqual({ ...status(waiting, at(waiting.againAt, 0)) }, { text: busy, tone: "sent" });
  assert.equal(unanswered(waiting, at(waiting.againAt, 0)), true);
  // One resend still the bridge's to send, an again: line on its way, or picked up: not yet.
  assert.equal(unanswered({ ...waiting, resends: 1 }, at(waiting.againAt, 1)), false);
  assert.equal(unanswered({ status: "delivered", resends: 3 }, at(waiting.againAt, 1)), false);
  assert.equal(unanswered({ ...waiting, status: "working" }, at(waiting.againAt, 1)), false);
  assert.equal(unanswered({ ...waiting, resends: 3 }, at(waiting.againAt, 1)), true, "a Send again unanswered too");
  const replied = { ...waiting, entries: [{ kind: "request" }, { kind: "question" }, { kind: "reply" }] };
  assert.equal(status(replied, at(waiting.againAt, 0)).text, busy);
});
