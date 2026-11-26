// Helpers the static fixture's test files share (static*.test.js).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inWorker } from "./harness/browser.js";
import { CARD, COMPOSER_INPUT, pick, until } from "./harness/index.js";

// Is the overlay what a click on selector's middle would hit?
export const hit = (selector) => `(() => {
  const r = root.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
  return Boolean(r?.width) && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === ns.overlay.host;
})()`;
// Not null === null: the composer opens once the pick's capture is taken.
export const composing = `Boolean(root.activeElement) && root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`;
export const noCard = `!root.querySelector(${JSON.stringify(CARD)})`;

export const text = (selector) => `root.querySelector(${JSON.stringify(selector)})?.textContent`;

// Screenshots (design.md § Screenshot). A tweak sent from the page, and the
// PNG the bridge stored for it: its signature and its IHDR size. It returns
// the number, and the brief the stand-in fetched at once.
export async function sendTweak(env, target, request) {
  await pick(env, target);
  await env.tab.until(`root.activeElement === root.querySelector(${JSON.stringify(COMPOSER_INPUT)})`, { what: "the composer to open with the focus" });
  await env.page.keyboard.type(request);
  const from = env.watcher.lines.length;
  await env.page.keyboard.press("Enter");
  const { number, brief } = await env.claude.nextTweak(env.watcher, { from });
  await env.tab.until(`ns.panel.showing()`, { is: (s) => s === number, what: `the card of tweak ${number}` });
  return { n: number, brief };
}

export async function storedScreenshot(env, n) {
  const file = join(env.bridge.state, "screenshots", `${n}.png`);
  await until(() => existsSync(file), { what: `tweak ${n}'s screenshot to be stored` });
  const png = readFileSync(file);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG signature");
  assert.equal(png.subarray(12, 16).toString(), "IHDR");
  return { file, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// The box design.md crops to, in device pixels: the element plus 48 CSS px,
// clipped to the viewport (which the side panel, once open, narrows). Taken
// before the pick, as the page then is.
export async function expectedCrop(env, selector) {
  const { r, vw, vh, dpr } = await env.page.$eval(selector, (el) => ({
    r: el.getBoundingClientRect().toJSON(),
    vw: innerWidth,
    vh: innerHeight,
    dpr: devicePixelRatio,
  }));
  const left = Math.max(0, r.left - 48);
  const top = Math.max(0, r.top - 48);
  const right = Math.min(vw, r.right + 48);
  const bottom = Math.min(vh, r.bottom + 48);
  return { width: Math.ceil(right * dpr) - Math.floor(left * dpr), height: Math.ceil(bottom * dpr) - Math.floor(top * dpr) };
}

// The toolbar button, the shortcuts and the side panel (design.md § Toolbar
// button, § Pins, § Side panel). Real shortcuts can't be pressed headlessly,
// so the tests call their handlers through the test copy's message.
export const panelTarget = (env) => env.browser.targets().find((t) => t.url().endsWith("/panel/panel.html"));
export const closeSidePanel = (env) => inWorker(env.browser, `chrome.windows.getLastFocused().then((w) => chrome.sidePanel.close({ windowId: w.id }))`);
export async function panelPage(env) {
  const target = await until(() => panelTarget(env), { what: "the side panel to open" });
  return target.asPage();
}
