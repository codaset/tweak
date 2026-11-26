// The extension's test copy, without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION, testCopy } from "./extension.js";

const read = (dir, f) => readFileSync(join(dir, f), "utf8");

test("the copy talks to the test bridge's port, pre-grants localhost and hears the test message", () => {
  const dir = testCopy({ bridgePort: 50123 });
  assert.match(read(dir, "lib/bridge.js"), /DEFAULT_PORT = 50123;/);
  assert.match(read(dir, "panel/panel.html"), /placeholder="50123"/);
  const manifest = JSON.parse(read(dir, "manifest.json"));
  assert.deepEqual(manifest.host_permissions, ["http://localhost/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], "127.0.0.1 stays ungranted, for the activeTab path");
  assert.match(read(dir, "worker.js"), /"e2e:handler"/);
  assert.doesNotMatch(read(EXTENSION, "worker.js"), /e2e:handler/, "the real extension is untouched");
});

test("a copy that would still name the live port is refused", () => {
  const source = mkdtempSync(join(tmpdir(), "tweak-ext-src-"));
  cpSync(EXTENSION, source, { recursive: true });
  writeFileSync(join(source, "lib/extra.js"), "export const PORT = 47391;\n");
  assert.throws(() => testCopy({ bridgePort: 50123, source }), /lib\/extra.js still names port 47391/);
  assert.throws(() => testCopy({ bridgePort: 47391 }), /refusing the live bridge's port/);
});

test("a worker without the handlers the test message calls is refused", () => {
  const source = mkdtempSync(join(tmpdir(), "tweak-ext-src-"));
  cpSync(EXTENSION, source, { recursive: true });
  writeFileSync(join(source, "worker.js"), read(source, "worker.js").replaceAll("openSidePanel", "openPanel"));
  assert.throws(() => testCopy({ bridgePort: 50123, source }), /worker.js has no openSidePanel/);
});
