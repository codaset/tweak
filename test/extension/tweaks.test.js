import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTweaks, askedIn, askedSince, forPage, forTab, pageOf, reachesTab, resolvedList } from "../../extension/lib/tweaks.js";
import { apply } from "../../extension/lib/claims.js";

const tweak = (number, page, status = "sent") => ({ number, page, url: page, status });

test("a page is its origin and path, without the query or hash", () => {
  assert.equal(pageOf("https://Ernie.localhost:3000/admin?tab=2#top"), "https://ernie.localhost:3000/admin");
  assert.equal(pageOf("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(pageOf("not a url"), "");
});

test("tweaks are rebuilt from the snapshot and moved on by tweak events", () => {
  let s = applyTweaks(undefined, { type: "snapshot", seq: 4, claims: [], tweaks: [tweak(1, "https://a.localhost/")] });
  assert.deepEqual([...s.tweaks.keys()], [1]);
  s = applyTweaks(s, { type: "event", seq: 5, event: "tweak-created", tweak: tweak(2, "https://a.localhost/x") });
  s = applyTweaks(s, { type: "event", seq: 6, event: "tweak-status", tweak: tweak(1, "https://a.localhost/", "working") });
  assert.equal(s.tweaks.get(1).status, "working");
  assert.equal(s.seq, 6);
  assert.deepEqual(forPage(s, "https://a.localhost/").map((t) => t.number), [1]);
});

test("an event already seen, or not about tweaks, changes nothing", () => {
  const s = applyTweaks(undefined, { type: "snapshot", seq: 6, claims: [], tweaks: [tweak(1, "p", "done")] });
  assert.equal(applyTweaks(s, { type: "event", seq: 6, event: "tweak-status", tweak: tweak(1, "p", "working") }), s);
  assert.equal(applyTweaks(s, { type: "event", seq: 7, event: "claim-made", claim: {} }), s);
  assert.equal(applyTweaks(s, { type: "result", ref: "r", number: 3 }), s);
});

test("a tweak event leaves the claims as they were", () => {
  const claims = apply({ seq: 0, claims: [] }, { type: "snapshot", seq: 1, claims: [{ id: 1, pattern: "https://a.localhost/*" }] });
  assert.equal(apply(claims, { type: "event", seq: 2, event: "tweak-created", tweak: tweak(1, "p") }), claims);
});

// The card stays open as the tab navigates, so the tab keeps hearing about
// its tweak wherever that tweak's page is.
test("a tab gets its page's tweaks and its open card's", () => {
  const s = applyTweaks(undefined, {
    type: "snapshot",
    seq: 1,
    claims: [],
    tweaks: [tweak(1, "https://a.localhost/"), tweak(2, "https://a.localhost/x"), tweak(3, "https://a.localhost/y")],
  });
  assert.deepEqual(forTab(s, { page: "https://a.localhost/x", card: 1 }).map((t) => t.number), [1, 2]);
  assert.deepEqual(forTab(s, { page: "https://a.localhost/x", card: 2 }).map((t) => t.number), [2]);
  assert.deepEqual(forTab(s, { page: "https://a.localhost/x", card: null }).map((t) => t.number), [2]);
  assert.deepEqual(forTab(s, { page: "https://a.localhost/x", card: 9 }).map((t) => t.number), [2]);
});

test("a tweak's changes reach the tabs showing its page or its card", () => {
  const t = tweak(1, "https://a.localhost/");
  assert.equal(reachesTab(t, { page: "https://a.localhost/", card: null }), true);
  assert.equal(reachesTab(t, { page: "https://a.localhost/x", card: 1 }), true);
  assert.equal(reachesTab(t, { page: "https://a.localhost/x", card: 2 }), false);
});

// Pages and tabs: a question pops up only in the tab the tweak was sent
// from, or as a toast in the others if that tab is gone.
test("a new question opens only in the tab the tweak was sent from, wherever that tab is", () => {
  const a = { tabId: 1, page: "p" };
  const b = { tabId: 2, page: "p" };
  const moved = { tabId: 3, page: "q" };
  const tabs = [a, b, moved];
  const was = tweak(7, "p", "working");
  const asked = tweak(7, "p", "question");
  assert.deepEqual(askedIn(was, asked, tabs, 1), { open: [a], toast: [] });
  assert.deepEqual(askedIn(was, asked, tabs, 3), { open: [moved], toast: [] });
});

test("with the sending tab gone, a new question is a toast in every tab showing its page", () => {
  const a = { tabId: 1, page: "p" };
  const b = { tabId: 2, page: "p" };
  const other = { tabId: 3, page: "q" };
  const asked = tweak(7, "p", "question");
  assert.deepEqual(askedIn(tweak(7, "p", "working"), asked, [a, b, other], 9), { open: [], toast: [a, b] });
  assert.deepEqual(askedIn(tweak(7, "p", "working"), asked, [a, b, other], undefined), { open: [], toast: [a, b] });
});

test("a snapshot after downtime asks about each tweak that has become a question meanwhile, in its own tab", () => {
  const a = { tabId: 1, page: "p" };
  const b = { tabId: 2, page: "p" };
  const was = applyTweaks(undefined, { type: "snapshot", seq: 3, tweaks: [tweak(1, "p", "working"), tweak(2, "p", "question"), tweak(3, "p")] });
  const next = applyTweaks(was, { type: "snapshot", seq: 9, tweaks: [tweak(1, "p", "question"), tweak(2, "p", "question"), tweak(3, "p", "done"), tweak(4, "p", "question")] });
  const senders = new Map([
    [1, 2],
    [2, 1],
  ]);
  // 1 has just become a question; 2 already was one; 4 is new, and its sending tab unknown.
  assert.deepEqual(askedSince(was, next, [a, b], senders), [
    { tweak: next.tweaks.get(1), open: [b], toast: [] },
    { tweak: next.tweaks.get(4), open: [], toast: [a, b] },
  ]);
});

test("only a change into question asks", () => {
  const tabs = [{ tabId: 1, page: "p" }];
  const none = { open: [], toast: [] };
  assert.deepEqual(askedIn(tweak(7, "p", "question"), tweak(7, "p", "question"), tabs, 1), none);
  assert.deepEqual(askedIn(tweak(7, "p", "working"), tweak(7, "p", "done"), tabs, 1), none);
});

// Resolved and withdrawn tweaks leave the page's pins for the side panel's
// list, which later events (an undo) keep up to date; one goes from the list
// at its deleteAt.
test("a resolved tweak moves from the open tweaks to the resolved ones", () => {
  const resolved = (t, at = "2026-11-26T10:00:00.000Z", gone = "2026-12-03T10:00:00.000Z") => ({ ...t, resolvedAt: at, deleteAt: gone });
  let s = applyTweaks(undefined, {
    type: "snapshot",
    seq: 4,
    tweaks: [tweak(1, "https://a.localhost/", "done")],
    resolved: [resolved(tweak(2, "https://a.localhost/", "withdrawn"))],
  });
  assert.deepEqual([...s.tweaks.keys()], [1]);
  assert.deepEqual(resolvedList(s).map((t) => t.number), [2]);
  const later = resolved(tweak(1, "https://a.localhost/", "done"), "2026-11-26T11:00:00.000Z", "2026-12-03T11:00:00.000Z");
  s = applyTweaks(s, { type: "event", seq: 5, event: "tweak-resolved", tweak: later });
  assert.deepEqual([...s.tweaks.keys()], []);
  assert.deepEqual(forTab(s, { page: "https://a.localhost/", card: 1 }), [], "a tab gets no resolved tweak");
  assert.deepEqual(resolvedList(s).map((t) => t.number), [1, 2], "newest resolved first");
  const undone = { ...resolved(tweak(2, "https://a.localhost/", "withdrawn")), change: { state: "undone" } };
  s = applyTweaks(s, { type: "event", seq: 6, event: "tweak-undone", tweak: undone });
  assert.equal(resolvedList(s).find((t) => t.number === 2).change.state, "undone");
  assert.deepEqual(resolvedList(s, Date.parse("2026-12-03T10:00:00.000Z")).map((t) => t.number), [1], "gone at its deleteAt");
  // A snapshot without the list (an older bridge) has none.
  assert.deepEqual(resolvedList(applyTweaks(s, { type: "snapshot", seq: 7, tweaks: [] })), []);
});
