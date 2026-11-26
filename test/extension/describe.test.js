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

test("a card whose tweak hasn't arrived yet reads Sending", () => {
  assert.deepEqual({ ...status(undefined) }, { text: "Sending…", tone: "sent" });
});
