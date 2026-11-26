// The worker's connection logic: retry backoff, applying bridge messages, and
// the badge before site access (docs/design.md, "Staying connected").
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../../extension/lib/backoff.js";
import { apply } from "../../extension/lib/claims.js";
import { badge, GREY } from "../../extension/lib/badge.js";

test("retries back off 1, 2, 5 seconds, then every 10", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 50].map(retryDelay), [1000, 2000, 5000, 10000, 10000, 10000]);
});

const claim = (id, pattern) => ({ id, pattern, session: { id: "s" }, created: "2026-11-25T10:00:00.000Z" });

test("a snapshot replaces the claims", () => {
  const state = apply({ seq: 9, claims: [{ id: 1, pattern: "https://old.localhost/*" }] }, { type: "snapshot", seq: 3, version: "1.0.0", claims: [claim(2, "https://a.localhost/*")] });
  assert.deepEqual(state, { seq: 3, claims: [{ id: 2, pattern: "https://a.localhost/*" }] });
});

test("claim events after the snapshot add and remove claims", () => {
  let state = { seq: 3, claims: [{ id: 2, pattern: "https://a.localhost/*" }] };
  state = apply(state, { type: "event", seq: 4, event: "claim-made", claim: claim(3, "https://b.localhost/*") });
  state = apply(state, { type: "event", seq: 5, event: "claim-released", claim: claim(2, "https://a.localhost/*") });
  assert.deepEqual(state, { seq: 5, claims: [{ id: 3, pattern: "https://b.localhost/*" }] });
});

test("an event already seen is ignored", () => {
  const state = { seq: 5, claims: [] };
  assert.equal(apply(state, { type: "event", seq: 5, event: "claim-made", claim: claim(3, "https://b.localhost/*") }), state);
});

test("a claim made again under a reused ID replaces the old one", () => {
  const state = apply({ seq: 1, claims: [{ id: 1, pattern: "https://a.localhost/*" }] }, { type: "event", seq: 2, event: "claim-made", claim: claim(1, "https://b.localhost/*") });
  assert.deepEqual(state.claims, [{ id: 1, pattern: "https://b.localhost/*" }]);
});

test("other messages leave the claims as they are", () => {
  const state = { seq: 5, claims: [] };
  assert.equal(apply(state, { type: "refusal", error: "protocol", message: "x" }), state);
});

test("until site access is granted, a grey ! shows; once granted, nothing", () => {
  assert.deepEqual(badge({ granted: false }), { text: "!", color: GREY });
  assert.deepEqual(badge({ granted: true }), { text: "", color: GREY });
});
