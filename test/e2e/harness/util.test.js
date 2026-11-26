// The harness's shared waiting and process helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { alive, sleep, until } from "./util.js";

test("until resolves with the first truthy value", async () => {
  let n = 0;
  assert.equal(await until(() => (++n >= 3 ? `after ${n}` : 0), { every: 1 }), "after 3");
});

test("a wait that times out says what it was waiting for and what it last saw", async () => {
  await assert.rejects(until(() => "" , { timeout: 50, every: 5, what: "the card to show Done" }), {
    message: 'timed out after 0.05 s waiting for the card to show Done; last value: ""',
  });
  // With `is`, the value polled is what's reported, not just "false".
  await assert.rejects(until(() => "Sending…", { timeout: 50, every: 5, is: (s) => s === "Change saved", what: "Done" }), {
    message: 'timed out after 0.05 s waiting for Done; last value: "Sending…"',
  });
  assert.equal(await until(() => "Change saved", { is: (s) => s === "Change saved" }), "Change saved");
  await assert.rejects(
    until(
      () => {
        throw new Error("the content script isn't running in this page");
      },
      { timeout: 50, every: 5 },
    ),
    { message: "timed out after 0.05 s waiting for a condition; last error: the content script isn't running in this page" },
  );
});

test("alive tells a running process from one that has exited", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"]);
  await new Promise((r) => child.once("spawn", r));
  assert.equal(alive(child.pid), true);
  await new Promise((r) => child.once("exit", r));
  await sleep(10);
  assert.equal(alive(child.pid), false);
});
