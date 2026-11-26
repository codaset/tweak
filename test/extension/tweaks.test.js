import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTweaks, forPage, forTab, pageOf, reachesTab } from "../../extension/lib/tweaks.js";
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
