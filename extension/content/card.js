// The composer and the live card share one floating panel. The composer opens
// at once on a pick; Send turns it into the card, which shows the status live
// (with the time spent while working), the request and Claude's summary. The
// card stays open until esc or ×; clicking around the page leaves it open.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const GAP = 14; // between the anchor point and the panel
  const EDGE = 8; // from the viewport's edges

  // mode: null, {kind: "compose", element, anchor, sending, error, ref}
  // or {kind: "card", number, request} (request is the local copy while the
  // bridge's tweak hasn't arrived yet).
  let mode = null;
  let panel = null;
  let parts = {};
  let refs = 0;

  const el = (...a) => ns.overlay.el(...a);

  function frame(title, chip) {
    panel?.remove();
    panel = el("div", "panel");
    panel.setAttribute("role", "dialog");
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        ns.panel.close();
      }
    });
    const head = el("div", "head");
    const close = el("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => ns.panel.close());
    head.append(el("span", "title", title));
    const label = el("span", "chip", chip);
    label.hidden = !chip;
    head.append(label);
    head.append(close);
    panel.setAttribute("aria-label", title);
    panel.append(head);
    ns.overlay.root.append(panel);
    return panel;
  }

  function drawCompose() {
    const label = ns.describe.label(mode.element);
    frame("New tweak", label);
    const text = el("textarea");
    text.placeholder = "What should change?";
    text.rows = 3;
    text.setAttribute("aria-label", "Your tweak");
    const error = el("div", "error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    const foot = el("div", "foot");
    const hint = el("span", "hint");
    hint.append(el("kbd", "", "↵"), " send  ", el("kbd", "", "⇧↵"), " new line  ", el("kbd", "", "esc"), " cancel");
    const send = el("button", "send", "Send");
    send.type = "button";
    foot.append(hint, send);
    panel.append(text, error, foot);

    const refresh = () => {
      const connected = ns.worker.connection === "connected";
      send.disabled = mode.sending || !text.value.trim() || !connected;
      send.textContent = mode.sending ? "Sending…" : "Send";
      const why = mode.error || (connected ? "" : "Not connected to Tweak");
      error.textContent = why;
      error.hidden = !why;
    };
    text.addEventListener("input", () => {
      mode.error = "";
      refresh();
    });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    send.addEventListener("click", submit);
    parts = { text, send, refresh };
    refresh();
    requestAnimationFrame(() => text.focus({ preventScroll: true }));
  }

  function submit() {
    if (mode?.kind !== "compose" || parts.send.disabled) return;
    const element = mode.element;
    mode.sending = true;
    mode.error = "";
    mode.ref = `t${++refs}`;
    parts.text.readOnly = true;
    parts.refresh();
    ns.worker.post({
      type: "create",
      ref: mode.ref,
      url: location.href,
      request: parts.text.value.trim(),
      targets: { elements: [{ label: ns.describe.label(element), text: ns.describe.text(element), selector: ns.describe.selector(element) }] },
      anchor: mode.anchor,
    });
  }

  function drawCard() {
    const tweak = ns.page.tweak(mode.number);
    frame(`Tweak ${mode.number}`, mode.label);
    const status = el("div", "status");
    const dot = el("span", "dot");
    const statusText = el("span");
    status.append(dot, statusText);
    const request = el("p", "request");
    const summary = el("div");
    summary.append(el("div", "summary-label", "Claude"), el("p", "summary"));
    summary.hidden = true;
    panel.append(status, request, summary);
    status.setAttribute("aria-live", "polite");
    parts = { chip: panel.querySelector(".chip"), status, statusText, request, summary };
    updateCard(tweak);
  }

  function updateCard(tweak = ns.page.tweak(mode.number)) {
    const { chip, status, statusText, request, summary } = parts;
    const label = tweak?.targets?.elements?.[0]?.label ?? mode.label ?? "";
    if (chip.textContent !== label) chip.textContent = label;
    chip.hidden = !label;
    const s = tweak ? ns.describe.status(tweak) : { text: "Sending…", tone: "sent" };
    status.className = `status tone-${s.tone}${tweak?.status === "working" ? " working" : ""}`;
    if (statusText.textContent !== s.text) statusText.textContent = s.text;
    const words = tweak?.entries?.find((e) => e.kind === "request")?.text ?? mode.request ?? "";
    if (request.textContent !== words) request.textContent = words;
    const said = tweak?.entries?.findLast((e) => e.kind === "summary")?.text ?? "";
    summary.hidden = !said;
    if (summary.lastChild.textContent !== said) summary.lastChild.textContent = said;
  }

  // anchor is the point the panel hangs from.
  function anchor() {
    if (mode.kind === "compose") {
      if (!mode.element.isConnected) return null;
      const r = mode.element.getBoundingClientRect();
      return { x: r.left + mode.anchor.x * r.width, y: r.top + mode.anchor.y * r.height };
    }
    return ns.pins.point(mode.number);
  }

  // place puts the panel beside its anchor: below and to the right, flipped
  // at the viewport's edges, and kept inside it.
  function place() {
    if (!panel) return;
    const at = anchor() ?? { x: innerWidth - EDGE - panel.offsetWidth - GAP, y: EDGE };
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    let x = at.x + GAP;
    let y = at.y + GAP;
    if (x + w > innerWidth - EDGE) x = at.x - GAP - w;
    if (y + h > innerHeight - EDGE) y = at.y - GAP - h;
    x = Math.min(Math.max(EDGE, x), innerWidth - EDGE - w);
    y = Math.min(Math.max(EDGE, y), innerHeight - EDGE - h);
    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
  }

  ns.panel = {
    compose(element, at) {
      if (mode?.kind === "compose" && mode.sending) return; // one send at a time
      mode = { kind: "compose", element, anchor: at, sending: false, error: "" };
      drawCompose();
      place();
      ns.page.cardChanged(null);
    },
    // show opens the card of tweak number.
    show(number, request, label) {
      ns.picker.release();
      mode = { kind: "card", number, request, label };
      drawCard();
      place();
      ns.page.cardChanged(number);
      ns.page.redraw();
    },
    toggle(number) {
      if (this.showing() === number) this.close();
      else this.show(number);
    },
    showing: () => (mode?.kind === "card" ? mode.number : null),
    close() {
      const was = mode;
      mode = null;
      panel?.remove();
      panel = null;
      ns.picker.release();
      if (was?.kind === "card") {
        ns.page.cardChanged(null);
        ns.page.redraw();
      }
    },
    // created is the bridge's answer to a Send.
    created(msg) {
      if (mode?.kind !== "compose" || msg.ref !== mode.ref) return;
      if (msg.number) {
        this.show(msg.number, parts.text.value.trim(), ns.describe.label(mode.element));
        return;
      }
      mode.sending = false;
      mode.error = msg.error || "Couldn't send the tweak";
      parts.text.readOnly = false;
      parts.refresh();
    },
    // update re-renders from the page's tweaks and the connection.
    update() {
      if (mode?.kind === "card") updateCard();
      if (mode?.kind === "compose") parts.refresh();
    },
    // tick runs every frame while anything is shown.
    tick() {
      if (!mode) return;
      if (mode.kind === "card") updateCard();
      place();
    },
    open: () => mode !== null,
  };
  ns.teardowns.push(() => panel?.remove());
})();
