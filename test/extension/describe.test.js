// The content script's status text, loaded as the classic script it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./probe-world.js";

const ns = { ready: false, teardowns: [] };
loadScript("describe.js", ns);
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

test("Send again hides until its resend shows, and only for that resend", () => {
  const { resendOffer } = ns.describe;
  const now = Date.parse("2026-11-26T10:20:00.000Z");
  const unanswered = (resends) => ({ status: "delivered", resends, againAt: "2026-11-26T10:09:00.000Z" });
  assert.deepEqual({ ...resendOffer(unanswered(2), undefined, now) }, { offer: true, sentAt: undefined });
  // Answered at 2 resends, before the tweak-again event: hidden.
  assert.deepEqual({ ...resendOffer(unanswered(2), 2, now) }, { offer: false, sentAt: 2 });
  // The event arrives: the line is on its way, and the hold ends.
  assert.deepEqual({ ...resendOffer({ status: "delivered", resends: 3 }, 2, now) }, { offer: false, sentAt: undefined });
  // Claude picks it up, asks, and the reply goes unanswered twice: offered again.
  assert.deepEqual({ ...resendOffer({ status: "working" }, 2, now) }, { offer: false, sentAt: undefined });
  assert.deepEqual({ ...resendOffer(unanswered(2), undefined, now) }, { offer: true, sentAt: undefined });
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

// docs/design.md § When the session goes quiet. The worker gives each tweak
// heldBy: the session holding its page, and whether it's listening.
test("a tweak waiting on a session that isn't listening says so, naming its folder", () => {
  const deaf = { folder: "~/dev/ernie", listening: false };
  const quiet = "Waiting for the session in ~/dev/ernie, which isn't listening right now";
  assert.deepEqual({ ...status({ status: "sent", heldBy: deaf }) }, { text: quiet, tone: "sent", quiet: true, code: "~/dev/ernie" });
  assert.equal(status({ status: "delivered", heldBy: deaf }).text, quiet);
  // #31's case: no watcher, so one again: only, and the card would stay on "Claude has it".
  assert.equal(status({ status: "delivered", resends: 1, heldBy: deaf }).text, quiet);
  // Ahead of the unanswered text and a reply's.
  const waiting = { status: "delivered", resends: 2, againAt: "2026-11-26T10:09:00.000Z", heldBy: deaf };
  assert.equal(status(waiting, at(waiting.againAt, 0)).text, quiet);
  assert.equal(status({ ...waiting, entries: [{ kind: "request" }, { kind: "question" }, { kind: "reply" }] }).text, quiet);
  // Listening, or no longer waiting on the session: as before.
  assert.equal(status({ status: "sent", heldBy: { ...deaf, listening: true } }).text, "Waiting for a session");
  assert.equal(status({ status: "queued", heldBy: deaf }).text, "Queued");
  assert.equal(status({ status: "question", heldBy: deaf }).text, "Claude has a question");
});

test("a lapsed session's tweak says it stopped responding, and lists the files it already changed, with no Undo", () => {
  const { change, undo } = ns.describe;
  const file = (path, outside = false) => ({ path, outside });
  const left = { folder: "~/dev/ernie", why: "lapsed" };
  const tweak = { status: "sent", url: "http://localhost/", left, change: { state: "recorded", checked: true, files: [file("public/index.html")], unrecorded: [file("b.css")] } };
  assert.deepEqual({ ...status(tweak) }, { text: "The session stopped responding · Waiting for a session", tone: "sent", quiet: true });
  const c = change(tweak);
  assert.deepEqual([c.kind, c.title, c.files.map((f) => f.path), c.unrecorded.map((f) => f.path)], ["partial", "Files already changed", ["public/index.html"], ["b.css"]]);
  assert.equal(undo(tweak), null);
  // Nothing changed yet: nothing to list.
  assert.equal(change({ status: "sent", left }), null);
  assert.equal(change({ ...tweak, change: { ...tweak.change, files: [], unrecorded: [] } }), null);
  // Released or ended: the page is unclaimed, and the tweak simply waits.
  assert.equal(status({ status: "sent", left: { ...left, why: "released" } }).text, "Waiting for a session");
});

test("a finished tweak's card says what it changed", () => {
  const { change } = ns.describe;
  const file = (path, outside = false) => ({ path, outside });
  const tweak = (status, c) => ({ status, change: { state: "recorded", checked: true, files: [], unrecorded: [], ...c } });
  const said = (t) => {
    const c = change(t);
    return c && [c.title, c.files.map((f) => f.path), c.unrecorded.map((f) => f.path)];
  };

  const files = { files: [file("app/views/users/_form.html.erb"), file("/shared/buttons.css", true)] };
  assert.deepEqual(said(tweak("done", files)), ["Files changed", ["app/views/users/_form.html.erb", "/shared/buttons.css"], []]);
  assert.deepEqual(said(tweak("done", { ...files, unrecorded: [file("a.rb")] })), ["Files changed", ["app/views/users/_form.html.erb", "/shared/buttons.css"], ["a.rb"]]);
  assert.equal(change(tweak("done", files)).files[1].outside, true);
  // Nothing recorded: something changed anyway, or there's no repo to check.
  assert.deepEqual(said(tweak("done", { state: "nothing-recorded", unrecorded: [file("a.rb")] })), ["No edits recorded", [], ["a.rb"]]);
  assert.deepEqual(said(tweak("done", { state: "nothing-recorded", checked: false })), ["No edits recorded", [], []]);
  assert.deepEqual(said(tweak("done", { state: "nothing-recorded" })), ["No files changed", [], []]);
  // Declined after edits keeps its change; declined before any says nothing.
  assert.deepEqual(said(tweak("declined", files))[0], "Files changed");
  assert.equal(change(tweak("declined", { state: "nothing-recorded" })), null);
  // Never while Claude works or asks, nor before capture has ended once.
  assert.equal(change(tweak("working", files)), null);
  assert.equal(change(tweak("question", files)), null);
  assert.equal(change({ status: "done" }), null);
  // What a screen reader hears when the change appears.
  assert.equal(change(tweak("done", files)).announce, "2 files changed");
  assert.equal(change(tweak("done", { files: [file("a.rb")], unrecorded: [file("b.rb")] })).announce, "1 file changed, 1 not recorded");
  assert.equal(change(tweak("done", { state: "nothing-recorded" })).announce, "No files changed");
});

test("the card's chip says what a tweak points at", () => {
  const { pointedAt } = ns.describe;
  const one = { elements: [{ label: "button#save", selector: "#save" }] };
  assert.equal(pointedAt(one), "button#save");
  assert.equal(pointedAt({ elements: [...one.elements, { label: "input#name", selector: "#name" }] }), "2 elements");
  assert.equal(pointedAt({ ...one, selection: { text: "no\n framework" } }), "“no framework”");
  assert.equal(pointedAt({ ...one, selection: { text: "x".repeat(40) } }), `“${"x".repeat(23)}…”`);
  assert.equal(pointedAt({ ...one, area: { page: { x: 0, y: 0, width: 320.4, height: 179.6 } } }), "Area 320×180");
  assert.equal(pointedAt(undefined), "");
});

test("a finished change offers Undo, then says where the undo is", () => {
  const { undo, thread } = ns.describe;
  const file = (path) => ({ path, outside: false });
  const url = "https://ernie.localhost:3000/admin?tab=2";
  const tweak = (status, c) => ({ status, url, change: { state: "recorded", checked: true, files: [file("a.css")], unrecorded: [], ...c } });

  // Every edit recorded: Undo.
  assert.deepEqual({ ...undo(tweak("done")) }, { kind: "offer", label: "Undo", note: "" });
  // Some unrecorded: Undo, which says it reverts only the recorded files.
  assert.deepEqual({ ...undo(tweak("done", { unrecorded: [file("b.rb")] })) }, { kind: "offer", label: "Undo", note: "Undo reverts only the recorded files." });
  // Declined after edits: Undo too.
  assert.equal(undo(tweak("declined")).label, "Undo");
  // Nothing recorded, but something changed (or no repo to check): Ask Claude.
  assert.equal(undo(tweak("done", { state: "nothing-recorded", files: [], unrecorded: [file("b.rb")] })).label, "Ask Claude to undo");
  assert.equal(undo(tweak("done", { state: "nothing-recorded", files: [], checked: false })).label, "Ask Claude to undo");
  // Nothing changed: no Undo. Never while Claude works or asks.
  assert.equal(undo(tweak("done", { state: "nothing-recorded", files: [] })), null);
  assert.equal(undo(tweak("working")), null);
  assert.equal(undo(tweak("question")), null);
  assert.equal(undo({ status: "done", url }), null);

  // An undo with Claude: how many files conflict, or nothing recorded; with
  // no session claiming the page, the command that brings one.
  assert.deepEqual({ ...undo(tweak("done", { state: "undo-requested", files: [file("a.css"), file("b.css")], conflicts: 1 })) }, {
    kind: "asked",
    text: "Undo needs Claude: 1 of 2 files changed since",
  });
  assert.equal(undo(tweak("done", { state: "undo-requested", files: [], unrecorded: [file("b.rb")] })).text, "Undo needs Claude: no edits were recorded");
  assert.deepEqual({ ...undo(tweak("done", { state: "undo-requested", conflicts: 1, waiting: true })) }, {
    kind: "waiting",
    text: "Needs a session to resolve: run",
    command: "/tweak https://ernie.localhost:3000",
  });
  assert.deepEqual({ ...undo(tweak("done", { state: "undone" })) }, { kind: "undone", text: "Undone" });

  // Who undid it, in the conversation.
  const entries = [
    { kind: "request", from: "you" },
    { kind: "undo", from: "you", text: "Undid the change to a.css" },
    { kind: "undo", from: "claude", text: "by hand" },
  ];
  assert.deepEqual(
    thread({ entries }).map((e) => e.label),
    ["You undid it", "Claude undid it"],
  );
});

test("a withdrawn tweak's change is listed and undoable, as a finished one's", () => {
  const { change, undo } = ns.describe;
  const t = { status: "withdrawn", url: "https://e.localhost/", change: { state: "recorded", checked: true, files: [{ path: "a.css" }], unrecorded: [] } };
  assert.equal(change(t).title, "Files changed");
  assert.equal(undo(t).label, "Undo");
  // Withdrawn before anything changed: nothing to say about files.
  assert.equal(change({ ...t, change: { ...t.change, files: [] } }), null);
});

test("an open tweak's card offers Withdraw, a finished one's Resolve, and a resolved one neither", () => {
  const { finish } = ns.describe;
  for (const s of ["sent", "delivered", "queued", "working", "question"]) assert.deepEqual({ ...finish({ status: s }) }, { kind: "withdraw", label: "Withdraw" }, s);
  for (const s of ["done", "declined"]) assert.deepEqual({ ...finish({ status: s }) }, { kind: "resolve", label: "Resolve" }, s);
  assert.equal(finish({ status: "withdrawn", resolvedAt: "2026-11-26T10:00:00Z" }), null);
  assert.equal(finish({ status: "done", resolvedAt: "2026-11-26T10:00:00Z" }), null);
  assert.equal(finish(undefined), null, "a card still sending");
});

test("a resolved tweak says when it goes, with its Undo", () => {
  const { kept } = ns.describe;
  const now = Date.parse("2026-11-26T10:00:00Z");
  assert.equal(kept({ deleteAt: "2026-12-03T10:00:00Z" }, now), "Kept for 7 days");
  assert.equal(kept({ deleteAt: "2026-11-27T09:00:00Z" }, now), "Kept for 23 hours");
  assert.equal(kept({ deleteAt: "2026-11-26T10:00:40Z" }, now), "Kept for 1 minute");
  assert.equal(kept({ deleteAt: "2026-11-26T10:00:00Z" }, now), "");
});
