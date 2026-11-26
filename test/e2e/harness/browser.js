// Chrome for Testing with the extension's test copy, and the ways in.
import puppeteer from "puppeteer";
import { sleep } from "./fixture.js";

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

// Polls fn until it returns something truthy, or returns its last value
// after timeout. Errors count as not yet.
export async function until(fn, { timeout = 10_000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => false);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

// The content script's isolated world in a page, over CDP. The overlay sits
// in a closed shadow root, so the page can't see in; this world can, through
// globalThis.codasetTweak.overlay.root. Expressions see `ns` and `root`.
export async function contentScript(page) {
  const cdp = await page.createCDPSession();
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.type === "isolated" && context.name === "Codaset Tweak" && context.auxData.isDefault === false) contexts.push(context.id);
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    const i = contexts.indexOf(executionContextId);
    if (i >= 0) contexts.splice(i, 1);
  });
  cdp.on("Runtime.executionContextsCleared", () => (contexts.length = 0));
  await cdp.send("Runtime.enable");

  const evaluate = async (expression, { userGesture = false } = {}) => {
    const contextId = contexts.at(-1);
    if (!contextId) throw new Error("the content script isn't running in this page");
    const r = await cdp.send("Runtime.evaluate", {
      contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
      expression: `(async () => { const ns = globalThis.codasetTweak; const root = ns?.overlay?.root; return (${expression}); })()`,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  return {
    evaluate,
    // Polls an expression until it's truthy.
    until: (expression, opts) => until(() => evaluate(expression), opts),
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
