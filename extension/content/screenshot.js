// The tab's half of the screenshot (docs/design.md, "Screenshot"). At pick
// time, before the composer opens, ns.screenshot.take() hides the overlay
// host, waits two animation frames so the page paints without it, and asks
// the worker to capture the tab. The worker holds the capture until Send
// (the create carries its id and the composer's rects) or drop(id), on
// cancel. A capture that fails or takes too long is no screenshot: the pick
// goes on, and the brief says so.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // Long enough for a capture queued behind another (two a second), short
  // enough that a stuck one never holds the composer back for long.
  const TIMEOUT = 1500;

  let n = 0;
  const waiting = new Map(); // id → resolve, until the worker answers

  // Two frames: the first runs before the paint that drops the host, the
  // second after it. A hidden tab runs no frames, so the timer ends it too.
  const painted = () =>
    new Promise((done) => {
      const timer = setTimeout(done, 200);
      requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(timer), done())));
    });

  // conceal hides the host while any capture is under way. A style, not
  // hidePopover(), so the focus and the layering are left alone.
  let hiding = 0;
  function conceal(on) {
    hiding = Math.max(0, hiding + (on ? 1 : -1));
    const host = ns.overlay.host;
    if (!host) return;
    if (hiding) host.style.setProperty("visibility", "hidden", "important");
    else host.style.removeProperty("visibility");
  }

  const answer = (id, ok) => {
    const done = waiting.get(id);
    waiting.delete(id);
    done?.(ok);
  };

  ns.screenshot = {
    // take captures the tab without the overlay, resolving with the
    // capture's id, or null when there's none.
    async take() {
      if (ns.worker.connection !== "connected") return null;
      const id = `s${++n}`;
      conceal(true);
      try {
        await painted();
        const ok = await new Promise((done) => {
          waiting.set(id, done);
          setTimeout(() => answer(id, "late"), TIMEOUT);
          ns.worker.post({ type: "capture", id, viewport: { width: innerWidth, height: innerHeight } });
        });
        if (ok === "late") this.drop(id); // still capturing: it isn't kept
        return ok === true ? id : null;
      } finally {
        conceal(false);
      }
    },
    // drop throws a capture away: its composer closed without sending.
    drop(id) {
      if (id) ns.worker.post({ type: "drop", id });
    },
  };

  const off = ns.worker.on((msg) => {
    if (msg.type === "captured") answer(msg.id, msg.ok);
    // The worker's port went: nothing it was capturing will come back.
    if (msg.type === "closed") for (const id of [...waiting.keys()]) answer(id, false);
  });
  ns.teardowns.push(() => {
    off();
    hiding = 1;
    conceal(false);
  });
})();
