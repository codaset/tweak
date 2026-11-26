// Chrome for Testing with the extension's test copy, and the ways in.
import puppeteer from "puppeteer";
import { until } from "./util.js";

// Linux CI only: ubuntu-24.04's AppArmor rule on unprivileged user
// namespaces stops Chrome's own sandbox.
export const NO_SANDBOX = process.platform === "linux" && Boolean(process.env.CI);

// New headless (chrome-headless-shell doesn't load extensions), with the
// test copy loaded through Puppeteer's enableExtensions.
export function launch(extension) {
  return puppeteer.launch({
    headless: true,
    enableExtensions: [extension],
    args: NO_SANDBOX ? ["--no-sandbox"] : [],
  });
}

// Evaluates an expression in the extension's service worker, through a CDP
// session that's detached afterwards: an attached session keeps the worker
// alive, which a test of worker restarts must not have.
export async function inWorker(browser, expression) {
  const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const cdp = await target.createCDPSession();
  try {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// What the content script's world is called, and how an expression there
// reaches the content script's namespace and the overlay's shadow root.
export const CONTENT_WORLD = "Codaset Tweak";
export const NAMESPACE = "globalThis.codasetTweak";
export const OVERLAY_ROOT = "ns?.overlay?.root";

// The content script's isolated world in a page, over CDP. The overlay sits
// in a closed shadow root, so the page can't see in; this world can.
// Expressions see `ns` (NAMESPACE) and `root` (OVERLAY_ROOT).
export async function contentScript(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Page.enable");
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const mainFrame = frameTree.frame.id;
  // Only the content script's world in the main frame's current document.
  // A navigation forgets it at once, so a call made after one never reaches
  // the old document's world: it waits for the new one.
  let current = null;
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    const { type, frameId } = context.auxData ?? {};
    if (type === "isolated" && frameId === mainFrame && context.name === CONTENT_WORLD) current = context.id;
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    if (executionContextId === current) current = null;
  });
  cdp.on("Runtime.executionContextsCleared", () => (current = null));
  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame.id === mainFrame) current = null;
  });
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) current = null;
  });
  await cdp.send("Runtime.enable");

  const evaluate = async (expression) => {
    if (!current) throw new Error("the content script isn't running in this page");
    const r = await cdp.send("Runtime.evaluate", {
      contextId: current,
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => { const ns = ${NAMESPACE}; const root = ${OVERLAY_ROOT}; return (${expression}); })()`,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  return {
    evaluate,
    // Polls an expression until it's truthy, or until opts.is accepts it.
    until: (expression, opts) => until(() => evaluate(expression), { what: expression, ...opts }),
    // The test copy's test-only message: calls a worker handler the
    // shortcuts or the toolbar's context menu call, with this tab. It's sent
    // from a real click in the page's top-left corner, so it carries a user
    // gesture as theirs do (sidePanel.open needs one, and CDP's userGesture
    // flag doesn't reach the worker as one). The page doesn't hear the click.
    async handler(name) {
      await evaluate(`(() => {
        const send = (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
          removeEventListener("click", send, true);
          globalThis.e2eReply = chrome.runtime.sendMessage({ type: "e2e:handler", name: ${JSON.stringify(name)} });
        };
        addEventListener("click", send, true);
      })()`);
      await page.mouse.click(1, 1);
      const reply = await evaluate(`globalThis.e2eReply`);
      if (!reply?.ok) throw new Error(`handler ${name} failed: ${reply?.error ?? "no reply"}`);
    },
  };
}
