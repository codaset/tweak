// The composer and the live card share one floating panel. The composer opens
// at once on a pick; Send turns it into the card, which shows the status live
// (with the time spent while working), the request and the conversation after
// it: Claude's plan, its question, your reply, its summary or its reason for
// declining; once Claude is done, Undo (or where an undo with Claude
// stands). The files it changed aren't listed: the side panel's resolved
// tweaks say how many. While Claude has a
// question, the card has a reply box, and the card opens by itself when the
// question arrives (without taking the focus). When Claude hasn't picked a
// delivered tweak up after the bridge sent it twice more, the card says so
// and offers Send again. At its foot, Withdraw takes back a tweak Claude is
// still on, and Resolve clears away a finished one; either way the tweak is
// resolved, its pin leaves the page and the card closes (the side panel
// lists it, with Undo).
// The card stays open until esc or ×; clicking around the page, or navigating
// within it, leaves it open. While the page is dormant (no claim covers it)
// the card is hidden, and it comes back when a claim covers the page again.
//
// The panel is a non-modal dialog (aria-modal="false"): the page stays live
// around it, so Tab isn't trapped. Opening it from a pin or a Send moves focus
// into it; closing it gives focus back to the pin, or to the page element a
// just-sent tweak points at. While the composer is open or holds a draft, or
// the reply box holds one, the tab is busy, which holds a pending self-update
// reload back. Both drafts are kept for the tab as you type (drafts.js), so
// a reload opens them again; Send or esc clears them.
// While the bridge is down the panel is faded and read-only: every action
// that needs the bridge is disabled with "Not connected to Tweak", and what
// you type is kept until it can be sent.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;
  const { find, pageKey } = ns.util;

  const GAP = 14; // between the anchor point and the panel
  const EDGE = 8; // from the viewport's edges

  // mode: null, {kind: "compose", element, targets, anchor, sending, error, ref}
  // or {kind: "card", number, request, replying, replyError, replyRef,
  // resending, resendError, resendRef, undoing, undoError, undoRef, finishing,
  // finishError, finishRef} (request is the local copy while the bridge's
  // tweak hasn't arrived yet; the reply fields are a reply on its way, the resend fields a Send
  // again, the undo fields an Undo, the finish fields a Withdraw or Resolve
// on its way, finishing being which). Both may carry
  // returnTo, the element focus goes back to on close.
  let mode = null;
  let panel = null;
  let asleep = false; // the page is dormant: the card is kept, but hidden
  let parts = {};
  let refs = 0;

  const el = (...a) => ns.overlay.el(...a);

  // Icon buttons: Withdraw is a stop sign, Resolve a tick, Undo an arrow
  // turning back. The
  // label is the button's accessible name and its tooltip (overlay.js).
  const ICONS = {
    withdraw: ["solid:M5.2 1.25h5.6l3.95 3.95v5.6l-3.95 3.95h-5.6L1.25 10.8V5.2Z", "knock:M5 8h6"],
    resolve: ["M2.75 8.5 6.25 12 13.25 4.5"],
    undo: ["M5.75 3.25 2.5 6.5l3.25 3.25", "M2.75 6.5h6.5a3.75 3.75 0 0 1 0 7.5H7.5"],
  };
  function icon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    for (const spec of ICONS[name]) {
      // "solid:" fills a shape; "knock:" draws a line in the card's colour across it.
      const [, kind, d] = spec.match(/^(?:(solid|knock):)?(.*)$/);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      if (kind) path.setAttribute("class", kind);
      svg.append(path);
    }
    return svg;
  }
  // claudeMark is Claude's spark, beside the label of what Claude says in
  // the conversation. Anthropic's trademark: see THIRD_PARTY_NOTICES.md.
  const CLAUDE_MARK = "M 233.9 800.2 L 468.6 668.5 L 472.5 657.1 L 468.6 650.7 L 457.2 650.7 L 417.9 648.3 L 283.8 644.6 L 167.5 639.8 L 54.9 633.8 L 26.5 627.7 L 3.3e-05 592.7 L 2.7 575.2 L 26.5 559.2 L 60.7 562.2 L 136.1 567.3 L 249.4 575.1 L 331.5 580.0 L 453.2 592.6 L 472.5 592.6 L 475.3 584.8 L 468.7 580.0 L 463.5 575.1 L 346.3 495.7 L 219.5 411.8 L 153.1 363.5 L 117.1 339.0 L 99.0 316.1 L 91.2 266.0 L 123.8 230.0 L 167.6 233.0 L 178.8 236.0 L 223.2 270.2 L 318.0 343.5 L 441.8 434.7 L 459.9 449.7 L 467.1 444.6 L 468.0 441.0 L 459.9 427.4 L 392.6 305.7 L 320.7 181.9 L 288.8 130.6 L 280.3 99.8 C 277.3 87.2 275.1 76.5 275.1 63.6 L 312.3 13.2 L 332.8 6.6 L 382.3 13.2 L 403.2 31.3 L 434.0 101.7 L 483.8 212.5 L 561.1 363.2 L 583.8 407.9 L 595.8 449.3 L 600.4 461.9 L 608.2 461.9 L 608.2 454.7 L 614.5 369.8 L 626.3 265.6 L 637.7 131.5 L 641.7 93.7 L 660.4 48.4 L 697.5 24.0 L 726.5 37.8 L 750.3 72 L 747.0 94.0 L 732.8 186.2 L 705.1 330.5 L 686.9 427.1 L 697.5 427.1 L 709.6 415.0 L 758.4 350.1 L 840.6 247.4 L 876.8 206.7 L 919.1 161.7 L 946.3 140.2 L 997.6 140.2 L 1035.3 196.4 L 1018.4 254.4 L 965.6 321.4 L 921.8 378.2 L 859.0 462.7 L 819.7 530.4 L 823.4 535.8 L 832.7 534.9 L 974.6 504.7 L 1051.3 490.8 L 1142.8 475.1 L 1184.2 494.4 L 1188.7 514.1 L 1172.4 554.3 L 1074.6 578.4 L 959.8 601.4 L 788.9 641.8 L 786.8 643.4 L 789.2 646.3 L 866.2 653.6 L 899.1 655.4 L 979.8 655.4 L 1129.9 666.6 L 1169.1 692.5 L 1192.6 724.2 L 1188.7 748.4 L 1128.3 779.1 L 1046.8 759.8 L 856.5 714.6 L 791.3 698.3 L 782.3 698.3 L 782.3 703.7 L 836.6 756.8 L 936.3 846.8 L 1061.0 962.8 L 1067.4 991.4 L 1051.4 1014.1 L 1034.4 1011.7 L 924.8 929.2 L 882.6 892.1 L 786.8 811.4 L 780.4 811.4 L 780.4 819.9 L 802.5 852.2 L 919.0 1027.4 L 925.1 1081.1 L 916.6 1098.6 L 886.4 1109.1 L 853.2 1103.1 L 785.0 1007.3 L 714.6 899.5 L 657.9 802.8 L 650.9 806.8 L 617.4 1167.7 L 601.7 1186.1 L 565.5 1200 L 535.3 1177.0 L 519.3 1139.9 L 535.3 1066.5 L 554.6 970.7 L 570.3 894.6 L 584.5 800.1 L 592.9 768.7 L 592.4 766.6 L 585.5 767.5 L 514.2 865.3 L 405.8 1011.8 L 320.0 1103.6 L 299.5 1111.8 L 263.9 1093.3 L 267.2 1060.4 L 287.1 1031.1 L 405.8 880.1 L 477.4 786.5 L 523.6 732.4 L 523.3 724.6 L 520.5 724.6 L 205.2 929.3 L 149.1 936.6 L 124.9 914.0 L 127.9 876.8 L 139.4 864.8 L 234.2 799.5 L 233.8 799.8 Z";
  function claudeMark() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 1200 1200");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "claude-mark");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", CLAUDE_MARK);
    svg.append(path);
    return svg;
  }

  // iconLabel shows icon name on button, named label.
  function iconLabel(button, name, label) {
    if (button.dataset.icon !== name) {
      button.replaceChildren(icon(name));
      button.dataset.icon = name;
    }
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  }

  function frame(title, chip) {
    panel?.remove();
    panel = el("div", "panel");
    panel.hidden = asleep;
    panel.classList.toggle("offline", ns.worker.down());
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
    frame("New tweak", ns.describe.pointedAt(mode.targets));
    // What the tweak points at, under the title: the numbered elements, the
    // selected text, or the area. ⇧-click changes the elements without a
    // redraw, so the draft and the focus stay.
    const pointed = el("div", "pointed-at");
    const heard = el("div", "sr-only");
    heard.setAttribute("aria-live", "polite");
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
    panel.append(pointed, text, error, foot, heard);

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
      ns.drafts.setCompose(composeDraft());
      refresh();
    });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    send.addEventListener("click", submit);
    parts = { text, send, refresh, pointed, heard };
    drawPointed();
    refresh();
    requestAnimationFrame(() => text.focus({ preventScroll: true }));
  }

  // questionOf says which of a tweak's questions is the latest (1 for the
  // first): a reply draft is kept for that one only.
  const questionOf = (tweak) => (tweak?.entries ?? []).filter((e) => e.kind === "question").length;

  // composeDraft is the open composer as ns.drafts keeps it: what it points
  // at, by selector, and its text, so it can open again after a reload.
  const composeDraft = () => ({
    page: pageKey(),
    kind: mode.pick.kind,
    selectors: mode.targets.elements.map((e) => e.selector),
    anchor: mode.anchor,
    // The selection as sent is capped (with an ellipsis); the whole text
    // finds it again.
    ...(mode.targets.selection && { selection: mode.targets.selection, whole: mode.pick.range?.toString() }),
    ...(mode.targets.area && { area: mode.targets.area }),
    text: parts.text.value,
  });

  // drawPointed fills the composer's line about what it points at.
  function drawPointed() {
    const { pointed } = parts;
    const { pick, targets } = mode;
    const chip = panel.querySelector(".chip");
    chip.textContent = ns.describe.pointedAt(targets);
    chip.hidden = !chip.textContent;
    const named = (e) => el("span", "named", ns.describe.name(e));
    if (pick.kind === "text") {
      const quote = el("p", "selection-quote", targets.selection.text);
      quote.setAttribute("aria-label", `Selected text: ${targets.selection.text}`);
      pointed.replaceChildren(quote, el("p", "pointed", ""));
      pointed.lastChild.append("In ", named(targets.elements[0]));
      return;
    }
    if (pick.kind === "area") {
      const inside = targets.elements.length - 1;
      const line = el("p", "pointed");
      line.append("Inside ", named(targets.elements[0]), ", ");
      line.append(inside === 0 ? "over empty space" : `with ${inside} ${inside === 1 ? "element" : "elements"} in it`);
      pointed.replaceChildren(line);
      return;
    }
    const list = el("ol", "picked");
    list.setAttribute("aria-label", "Elements in this tweak");
    mode.hot = 0; // the list is new: no row is under the pointer or focus yet
    if (targets.elements.length > 1) {
      targets.elements.forEach((e, i) => {
        const item = el("li");
        // Pointing at a row, or focusing its ×, highlights it and its element
        // on the page (marked(), every frame).
        const hot = (on) => {
          item.classList.toggle("hot", on);
          if (on) mode.hot = i + 1;
          else if (mode.hot === i + 1) mode.hot = 0;
        };
        item.addEventListener("pointerenter", () => hot(true));
        item.addEventListener("pointerleave", () => hot(item.matches(":focus-within")));
        item.addEventListener("focusin", () => hot(true));
        item.addEventListener("focusout", (ev) => hot(item.contains(ev.relatedTarget) || item.matches(":hover")));
        const remove = el("button", "remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove element ${i + 1}, ${ns.describe.name(e)}`);
        remove.addEventListener("click", () => {
          ns.panel.add(mode.pick.elements[i]);
          // Keep the focus in the list, or give it back to the text.
          const buttons = parts.pointed.querySelectorAll(".remove");
          (buttons[Math.min(i, buttons.length - 1)] ?? parts.text).focus({ preventScroll: true });
        });
        item.append(el("span", "n", String(i + 1)), el("span", "what", ns.describe.name(e)), remove);
        list.append(item);
      });
    }
    const tip = el("p", "tip");
    tip.append(el("kbd", "", "⇧"), "-click adds an element, or takes it out");
    pointed.replaceChildren(...(list.childElementCount ? [list] : []), tip);
  }

  // marked is what the open composer or card points at, as marks: numbered
  // elements, the selected text, or the area and the element it's inside.
  // One element alone is the picker's outline while composing, and unmarked
  // on its card.
  function marked() {
    const box = (r) => ({ x: r.left ?? r.x, y: r.top ?? r.y, width: r.width, height: r.height });
    const of = (target, kind, number) => (target?.isConnected ? [{ kind, number, ...box(target.getBoundingClientRect()) }] : []);
    const areaBox = (a) => (a ? [{ kind: "area", x: a.page.x - scrollX, y: a.page.y - scrollY, width: a.page.width, height: a.page.height }] : []);
    const inArea = (els) => [
      ...(els[0] && els[0] !== document.body ? of(els[0], "inside", 1) : []),
      ...els.slice(1).flatMap((e, i) => of(e, "element", i + 2)),
    ];
    if (mode?.kind === "compose") {
      const { pick } = mode;
      if (pick.kind === "text") return [...pick.range.getClientRects()].filter((r) => r.width && r.height).map((r) => ({ kind: "text", ...box(r) }));
      if (pick.kind === "area") return [...areaBox(mode.targets.area), ...inArea(pick.elements)];
      if (pick.elements.length < 2) return [];
      return pick.elements.flatMap((e, i) => of(e, "element", i + 1).map((m) => (mode.hot === i + 1 ? { ...m, hot: true } : m)));
    }
    if (mode?.kind === "card") {
      const targets = ns.page.tweak(mode.number)?.targets;
      const els = targets?.elements ?? [];
      if (!targets?.area && !targets?.selection && els.length < 2) return [];
      if (!ns.pins.point(mode.number)) return []; // a card off its page, or its element gone
      if (targets.selection) {
        // The selected text, found again in element 1 by its words.
        if (!mode.found?.[0]?.isConnected) mode.found = [find(els[0].selector)];
        if (!mode.range || !mode.found[0].contains(mode.range.startContainer)) mode.range = textIn(mode.found[0], targets.selection);
        const rects = mode.range ? [...mode.range.getClientRects()].filter((r) => r.width && r.height) : [];
        return rects.length ? rects.map((r) => ({ kind: "text", ...box(r) })) : of(mode.found[0], "element", 1);
      }
      mode.found ??= [];
      const found = els.map((e, i) => {
        if (!mode.found[i]?.isConnected) mode.found[i] = find(e.selector);
        return mode.found[i];
      });
      if (targets.area) return [...areaBox(targets.area), ...inArea(found)];
      return found.flatMap((e, i) => of(e, "element", i + 1));
    }
    return [];
  }

  // addable says whether ⇧-click can change the composer's elements.
  const addable = () => mode?.kind === "compose" && !mode.sending && mode.pick.kind === "elements";

  // textIn is a range over the selected text in el, across its text nodes,
  // or null: the occurrence whose surroundings match the text before and
  // after it, else the first.
  function textIn(el, { text, before = "", after = "" }) {
    if (!el || !text) return null;
    const nodes = [];
    let all = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push([n, all.length]);
      all += n.data;
    }
    const squash = (t) => t.replace(/\s+/g, " ");
    const near = (t) => squash(t).replace(/^…|…$/g, "").trim();
    const [b, a] = [near(before), near(after)];
    let at = -1;
    for (let i = all.indexOf(text); i >= 0; i = all.indexOf(text, i + 1)) {
      if (at < 0) at = i;
      // The context may have been read from an ancestor, so either side
      // can be the longer: the shorter must be the end (or start) of the other.
      const x = squash(all.slice(0, i)).trim();
      const y = squash(all.slice(i + text.length)).trim();
      if ((x.endsWith(b) || b.endsWith(x)) && (y.startsWith(a) || a.startsWith(y))) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const point = (offset) => {
      for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i][1] <= offset) return [nodes[i][0], offset - nodes[i][1]];
      return null;
    };
    const range = document.createRange();
    range.setStart(...point(at));
    range.setEnd(...point(at + text.length));
    return range;
  }

  // submit sends the tweak. Send waits for the mappers only if they haven't
  // finished, and at most 300 ms (they ran while you typed); a send ended
  // meanwhile (the composer closed, or the port went and unsent() gave it
  // back) sends nothing, as a retry is a send of its own.
  async function submit() {
    if (mode?.kind !== "compose" || parts.send.disabled) return;
    const sending = mode;
    sending.sending = true;
    sending.error = "";
    const ref = (sending.ref = `t${++refs}`);
    parts.text.readOnly = true;
    parts.refresh();
    const request = parts.text.value.trim();
    sending.until.start(); // the mappers have had your typing; now 300 ms more at most
    await sending.located;
    if (mode !== sending || !sending.sending || sending.ref !== ref) return;
    ns.worker.post({
      type: "create",
      ref,
      url: location.href,
      request,
      targets: sending.targets,
      anchor: sending.anchor,
      // The pick's capture and its outlines: the worker keeps them to itself.
      ...(sending.shot ? { shot: { id: sending.shot, rects: sending.rects } } : {}),
    });
  }

  function drawCard() {
    const tweak = ns.page.tweak(mode.number);
    // A tweak's card has no chip: the pin and the outline already say what
    // it points at. The composer keeps one ("3 elements").
    frame(`Tweak ${mode.number}`, "");
    const status = el("div", "status");
    const dot = el("span", "dot");
    // Claude's spark stands in for the dot while Claude has the tweak.
    const mark = claudeMark();
    const statusText = el("span", "status-text");
    // "Change saved · Reload" while the page's reload is held back, with
    // the reason under it (reload.js).
    const reloadNow = el("button", "reload-now", "Reload");
    reloadNow.type = "button";
    reloadNow.hidden = true;
    reloadNow.addEventListener("click", () => ns.reload.now());
    const reloadSep = el("span", "reload-sep", "·");
    reloadSep.setAttribute("aria-hidden", "true");
    reloadSep.hidden = true;
    status.append(dot, mark, statusText, reloadSep, reloadNow);
    // Its own live region, so it never talks over the card's read-outs.
    const reloadWhy = el("p", "reload-why");
    reloadWhy.setAttribute("role", "status");
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
    // A reply half-written before a reload, or before this card was swapped
    // for another, is back.
    // One kept for a question that's over since is dropped.
    if (tweak && tweak.status !== "question") ns.drafts.setReply(mode.number, "");
    box.value = ns.drafts.reply(mode.number, questionOf(tweak));
    box.addEventListener("input", () => {
      mode.replyError = "";
      ns.busy?.set("draft", box.value.trim() !== "");
      ns.drafts.setReply(mode.number, box.value, questionOf(ns.page.tweak(mode.number)));
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

    // Where an undo with Claude stands, below the conversation. Its button sits
    // in the foot, beside Resolve.
    const undoRow = el("div", "undo");
    undoRow.hidden = true;
    const undoNote = el("p", "undo-note");
    const undoError = el("span", "error");
    undoError.setAttribute("role", "alert");
    const undoButton = el("button", "send secondary icon undo-button");
    iconLabel(undoButton, "undo", "Undo");
    undoButton.type = "button";
    undoButton.addEventListener("click", submitUndo);
    undoButton.hidden = true;
    undoRow.append(undoNote, undoError);

    // Withdraw while Claude is still on it; Undo and Resolve once it's finished.
    const actions = el("div", "actions");
    actions.hidden = true;
    const actionError = el("span", "error");
    actionError.setAttribute("role", "alert");
    const actionButton = el("button", "send icon quiet finish");
    actionButton.type = "button";
    actionButton.addEventListener("click", submitFinish);
    actions.append(actionError, undoButton, actionButton);

    panel.append(status, reloadWhy, retry, request, thread, undoRow, answer, actions, heard);
    status.setAttribute("aria-live", "polite");
    // heardUpTo is how many entries have been read out or were there when the
    // card opened; a card opened by Claude's question reads that one out.
    const entries = ns.describe.thread(tweak);
    const heardUpTo = mode.announce ? Math.max(0, entries.length - 1) : entries.length;
    parts = {
      status,
      statusText,
      reloadNow,
      reloadSep,
      reloadWhy,
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
      undoRow,
      undoNote,
      undoError,
      undoButton,
      undoSaid: "",
      actions,
      actionError,
      actionButton,
    };
    updateCard(tweak);
  }

  function updateCard(tweak = ns.page.tweak(mode.number)) {
    const { status, statusText, request, thread, answer, box } = parts;
    const s = ns.describe.status(tweak);
    const unanswered = ns.describe.unanswered(tweak);
    const withClaude = ns.describe.WITH_CLAUDE.has(tweak?.status) ? " with-claude" : "";
    const statusClass = `status ${ns.describe.classes(tweak)}${unanswered || s.quiet ? " unanswered" : ""}${withClaude}`;
    if (status.className !== statusClass) status.className = statusClass;
    if (statusText.textContent !== s.text) {
      // A folder in the text shows as code.
      const at = s.code ? s.text.indexOf(s.code) : -1;
      if (at < 0) statusText.textContent = s.text;
      else statusText.replaceChildren(s.text.slice(0, at), el("code", "", s.code), s.text.slice(at + s.code.length));
    }
    drawReload(ns.reload?.notice(mode.number));
    const words = tweak?.entries?.find((e) => e.kind === "request")?.text ?? mode.request ?? "";
    if (request.textContent !== words) request.textContent = words;

    // The conversation is redrawn only when it changes (every change brings
    // a new tweak object), and scrolled to its newest entry.
    const toSay = []; // what the live region reads out this time
    const entries = tweak === parts.tweak ? null : ns.describe.thread(tweak);
    const said = entries && JSON.stringify(entries);
    parts.tweak = tweak;
    if (entries && said !== parts.said) {
      parts.said = said;
      thread.replaceChildren(
        ...entries.map((e) => {
          const item = el("div", e.className);
          const label = el("div", "entry-label", e.label);
          if (e.className.includes("from-claude")) label.prepend(claudeMark());
          item.append(label, el("p", "entry-text", e.text));
          return item;
        }),
      );
      thread.hidden = entries.length === 0;
      thread.scrollTop = thread.scrollHeight;
      toSay.push(...entries.slice(parts.heardUpTo));
      parts.heardUpTo = entries.length;
    }

    // New entries and where an undo stands are read out together.
    const undone = drawUndo(tweak);
    if (undone) toSay.push(undone);
    announce(toSay);

    const asking = tweak?.status === "question";
    if (answer.hidden === asking) {
      answer.hidden = !asking;
      if (!asking) {
        // The question is answered or over: the box goes, with any draft.
        if (ns.overlay.root?.activeElement === box) panel.focus({ preventScroll: true });
        box.value = "";
        mode.replyError = "";
        ns.busy?.set("draft", false);
        ns.drafts.setReply(mode.number, "");
      } else if (box.value.trim()) ns.busy?.set("draft", true); // a kept draft
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
    refreshFinish(tweak);
  }

  // refreshFinish shows Withdraw or Resolve, and keeps it up while its
  // answer is on the way (aria-disabled, so it keeps the focus) or it failed.
  function refreshFinish(tweak = ns.page.tweak(mode.number)) {
    const { actions, actionButton, actionError } = parts;
    const offer = ns.describe.finish(tweak);
    const kind = mode.finishing ?? (mode.finishError ? mode.finishKind : offer?.kind);
    if (actionButton.hidden === Boolean(kind)) {
      if (!kind && ns.overlay.root?.activeElement === actionButton) panel.focus({ preventScroll: true });
      actionButton.hidden = !kind;
    }
    // The foot also holds Undo, so it shows while either button does.
    const foot = !kind && parts.undoButton.hidden;
    if (actions.hidden !== foot) actions.hidden = foot;
    if (!kind) return;
    const className = `send icon finish ${kind === "resolve" ? "secondary" : "quiet"}`;
    if (actionButton.className !== className) actionButton.className = className;
    const connected = ns.worker.connection === "connected";
    if (actionButton.disabled !== !connected) actionButton.disabled = !connected;
    const busy = String(Boolean(mode.finishing));
    if (actionButton.getAttribute("aria-disabled") !== busy) actionButton.setAttribute("aria-disabled", busy);
    const label = mode.finishing ? { withdraw: "Stopping and withdrawing…", resolve: "Resolving…" }[kind] : { withdraw: "Stop and withdraw", resolve: "Resolve" }[kind];
    iconLabel(actionButton, kind, label);
    const why = mode.finishError || (connected ? "" : "Not connected to Tweak");
    if (actionError.textContent !== why) actionError.textContent = why;
  }

  function submitFinish() {
    const offer = ns.describe.finish(ns.page.tweak(mode?.number));
    if (mode?.kind !== "card" || mode.finishing || !offer || parts.actionButton.disabled) return;
    mode.finishing = mode.finishKind = offer.kind;
    mode.finishError = "";
    mode.finishRef = `t${++refs}`;
    refreshFinish();
    ns.worker.post({ type: offer.kind, ref: mode.finishRef, number: mode.number });
  }

  // finishEnded finishes a Withdraw or Resolve: done (the tweak's event,
  // resolved, closes the card), or refused with why.
  function finishEnded(why) {
    mode.finishing = null;
    mode.finishError = why;
    refreshFinish();
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

  // drawReload shows Reload beside the status, and why the page hasn't
  // reloaded by itself, while its reload is held back.
  function drawReload(notice) {
    const { reloadNow, reloadSep, reloadWhy } = parts;
    const why = notice ? `Not reloaded: ${notice.why}.` : "";
    if (reloadWhy.textContent === why) return;
    if (!notice && ns.overlay.root?.activeElement === reloadNow) panel.focus({ preventScroll: true });
    reloadWhy.textContent = why;
    reloadNow.hidden = reloadSep.hidden = !notice;
  }

  // drawUndo shows Undo (or Ask Claude to undo) for a finished change, or
  // where its undo stands: with Claude, waiting for a session, or undone.
  // It returns what to read out when that changes while the card is open.
  function drawUndo(tweak) {
    const { undoRow, undoNote, undoButton } = parts;
    const u = ns.describe.undo(tweak);
    const said = JSON.stringify(u);
    let arrived = null;
    if (said !== parts.undoSaid) {
      if (parts.undoSaid !== "" && u && u.kind !== "offer") arrived = u;
      parts.undoSaid = said;
      undoRow.className = `undo${u ? ` undo-${u.kind}` : ""}`;
      const offer = u?.kind === "offer";
      // The button goes once the undo is under way: the focus stays in the card.
      if (!offer && ns.overlay.root?.activeElement === undoButton) panel.focus({ preventScroll: true });
      undoButton.hidden = !offer;
      refreshFinish(tweak);
      if (u?.kind === "waiting") undoNote.replaceChildren(u.text, " ", el("code", "command", u.command));
      else undoNote.replaceChildren(offer ? u.note : (u?.text ?? ""));
      undoNote.hidden = !undoNote.textContent;
      if (!offer) mode.undoError = "";
    }
    refreshUndo(u);
    if (!arrived) return null;
    return { announce: arrived.kind === "waiting" ? `${arrived.text} ${arrived.command}` : arrived.text };
  }

  function refreshUndo(u = ns.describe.undo(ns.page.tweak(mode.number))) {
    const { undoRow, undoButton, undoError } = parts;
    const connected = ns.worker.connection === "connected";
    // While its answer is on the way the button keeps the focus (a disabled
    // button would drop it), so it's only marked unavailable.
    if (undoButton.disabled !== !connected) undoButton.disabled = !connected;
    const busy = String(Boolean(mode.undoing));
    if (undoButton.getAttribute("aria-disabled") !== busy) undoButton.setAttribute("aria-disabled", busy);
    const asking = u?.label === "Ask Claude to undo";
    const label = mode.undoing ? (asking ? "Asking Claude…" : "Undoing…") : (u?.label ?? "Undo");
    iconLabel(undoButton, "undo", label);
    const why = u?.kind === "offer" ? mode.undoError || (connected ? "" : "Not connected to Tweak") : "";
    if (undoError.textContent !== why) undoError.textContent = why;
    if (undoError.hidden !== !why) undoError.hidden = !why;
    // The row says where an undo stands, or why Undo can't: with only a
    // button to offer, it has nothing to show (the button is in the foot).
    const quiet = !u || (u.kind === "offer" && !u.note && !why);
    if (undoRow.hidden !== quiet) undoRow.hidden = quiet;
  }

  function submitUndo() {
    if (mode?.kind !== "card" || mode.undoing || parts.undoButton.disabled) return;
    mode.undoing = true;
    mode.undoError = "";
    mode.undoRef = `t${++refs}`;
    ns.reload?.pressed(ns.page.tweak(mode.number), mode.undoRef); // the files may change before the answer comes
    refreshUndo();
    ns.worker.post({ type: "undo", ref: mode.undoRef, number: mode.number });
  }

  // undoEnded finishes an Undo: under way (the tweak's next event shows
  // where it stands), or refused with why, the button still offered.
  function undoEnded(why) {
    mode.undoing = false;
    mode.undoError = why;
    refreshUndo();
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
      ns.drafts.setReply(mode.number, "");
    }
    refreshReply();
  }

  // anchor is the point the panel hangs from.
  function anchor() {
    if (mode.kind === "compose") {
      // A composer on text or an area hangs below it, leaving it in view.
      if (mode.pick.kind === "area") {
        const { page } = mode.targets.area;
        return { x: page.x - scrollX, y: page.y + page.height - scrollY };
      }
      if (mode.pick.kind === "text") {
        const r = [...mode.pick.range.getClientRects()].at(-1);
        if (r) return { x: r.left, y: r.bottom };
      }
      const first = mode.pick.elements[0];
      if (!first.isConnected) return null;
      const r = first.getBoundingClientRect();
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
    // Clamped to the far edge first, then the near one: a panel bigger than
    // the viewport keeps its head on screen (its max-height scrolls the rest).
    x = Math.max(EDGE, Math.min(x, innerWidth - EDGE - w));
    y = Math.max(EDGE, Math.min(y, innerHeight - EDGE - h));
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
    // compose opens the composer on a pick (pointing.js): its elements, and
    // the selected text or the area. shot is the pick's capture
    // (ns.screenshot), sent with the tweak, or thrown away if it isn't.
    compose(pick, shot = null) {
      if (!this.canCompose()) return ns.screenshot.drop(shot); // one send at a time
      if (mode?.kind === "compose") ns.screenshot.drop(mode.shot); // a new pick replaces it
      // The context is gathered now, while the page still shows what was
      // picked, and the mappers start on every element in the background
      // while you type.
      const targets = ns.context.targets(pick.elements);
      if (pick.selection) targets.selection = pick.selection;
      if (pick.area) targets.area = pick.area;
      pick = { ...pick, elements: [...pick.elements] };
      // rects are the numbered outlines for the screenshot, taken now (#38),
      // and the page's scroll then: the capture's.
      const rects = ns.pointing.rects(pick);
      const scrolled = { x: scrollX, y: scrollY };
      const until = ns.mappers.deadline();
      const located = ns.context.locate(targets, pick.elements, until).catch(() => {});
      mode = { kind: "compose", pick, targets, rects, scrolled, shot, located, until, anchor: pick.anchor, sending: false, error: "", returnTo: pick.elements[0] };
      ns.drafts.setCompose(null); // a new pick starts a new draft
      drawCompose();
      place();
      composing(true);
      ns.page.cardChanged(null);
    },
    // show opens the card of tweak number. With focus, it takes the focus,
    // and gives it back to returnTo when it closes; a card reopened after a
    // reload doesn't take it.
    show(number, { request, focus = false, returnTo = null, announce = false, range = null } = {}) {
      // A composer this card replaces unsent takes its capture with it; a
      // sent one's went to the worker with its create.
      if (mode?.kind === "compose" && !mode.created) ns.screenshot.drop(mode.shot);
      if (mode?.kind === "compose") ns.drafts.setCompose(null); // sent, or replaced
      ns.picker.release();
      composing(false);
      opened++;
      mode = { kind: "card", number, request, returnTo, announce, range };
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
    // targets are the open composer's targets as Send will send them, and
    // rects its numbered outlines, taken at pick time; null without one.
    targets: () => (mode?.kind === "compose" ? mode.targets : null),
    rects: () => (mode?.kind === "compose" ? mode.rects : null),
    // showing is the open card's number, hidden or not.
    showing: () => (mode?.kind === "card" ? mode.number : null),
    // sleep hides the card while the page is dormant, and shows it again
    // after. A composer closes: nothing can be sent from a dormant page.
    sleep(on) {
      if (on === asleep) return;
      if (on && mode?.kind === "compose") this.close();
      asleep = on;
      if (on) ns.marks.clear();
      if (!panel) return;
      panel.hidden = on;
      if (!on) place();
    },
    close() {
      opened++;
      const was = mode;
      // Focus goes back only if it was in the overlay: never taken from the page.
      const focused = ns.overlay.root?.activeElement;
      if (was?.kind === "compose") ns.screenshot.drop(was.shot); // cancelled: thrown away
      // esc or ×: its draft goes too.
      if (was?.kind === "compose") ns.drafts.setCompose(null);
      if (was?.kind === "card") ns.drafts.setReply(was.number, "");
      mode = null;
      panel?.remove();
      panel = null;
      ns.marks.clear();
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
        mode.created = true; // its capture is the worker's now
        this.show(msg.number, {
          request: parts.text.value.trim(),
          focus: true,
          returnTo: mode.pick.elements[0],
          range: mode.pick.range ?? null, // the selection just sent, kept while it's on the page
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
    // undid is the bridge's answer to an Undo.
    undid(msg) {
      if (mode?.kind !== "card" || msg.ref !== mode.undoRef || !mode.undoing) return;
      undoEnded(msg.number ? "" : msg.message || msg.error || "Couldn't undo it");
    },
    // finished is the bridge's answer to a Withdraw or Resolve.
    finished(msg) {
      if (mode?.kind !== "card" || msg.ref !== mode.finishRef || !mode.finishing) return;
      finishEnded(msg.number ? "" : msg.error || "Couldn't do that");
    },
    // gone closes the card of a tweak just resolved or withdrawn (its pin
    // has left the page), saying where it went.
    gone(tweak) {
      if (this.showing() !== tweak.number) return;
      const shown = this.open();
      this.close();
      if (shown) ns.toast(`Tweak ${tweak.number} ${tweak.status === "withdrawn" ? "withdrawn" : "resolved"}. It's in the side panel.`);
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
      if (mode?.kind === "card" && mode.undoing) undoEnded(why);
      if (mode?.kind === "card" && mode.finishing) finishEnded(why);
      if (mode?.kind !== "compose" || !mode.sending) return;
      mode.sending = false;
      mode.error = why;
      parts.text.readOnly = false;
      parts.refresh();
    },
    // restore opens the composer again from its draft after a reload, on
    // the same page, if what it pointed at is all still there (and the text,
    // for a text pick); otherwise the draft is dropped. It has no
    // screenshot: that was the page as it was.
    restore(draft) {
      if (!draft || mode || asleep || draft.page !== pageKey()) return;
      const elements = (draft.selectors ?? []).map(find);
      const pick = { kind: draft.kind, elements, anchor: draft.anchor ?? { x: 0.5, y: 0.5 } };
      if (draft.kind === "text") Object.assign(pick, { selection: draft.selection, range: textIn(elements[0], { ...draft.selection, text: draft.whole ?? draft.selection?.text }) });
      if (draft.kind === "area") pick.area = draft.area;
      if (!elements.length || !elements.every(Boolean) || (draft.kind === "text" && !pick.range) || (draft.kind === "area" && !draft.area)) {
        ns.drafts.setCompose(null);
        return;
      }
      ns.picker.hold(draft.kind === "elements" && elements.length === 1 ? elements[0] : null);
      this.compose(pick);
      parts.text.value = draft.text;
      ns.busy?.set("draft", draft.text.trim() !== "");
      ns.drafts.setCompose(composeDraft());
      parts.refresh();
    },
    // update re-renders from the page's tweaks and the connection.
    update() {
      panel?.classList.toggle("offline", ns.worker.down());
      if (mode?.kind === "card") updateCard();
      if (mode?.kind === "compose") parts.refresh();
    },
    // tick runs every frame while anything is shown.
    tick() {
      if (!mode || asleep) return ns.marks.clear();
      if (mode.kind === "card") updateCard();
      ns.marks.draw(marked());
      place();
    },
    // canCompose says whether a pick would open a composer: not while a
    // send is on its way.
    canCompose: () => !(mode?.kind === "compose" && mode.sending),
    // canAdd says whether ⇧-click would change the open composer's elements.
    canAdd: () => addable(),
    // add puts target in the composer as the next element, or takes it out
    // if it's there; taking the last one out closes the composer. It says
    // whether it did anything.
    add(target) {
      if (!addable()) return false;
      const { pick, targets } = mode;
      const i = pick.elements.indexOf(target);
      let said;
      if (i >= 0) {
        if (pick.elements.length === 1) {
          this.close();
          return true;
        }
        const [gone] = targets.elements.splice(i, 1);
        pick.elements.splice(i, 1);
        if (i === 0) mode.anchor = { x: 0.5, y: 0.5 }; // the pin moves to the new element 1
        said = `Element ${i + 1}, ${ns.describe.name(gone)}, taken out. ${pick.elements.length} left.`;
      } else {
        pick.elements.push(target);
        const added = ns.context.element(target);
        targets.elements.push(added);
        // Its mappers run too; Send waits for them as for the rest.
        const locating = ns.context.locate({ elements: [added] }, [target], mode.until).catch(() => {});
        mode.located = Promise.all([mode.located, locating]);
        said = `Element ${pick.elements.length} added: ${ns.describe.name(targets.elements.at(-1))}.`;
      }
      mode.returnTo = pick.elements[0];
      // In the capture's viewport, which the page may have scrolled from since.
      const dx = scrollX - mode.scrolled.x;
      const dy = scrollY - mode.scrolled.y;
      mode.rects = ns.pointing.rects(pick).map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
      ns.picker.hold(pick.elements.length === 1 ? pick.elements[0] : null);
      drawPointed();
      ns.drafts.setCompose(composeDraft());
      parts.heard.textContent = said;
      ns.marks.draw(marked());
      place();
      return true;
    },
    // drafting is what you're writing: "tweak" while the composer is open,
    // "reply" while the reply box holds text, or "".
    drafting() {
      if (mode?.kind === "compose") return "tweak";
      if (mode?.kind === "card" && parts.box?.value.trim()) return "reply";
      return "";
    },
    // open is whether the panel is on screen.
    open: () => mode !== null && !asleep,
  };
  ns.teardowns.push(() => panel?.remove());
})();
