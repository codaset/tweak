// This page's tweaks, from the worker: it says which page this is when its
// port opens, and hears the page's tweaks, each change to one, whether any
// claim still covers the page, and the answers to its sends. It draws the
// pins, keeps the card in step, and runs the frame loop that keeps both on
// their elements as the page moves. On a page no claim covers (released, or
// navigated outside every claim) it goes dormant: no picker, no pins, no card.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const tweaks = new Map(); // number -> tweak, this page's
  let frame = 0;
  let claimed = true; // the scripts run only on claimed pages; the worker says otherwise

  const list = () => (claimed ? [...tweaks.values()].sort((a, b) => a.number - b.number) : []);

  function loop() {
    frame = 0;
    if (!ns.pins.any() && !ns.panel.open()) return;
    ns.pins.position();
    ns.picker.follow();
    ns.panel.tick();
    frame = requestAnimationFrame(loop);
  }

  // setClaimed wakes the page, or puts it to sleep.
  function setClaimed(on) {
    if (on === claimed) return;
    claimed = on;
    if (!on) {
      if (ns.panel.open()) ns.panel.close();
      ns.picker.release();
    }
    ns.page.redraw();
  }
  ns.picker.enable(() => claimed);

  ns.page = {
    tweak: (number) => tweaks.get(number),
    // redraw puts the pins and card in step with the tweaks.
    redraw() {
      ns.pins.render(list());
      ns.panel.update();
      if (!frame) frame = requestAnimationFrame(loop);
    },
    // cardChanged tells the worker which card is open in this tab, so it
    // reopens in place after a reload.
    cardChanged(number) {
      ns.worker.post({ type: "card", number });
      if (!frame) frame = requestAnimationFrame(loop);
    },
  };

  const off = ns.worker.on((msg) => {
    switch (msg.type) {
      case "open": // the port (re)connected: say which page this is
        shown = pageKey();
        ns.worker.post({ type: "page", url: location.href });
        break;
      case "state":
        ns.panel.update();
        break;
      case "tweaks":
        tweaks.clear();
        for (const t of msg.tweaks) tweaks.set(t.number, t);
        setClaimed(msg.claimed !== false);
        ns.page.redraw();
        if (claimed && msg.card && tweaks.has(msg.card) && !ns.panel.open()) ns.panel.show(msg.card);
        break;
      case "tweak":
        tweaks.set(msg.tweak.number, msg.tweak);
        ns.page.redraw();
        break;
      case "claimed":
        setClaimed(msg.claimed);
        break;
      case "created":
        ns.panel.created(msg);
        break;
    }
  });

  // Client-side navigation (the page's own pushState included): a new path
  // is a new page, so its tweaks replace this one's, and the worker says
  // whether a claim covers it. The query and hash don't change the page.
  const pageKey = () => `${location.origin}${location.pathname}`;
  let shown = pageKey();
  const onNavigate = () => {
    if (pageKey() === shown) return;
    shown = pageKey();
    if (ns.panel.open()) ns.panel.close();
    tweaks.clear();
    ns.page.redraw();
    ns.worker.post({ type: "page", url: location.href });
  };
  globalThis.navigation?.addEventListener("currententrychange", onNavigate);

  // esc closes the panel wherever the focus is: on the page here, and in
  // the overlay (panel and pins) through ns.panel.onKey.
  const onKey = (e) => {
    if (e.key === "Escape" && ns.panel.open() && !ns.overlay.contains(e)) ns.panel.close();
  };
  window.addEventListener("keydown", onKey, true);

  ns.teardowns.push(() => {
    off();
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", onKey, true);
    globalThis.navigation?.removeEventListener("currententrychange", onNavigate);
  });
})();
