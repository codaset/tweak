import { test } from "node:test";
import assert from "node:assert/strict";
import { requests } from "../../extension/lib/requests.js";

test("a result reaches the request that carried its ref, once", () => {
  const r = requests();
  const got = [];
  const ref = r.add((answer) => got.push(answer));
  r.answer({ type: "result", ref, number: 4 });
  r.answer({ type: "result", ref, number: 5 });
  assert.deepEqual(got, [{ number: 4 }]);
});

test("a refused request gets the bridge's message", () => {
  const r = requests();
  let got;
  const ref = r.add((answer) => (got = answer));
  r.answer({ type: "result", ref, error: "bad-request", message: "a tweak needs a request" });
  assert.deepEqual(got, { error: "a tweak needs a request" });
});

// A tab that went away (its port disconnected) throws when answered: that
// mustn't stop the others being answered, or the socket's cleanup.
test("dropping every request answers each, even after one throws", () => {
  const r = requests();
  const got = [];
  r.add(() => {
    throw new Error("Attempting to use a disconnected port object");
  });
  r.add((answer) => got.push(answer));
  assert.doesNotThrow(() => r.dropAll("Not connected to Tweak"));
  assert.deepEqual(got, [{ error: "Not connected to Tweak" }]);
  assert.doesNotThrow(() => r.answer({ type: "result", ref: "w1", number: 1 }));
});

test("a request whose tab is gone can be forgotten", () => {
  const r = requests();
  const got = [];
  const ref = r.add((answer) => got.push(answer));
  r.forget(ref);
  r.answer({ type: "result", ref, number: 1 });
  assert.deepEqual(got, []);
});
