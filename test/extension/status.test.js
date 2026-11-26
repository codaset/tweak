// The connection status the side panel shows, and when a refusal's text
// stops applying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStatus } from "../../extension/lib/status.js";

const refused = { connection: "refused", message: "This extension speaks protocol 2; the bridge speaks 1. Reload the extension." };

test("a connection goes connecting, connected, then disconnected when it closes", () => {
  let s = { connection: "disconnected", message: "" };
  s = nextStatus(s, { type: "connecting" });
  assert.deepEqual(s, { connection: "connecting", message: "" });
  s = nextStatus(s, { type: "connected" });
  assert.deepEqual(s, { connection: "connected", message: "" });
  assert.deepEqual(nextStatus(s, { type: "closed", refused: false }), { connection: "disconnected", message: "" });
});

test("a refusal shows its message, and stays through its own close and the alarm's next try", () => {
  let s = nextStatus({ connection: "connecting", message: "" }, { type: "refused", message: refused.message });
  assert.deepEqual(s, refused);
  s = nextStatus(s, { type: "closed", refused: true });
  assert.deepEqual(s, refused);
  assert.deepEqual(nextStatus(s, { type: "connecting" }), refused);
});

test("a new port clears the refusal: connecting shows no old text", () => {
  assert.deepEqual(nextStatus(refused, { type: "reconnect" }), { connection: "connecting", message: "" });
});

test("a later try that fails without a refusal shows disconnected, not the old refusal", () => {
  assert.deepEqual(nextStatus(refused, { type: "closed", refused: false }), { connection: "disconnected", message: "" });
});

test("a later try that's accepted clears the refusal", () => {
  assert.deepEqual(nextStatus(refused, { type: "connected" }), { connection: "connected", message: "" });
});
