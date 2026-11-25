// Comparing content-script registrations with claims (docs/design.md,
// "Claims and registration").
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, registrationsFor } from "../../extension/lib/registrations.js";

const claim = (id, pattern) => ({ id, pattern });
const ids = (registrations) => registrations.map((r) => r.id).sort();

test("a claim registers the page probe in the page's world and the content script, top frame only, at document_start", () => {
  const [script, probe] = registrationsFor(claim(7, "https://app.localhost/*"));
  assert.equal(script.id, "claim-7");
  assert.equal(probe.id, "claim-7-probe");
  for (const r of [script, probe]) {
    assert.deepEqual(r.matches, ["https://app.localhost/*"]);
    assert.equal(r.runAt, "document_start");
    assert.equal(r.allFrames, false);
  }
  assert.equal(script.world, "ISOLATED");
  assert.equal(probe.world, "MAIN");
  assert.deepEqual(probe.js, ["content/probe.js"]);
  assert.equal(script.js[0], "content/namespace.js");
});

test("with nothing registered, every claim is registered and counts as added", () => {
  const p = plan([], [claim(1, "https://a.localhost/*"), claim(2, "http://localhost:3000/*")]);
  assert.deepEqual(ids(p.register), ["claim-1", "claim-1-probe", "claim-2", "claim-2-probe"]);
  assert.deepEqual(p.unregister, []);
  assert.deepEqual(p.added.map((c) => c.id), [1, 2]);
});

test("registrations already matching their claims are left alone", () => {
  const claims = [claim(1, "https://a.localhost/*")];
  const p = plan(registrationsFor(claims[0]), claims);
  assert.deepEqual(p, { register: [], unregister: [], added: [] });
});

test("a released claim's registrations are removed", () => {
  const p = plan([...registrationsFor(claim(1, "https://a.localhost/*")), ...registrationsFor(claim(2, "https://b.localhost/*"))], [claim(2, "https://b.localhost/*")]);
  assert.deepEqual(p.unregister.sort(), ["claim-1", "claim-1-probe"]);
  assert.deepEqual(p.register, []);
});

test("a claim ID reused for another pattern is re-registered", () => {
  const p = plan(registrationsFor(claim(1, "https://a.localhost/*")), [claim(1, "https://b.localhost/*")]);
  assert.deepEqual(p.unregister.sort(), ["claim-1", "claim-1-probe"]);
  assert.deepEqual(ids(p.register), ["claim-1", "claim-1-probe"]);
  assert.deepEqual(p.register[0].matches, ["https://b.localhost/*"]);
  assert.deepEqual(p.added, [claim(1, "https://b.localhost/*")]);
});

test("a half-registered claim is repaired", () => {
  const [script] = registrationsFor(claim(1, "https://a.localhost/*"));
  const p = plan([script], [claim(1, "https://a.localhost/*")]);
  assert.deepEqual(ids(p.register), ["claim-1-probe"]);
  assert.deepEqual(p.added.map((c) => c.id), [1]);
});

test("registrations that aren't claims' are not touched", () => {
  const p = plan([{ id: "something-else", matches: ["https://x/*"], js: ["x.js"] }], []);
  assert.deepEqual(p.unregister, []);
});
