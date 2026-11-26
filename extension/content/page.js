// This page's tweaks, from the worker: it says which page this is when its
// port opens, and hears the page's tweaks, each change to one, and the
// answers to its sends. It draws the pins, keeps the card in step, and runs
// the frame loop that keeps both on their elements as the page moves.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const tweaks = new Map(); // number -> tweak, this page's
  let frame = 0;

  const list = () => [...tweaks.values()].sort((a, b) => a.number - b.number);

  function loop() {
    frame = 0;
    if (!ns.pins.any() && !ns.panel.open()) return;
    ns.pins.position();
    ns.picker.follow();
    ns.panel.tick();
    frame = requestAnimationFrame(loop);
  }

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
        ns.worker.post({ type: "page", url: location.href });
        break;
      case "state":
        ns.panel.update();
        break;
      case "tweaks":
        tweaks.clear();
        for (const t of msg.tweaks) tweaks.set(t.number, t);
        ns.page.redraw();
        if (msg.card && tweaks.has(msg.card) && !ns.panel.open()) ns.panel.show(msg.card);
        break;
      case "tweak":
        tweaks.set(msg.tweak.number, msg.tweak);
        ns.page.redraw();
        break;
      case "created":
        ns.panel.created(msg);
        break;
    }
  });

  // esc closes the panel wherever the focus is.
  const onKey = (e) => {
    if (e.key === "Escape" && ns.panel.open() && !ns.overlay.contains(e)) ns.panel.close();
  };
  window.addEventListener("keydown", onKey, true);

  ns.teardowns.push(() => {
    off();
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", onKey, true);
  });
})();
