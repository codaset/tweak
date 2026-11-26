// The composer and the live card share one floating panel. The composer opens
// at once on a pick; Send turns it into the card, which shows the status live
// (with the time spent while working), the request and the conversation after
// it: Claude's plan, its question, your reply, its summary or its reason for
// declining. While Claude has a question, the card has a reply box, and the
// card opens by itself when the question arrives (without taking the focus).
// When Claude hasn't picked a delivered tweak up after the bridge sent it
// twice more, the card says so and offers Send again.
// The card stays open until esc or ×; clicking around the page, or navigating
// within it, leaves it open. While the page is dormant (no claim covers it)
// the card is hidden, and it comes back when a claim covers the page again.
//
// The panel is a non-modal dialog (aria-modal="false"): the page stays live
// around it, so Tab isn't trapped. Opening it from a pin or a Send moves focus
// into it; closing it gives focus back to the pin, or to the page element a
// just-sent tweak points at. While the composer is open or holds a draft, or
// the reply box holds one, the tab is busy, which holds a pending self-update
// reload back.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const GAP = 14; // between the anchor point and the panel
  const EDGE = 8; // from the viewport's edges

  // mode: null, {kind: "compose", element, targets, anchor, sending, error, ref}
  // or {kind: "card", number, request, label, replying, replyError, replyRef,
  // resending, resendError, resendRef} (request and label are the local
  // copies while the bridge's tweak hasn't arrived yet; the reply fields are
  // a reply on its way, the resend fields a Send again). Both may carry
  // returnTo, the element focus goes back to on close.
  let mode = null;
  let panel = null;
  let asleep = false; // the page is dormant: the card is kept, but hidden
  let parts = {};
  let refs = 0;

  const el = (...a) => ns.overlay.el(...a);

  function frame(title, chip) {
    panel?.remove();
    panel = el("div", "panel");
    panel.hidden = asleep;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.tabIndex = -1;
    // Key events stop at the shadow root, so esc inside the overlay is heard here.
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
    const heading = el("span", "title", title);
    heading.id = "panel-title";
    head.append(heading);
    const label = el("span", "chip", chip);
    label.hidden = !chip;
    head.append(label);
    head.append(close);
    panel.setAttribute("aria-labelledby", heading.id);
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
      ns.busy?.set("draft", text.value.trim() !== "");
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
      targets: mode.targets,
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
    // The conversation scrolls on its own, so it's a labelled region the
    // keyboard can reach and scroll.
    const thread = el("div", "thread");
    thread.hidden = true;
    thread.tabIndex = 0;
    thread.setAttribute("role", "region");
    thread.setAttribute("aria-label", "Conversation");
    // New entries from Claude (or Tweak) are read out here, so a question
    // that opens the card without taking the focus is still heard.
    const heard = el("div", "sr-only");
    heard.setAttribute("aria-live", "polite");

    // The reply box, shown while Claude has a question. It's built once and
    // shown or hidden, so what you type survives every redraw.
    const answer = el("div", "answer");
    const box = el("textarea");
    box.placeholder = "Your answer…";
    box.rows = 2;
    box.setAttribute("aria-label", "Your reply to Claude");
    const error = el("div", "error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    const foot = el("div", "foot");
    const hint = el("span", "hint");
    hint.id = "reply-hint";
    hint.append(el("kbd", "", "↵"), " reply  ", el("kbd", "", "⇧↵"), " new line");
    box.setAttribute("aria-describedby", hint.id);
    const send = el("button", "send", "Reply");
    send.type = "button";
    foot.append(hint, send);
    answer.append(box, error, foot);
    answer.hidden = true;
    box.addEventListener("input", () => {
      mode.replyError = "";
      ns.busy?.set("draft", box.value.trim() !== "");
      refreshReply();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitReply();
      }
    });
    send.addEventListener("click", submitReply);

    // Send again, shown while Claude hasn't picked the tweak up.
    const retry = el("div", "retry");
    const retryError = el("span", "error");
    retryError.setAttribute("role", "alert");
    const resend = el("button", "send", "Send again");
    resend.type = "button";
    resend.addEventListener("click", submitResend);
    retry.append(retryError, resend);
    retry.hidden = true;

    panel.append(status, retry, request, thread, answer, heard);
    status.setAttribute("aria-live", "polite");
    // heardUpTo is how many entries have been read out or were there when the
    // card opened; a card opened by Claude's question reads that one out.
    const entries = ns.describe.thread(tweak);
    const heardUpTo = mode.announce ? Math.max(0, entries.length - 1) : entries.length;
    parts = {
      chip: panel.querySelector(".chip"),
      status,
      statusText,
      request,
      thread,
      said: "",
      heard,
      heardUpTo,
      answer,
      box,
      send,
      error,
      retry,
      resend,
      retryError,
    };
    updateCard(tweak);
  }

  function updateCard(tweak = ns.page.tweak(mode.number)) {
    const { chip, status, statusText, request, thread, answer, box } = parts;
    const label = tweak?.targets?.elements?.[0]?.label ?? mode.label ?? "";
    if (chip.textContent !== label) chip.textContent = label;
    chip.hidden = !label;
    const s = ns.describe.status(tweak);
    const unanswered = ns.describe.unanswered(tweak);
    const statusClass = `status ${ns.describe.classes(tweak)}${unanswered ? " unanswered" : ""}`;
    if (status.className !== statusClass) status.className = statusClass;
    if (statusText.textContent !== s.text) statusText.textContent = s.text;
    const words = tweak?.entries?.find((e) => e.kind === "request")?.text ?? mode.request ?? "";
    if (request.textContent !== words) request.textContent = words;

    // The conversation is redrawn only when it changes (every change brings
    // a new tweak object), and scrolled to its newest entry.
    const entries = tweak === parts.tweak ? null : ns.describe.thread(tweak);
    const said = entries && JSON.stringify(entries);
    parts.tweak = tweak;
    if (entries && said !== parts.said) {
      parts.said = said;
      thread.replaceChildren(
        ...entries.map((e) => {
          const item = el("div", e.className);
          item.append(el("div", "entry-label", e.label), el("p", "entry-text", e.text));
          return item;
        }),
      );
      thread.hidden = entries.length === 0;
      thread.scrollTop = thread.scrollHeight;
      announce(entries.slice(parts.heardUpTo));
      parts.heardUpTo = entries.length;
    }

    const asking = tweak?.status === "question";
    if (answer.hidden === asking) {
      answer.hidden = !asking;
      if (!asking) {
        // The question is answered or over: the box goes, with any draft.
        if (ns.overlay.root?.activeElement === box) panel.focus({ preventScroll: true });
        box.value = "";
        mode.replyError = "";
        ns.busy?.set("draft", false);
      }
    }
    refreshReply();

    // Send again stays up while its answer is on the way, or it failed.
    // Once sent, it hides until the tweak's resend shows (resendOffer).
    const resend = ns.describe.resendOffer(tweak, mode.resent);
    mode.resent = resend.sentAt;
    const offer = resend.offer || Boolean(mode.resending || mode.resendError);
    if (parts.retry.hidden === offer) {
      if (!offer && ns.overlay.root?.activeElement === parts.resend) panel.focus({ preventScroll: true });
      parts.retry.hidden = !offer;
    }
    refreshResend();
  }

  function refreshResend() {
    const { resend, retryError } = parts;
    const connected = ns.worker.connection === "connected";
    const disabled = Boolean(mode.resending) || !connected;
    if (resend.disabled !== disabled) resend.disabled = disabled;
    const label = mode.resending ? "Sending…" : "Send again";
    if (resend.textContent !== label) resend.textContent = label;
    const why = mode.resendError || (connected ? "" : "Not connected to Tweak");
    if (retryError.textContent !== why) retryError.textContent = why;
  }

  function submitResend() {
    if (mode?.kind !== "card" || parts.resend.disabled) return;
    mode.resending = true;
    mode.resendError = "";
    mode.resendRef = `t${++refs}`;
    mode.resendFrom = ns.page.tweak(mode.number)?.resends; // the resends it was sent at
    refreshResend();
    ns.worker.post({ type: "again", ref: mode.resendRef, number: mode.number });
  }

  // resendEnded finishes a Send again: sent (the tweak's next event, with
  // its again: line on the way, hides the offer), or refused with why.
  function resendEnded(why) {
    mode.resending = false;
    mode.resendError = why;
    if (!why) mode.resent = mode.resendFrom;
    updateCard();
  }

  // announce reads new entries out through the live region. The text is set
  // a moment after the region exists, or a screen reader may miss it.
  function announce(entries) {
    const words = entries.map((e) => e.announce).filter(Boolean).join(". ");
    if (!words) return;
    const { heard } = parts;
    heard.textContent = "";
    setTimeout(() => (heard.textContent = words), 150);
  }

  function refreshReply() {
    const { box, send, error } = parts;
    const connected = ns.worker.connection === "connected";
    const disabled = Boolean(mode.replying) || !box.value.trim() || !connected;
    if (send.disabled !== disabled) send.disabled = disabled;
    const label = mode.replying ? "Sending…" : "Reply";
    if (send.textContent !== label) send.textContent = label;
    if (box.readOnly !== Boolean(mode.replying)) box.readOnly = Boolean(mode.replying);
    const why = mode.replyError || (connected ? "" : "Not connected to Tweak");
    if (error.textContent !== why) error.textContent = why;
    if (error.hidden !== !why) error.hidden = !why;
  }

  function submitReply() {
    if (mode?.kind !== "card" || parts.send.disabled) return;
    mode.replying = true;
    mode.replyError = "";
    mode.replyRef = `t${++refs}`;
    refreshReply();
    ns.worker.post({ type: "reply", ref: mode.replyRef, number: mode.number, text: parts.box.value.trim() });
  }

  // replyEnded finishes a reply on its way: sent (the box empties; the
  // tweak's next event hides it), or refused with why, keeping the text.
  function replyEnded(why) {
    mode.replying = false;
    mode.replyError = why;
    if (!why) {
      parts.box.value = "";
      ns.busy?.set("draft", false);
    }
    refreshReply();
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

  // composing marks the tab busy while the composer is open or holds a draft.
  function composing(on) {
    ns.busy?.set("composer", on);
    if (!on) ns.busy?.set("draft", false);
  }

  // focusIn moves the focus into the panel: to the reply box while Claude
  // has a question, otherwise to the panel itself. Only for the card it was
  // asked for: if that card closed or another opened by the next frame (a
  // question's card, which doesn't take the focus), nothing moves. Redraws
  // of the same card don't count.
  let opened = 0; // bumped by every show and close
  const focusIn = () => {
    const asked = opened;
    requestAnimationFrame(() => {
      if (opened !== asked) return;
      const target = parts.answer && !parts.answer.hidden ? parts.box : panel;
      target?.focus({ preventScroll: true });
    });
  };

  ns.panel = {
    compose(element, at) {
      if (mode?.kind === "compose" && mode.sending) return; // one send at a time
      // The context is gathered now, while the page still shows what was picked.
      const targets = ns.context.targets([element]);
      mode = { kind: "compose", element, targets, anchor: at, sending: false, error: "", returnTo: element };
      drawCompose();
      place();
      composing(true);
      ns.page.cardChanged(null);
    },
    // show opens the card of tweak number. With focus, it takes the focus,
    // and gives it back to returnTo when it closes; a card reopened after a
    // reload doesn't take it.
    show(number, { request, label, focus = false, returnTo = null, announce = false } = {}) {
      ns.picker.release();
      composing(false);
      opened++;
      mode = { kind: "card", number, request, label, returnTo, announce };
      drawCard();
      place();
      if (focus) focusIn();
      ns.page.cardChanged(number);
      ns.page.redraw();
    },
    // asked opens the card of a tweak Claude has just asked about, without
    // taking the focus. It leaves a composer, and a reply being written on
    // another card, alone.
    asked(number) {
      if (mode?.kind === "compose") return;
      if (mode?.kind === "card" && (mode.number === number || parts.box?.value.trim())) return;
      this.show(number, { announce: true });
    },
    toggle(number, pin) {
      if (this.showing() === number) this.close();
      else this.show(number, { focus: true, returnTo: pin });
    },
    // showing is the open card's number, hidden or not.
    showing: () => (mode?.kind === "card" ? mode.number : null),
    // sleep hides the card while the page is dormant, and shows it again
    // after. A composer closes: nothing can be sent from a dormant page.
    sleep(on) {
      if (on === asleep) return;
      if (on && mode?.kind === "compose") this.close();
      asleep = on;
      if (!panel) return;
      panel.hidden = on;
      if (!on) place();
    },
    close() {
      opened++;
      const was = mode;
      // Focus goes back only if it was in the overlay: never taken from the page.
      const focused = ns.overlay.root?.activeElement;
      mode = null;
      panel?.remove();
      panel = null;
      ns.picker.release();
      composing(false);
      if (was?.kind === "card") {
        ns.page.cardChanged(null);
        ns.page.redraw();
      }
      if (focused && was?.returnTo?.isConnected) was.returnTo.focus({ preventScroll: true });
    },
    // created is the bridge's answer to a Send.
    created(msg) {
      if (mode?.kind !== "compose" || msg.ref !== mode.ref) return;
      if (msg.number) {
        this.show(msg.number, {
          request: parts.text.value.trim(),
          label: ns.describe.label(mode.element),
          focus: true,
          returnTo: mode.element,
        });
        return;
      }
      mode.sending = false;
      mode.error = msg.error || "Couldn't send the tweak";
      parts.text.readOnly = false;
      parts.refresh();
    },
    // replied is the bridge's answer to a reply.
    replied(msg) {
      if (mode?.kind !== "card" || msg.ref !== mode.replyRef || !mode.replying) return;
      replyEnded(msg.number ? "" : msg.error || "Couldn't send the reply");
    },
    // resent is the bridge's answer to a Send again.
    resent(msg) {
      if (mode?.kind !== "card" || msg.ref !== mode.resendRef || !mode.resending) return;
      resendEnded(msg.number ? "" : msg.error || "Couldn't send it again");
    },
    // unsent ends a send whose answer can't come (the worker's port went):
    // the composer or reply box keeps the text and says why.
    unsent(why) {
      if (mode?.kind === "card" && mode.replying) replyEnded(why);
      if (mode?.kind === "card" && mode.resending) resendEnded(why);
      if (mode?.kind !== "compose" || !mode.sending) return;
      mode.sending = false;
      mode.error = why;
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
      if (!mode || asleep) return;
      if (mode.kind === "card") updateCard();
      place();
    },
    // open is whether the panel is on screen.
    open: () => mode !== null && !asleep,
  };
  ns.teardowns.push(() => panel?.remove());
})();
