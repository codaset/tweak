// The worker's connection logic: retry backoff, applying bridge messages, and
// the badge before site access (docs/design.md, "Staying connected").
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../../extension/lib/backoff.js";
import { ago, apply, coverOf, heldBy, registered } from "../../extension/lib/claims.js";
import { badge, GREY } from "../../extension/lib/badge.js";

test("retries back off 1, 2, 5 seconds, then every 10", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 50].map(retryDelay), [1000, 2000, 5000, 10000, 10000, 10000]);
});

const claim = (id, pattern) => ({ id, pattern, session: { id: "s" }, created: "2026-11-25T10:00:00.000Z" });
// What registration reads: each held claim's ID and pattern.
const patterns = (state) => ({ seq: state.seq, claims: state.claims.map(({ id, pattern }) => ({ id, pattern })) });

test("a snapshot replaces the claims", () => {
  const state = apply({ seq: 9, claims: [{ id: 1, pattern: "https://old.localhost/*" }] }, { type: "snapshot", seq: 3, version: "1.0.0", claims: [claim(2, "https://a.localhost/*")] });
  assert.deepEqual(patterns(state), { seq: 3, claims: [{ id: 2, pattern: "https://a.localhost/*" }] });
});

test("claim events after the snapshot add and remove claims", () => {
  let state = { seq: 3, claims: [{ id: 2, pattern: "https://a.localhost/*" }] };
  state = apply(state, { type: "event", seq: 4, event: "claim-made", claim: claim(3, "https://b.localhost/*") });
  state = apply(state, { type: "event", seq: 5, event: "claim-released", claim: claim(2, "https://a.localhost/*") });
  assert.deepEqual(patterns(state), { seq: 5, claims: [{ id: 3, pattern: "https://b.localhost/*" }] });
});

test("a lapsed claim leaves the claims, and comes back when restored", () => {
  let state = { seq: 3, claims: [{ id: 2, pattern: "https://a.localhost/*" }] };
  state = apply(state, { type: "event", seq: 4, event: "claim-lapsed", claim: claim(2, "https://a.localhost/*") });
  assert.deepEqual(patterns(state), { seq: 4, claims: [] });
  state = apply(state, { type: "event", seq: 5, event: "claim-restored", claim: claim(4, "https://a.localhost/*") });
  assert.deepEqual(patterns(state), { seq: 5, claims: [{ id: 4, pattern: "https://a.localhost/*" }] });
});

test("an event already seen is ignored", () => {
  const state = { seq: 5, claims: [] };
  assert.equal(apply(state, { type: "event", seq: 5, event: "claim-made", claim: claim(3, "https://b.localhost/*") }), state);
});

test("a claim made again under a reused ID replaces the old one", () => {
  const state = apply({ seq: 1, claims: [{ id: 1, pattern: "https://a.localhost/*" }] }, { type: "event", seq: 2, event: "claim-made", claim: claim(1, "https://b.localhost/*") });
  assert.deepEqual(patterns(state).claims, [{ id: 1, pattern: "https://b.localhost/*" }]);
});

test("other messages leave the claims as they are", () => {
  const state = { seq: 5, claims: [] };
  assert.equal(apply(state, { type: "refusal", error: "protocol", message: "x" }), state);
});

test("until site access is granted, a grey ! shows; once granted, nothing", () => {
  assert.deepEqual(badge({ granted: false, connection: "connected" }), { text: "!", color: GREY });
  assert.deepEqual(badge({ granted: true, connection: "connected" }), { text: "", color: GREY });
});

test("while the bridge is down, the grey ! shows; while a first try is under way, the badge is left as it was", () => {
  assert.deepEqual(badge({ granted: true, connection: "disconnected" }), { text: "!", color: GREY });
  assert.deepEqual(badge({ granted: true, connection: "refused" }), { text: "!", color: GREY });
  // A worker start: the badge Chrome kept says what was last known.
  assert.equal(badge({ granted: true, connection: "connecting" }), null);
  assert.deepEqual(badge({ granted: false, connection: "connecting" }), { text: "!", color: GREY });
});

// docs/design.md § When the session goes quiet: what the card and the side
// panel need about a claim's session.
const held = (id, pattern, listening, folder = "~/dev/ernie") => ({
  id,
  pattern,
  session: { id: "s", agent: "claude-code", folder, label: "", lastCheckIn: "2026-11-25T10:00:00.000Z" },
  created: "2026-11-25T10:00:00.000Z",
  ...(listening === undefined ? {} : { listening }),
});
const lapsedClaim = (id, pattern, lapsedAt = "2026-11-25T10:10:00.000Z") => {
  const { listening, ...c } = held(id, pattern);
  return { ...c, lapsedAt };
};

test("a held claim keeps its session's folder and whether it's listening", () => {
  const state = apply(undefined, { type: "snapshot", seq: 3, claims: [held(1, "https://a.localhost/*", false)], tweaks: [] });
  assert.deepEqual(state.claims, [{ id: 1, pattern: "https://a.localhost/*", session: "s", folder: "~/dev/ernie", listening: false }]);
  const back = apply(state, { type: "event", seq: 4, event: "claim-listening", claim: held(1, "https://a.localhost/*", true) });
  assert.equal(back.claims[0].listening, true);
});

test("a claim that doesn't say counts as listening", () => {
  const state = apply(undefined, { type: "snapshot", seq: 3, claims: [held(1, "https://a.localhost/*")], tweaks: [] });
  assert.equal(state.claims[0].listening, true);
});

test("the snapshot's lapsed claims are kept, apart from the held ones", () => {
  const state = apply(undefined, { type: "snapshot", seq: 3, claims: [], lapsed: [lapsedClaim(4, "https://a.localhost/*")], tweaks: [] });
  assert.deepEqual(state.claims, []);
  assert.deepEqual(state.lapsed, [{ pattern: "https://a.localhost/*", session: "s", folder: "~/dev/ernie", lapsedAt: "2026-11-25T10:10:00.000Z" }]);
});

test("a lapse moves the claim to the lapsed ones, and a restore moves it back", () => {
  let state = apply(undefined, { type: "snapshot", seq: 3, claims: [held(2, "https://a.localhost/*", false)], tweaks: [] });
  state = apply(state, { type: "event", seq: 4, event: "claim-lapsed", claim: lapsedClaim(2, "https://a.localhost/*") });
  assert.deepEqual(state.claims, []);
  assert.equal(state.lapsed.length, 1);
  assert.equal(state.lapsed[0].lapsedAt, "2026-11-25T10:10:00.000Z");
  // Restored under a new ID: the lapsed one is known by its session and pattern.
  state = apply(state, { type: "event", seq: 5, event: "claim-restored", claim: held(7, "https://a.localhost/*", true) });
  assert.deepEqual(state.lapsed, []);
  assert.deepEqual(state.claims.map((c) => c.id), [7]);
});

test("a lapsed claim whose session ended is forgotten", () => {
  let state = apply(undefined, { type: "snapshot", seq: 3, claims: [held(4, "http://localhost/*", true)], lapsed: [lapsedClaim(4, "https://a.localhost/*")], tweaks: [] });
  state = apply(state, { type: "event", seq: 4, event: "claim-forgotten", claim: lapsedClaim(4, "https://a.localhost/*") });
  assert.deepEqual(state.lapsed, []);
  assert.deepEqual(state.claims.map((c) => c.id), [4], "a held claim with the same ID stays");
});

test("a page a lapsed claim covers is lapsed, not claimed, for 24 hours from the lapse", () => {
  const state = apply(undefined, {
    type: "snapshot",
    seq: 3,
    claims: [held(1, "http://localhost/*", true)],
    lapsed: [lapsedClaim(4, "https://ernie.localhost/*", "2026-11-25T10:10:00.000Z")],
    tweaks: [],
  });
  const now = Date.parse("2026-11-25T10:13:00.000Z");
  assert.equal(coverOf(state, "http://localhost/a", now).kind, "claimed");
  assert.deepEqual(coverOf(state, "https://ernie.localhost/admin?x=1", now), {
    kind: "lapsed",
    folder: "~/dev/ernie",
    pattern: "https://ernie.localhost/*",
    lapsedAt: "2026-11-25T10:10:00.000Z",
  });
  assert.equal(coverOf(state, "https://ernie.localhost/admin", Date.parse("2026-11-26T10:09:59.000Z")).kind, "lapsed");
  assert.equal(coverOf(state, "https://ernie.localhost/admin", Date.parse("2026-11-26T10:10:00.000Z")).kind, "none");
  assert.equal(coverOf(state, "https://bert.localhost/", now).kind, "none");
});

test("a lapsed claim's pages keep their scripts, under an ID of their own, until it can't come back", () => {
  const state = apply(undefined, {
    type: "snapshot",
    seq: 3,
    claims: [held(4, "http://localhost/*", true)],
    lapsed: [lapsedClaim(4, "https://ernie.localhost/*", "2026-11-25T10:10:00.000Z")],
    tweaks: [],
  });
  const now = Date.parse("2026-11-25T10:13:00.000Z");
  const list = registered(state, now);
  assert.deepEqual(list.map((c) => c.pattern), ["http://localhost/*", "https://ernie.localhost/*"]);
  assert.equal(new Set(list.map((c) => c.id)).size, 2, "a lapsed row's ID can be a held claim's");
  assert.deepEqual(registered(state, now)[1].id, list[1].id, "the same each time");
  assert.deepEqual(registered(state, Date.parse("2026-11-26T10:10:00.000Z")).map((c) => c.pattern), ["http://localhost/*"]);
});

test("the side panel says how long ago a session stopped responding", () => {
  const lapsed = "2026-11-25T10:10:00.000Z";
  const after = (ms) => ago(lapsed, Date.parse(lapsed) + ms);
  assert.equal(after(20_000), "just now");
  assert.equal(after(60_000), "1 min ago");
  assert.equal(after(3 * 60_000 + 59_000), "3 min ago");
  assert.equal(after(2 * 3600_000 + 5 * 60_000), "2 h ago");
  assert.equal(after(-5_000), "just now");
});

test("a tweak learns whether the session holding its page is listening, from its own URL", () => {
  const state = apply(undefined, { type: "snapshot", seq: 3, claims: [held(1, "http://localhost/admin/*", false)], tweaks: [] });
  assert.deepEqual(heldBy(state, { url: "http://localhost/admin/users?tab=2" }), { folder: "~/dev/ernie", listening: false });
  assert.equal(heldBy(state, { url: "http://localhost/other" }), null);
});

test("a lapsed claim another session has claimed over is lost, and leaves the lapsed ones", () => {
  let state = apply(undefined, { type: "snapshot", seq: 3, claims: [], lapsed: [lapsedClaim(4, "https://a.localhost/*")], tweaks: [] });
  state = apply(state, { type: "event", seq: 4, event: "claim-made", claim: { ...held(9, "https://a.localhost/*", true), session: { ...held(9, "x").session, id: "other" } } });
  state = apply(state, { type: "event", seq: 5, event: "claim-lost", claim: lapsedClaim(4, "https://a.localhost/*") });
  assert.deepEqual(state.lapsed, []);
  assert.deepEqual(state.claims.map((c) => c.id), [9]);
});
