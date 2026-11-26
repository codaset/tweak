// The overlay host: one element holding a closed shadow root with its own
// styles, so the page can't reach in and nothing is added to the page's CSS.
// It sits in the top layer (popover="manual"), so the page's z-index can't
// cover it. The picker, pins and card draw inside it.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      width: auto;
      height: auto;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      overflow: visible;
      pointer-events: none;
      contain: strict;
      color-scheme: light dark;

      --bg: #ffffff;
      --surface: #f5f6f8;
      --text: #1b1f24;
      --muted: #626a75;
      --line: rgb(16 24 40 / 0.1);
      --accent: #4c5fd5;
      --accent-text: #ffffff;
      --shadow: 0 1px 2px rgb(16 24 40 / 0.08), 0 8px 24px -4px rgb(16 24 40 / 0.18), 0 24px 48px -12px rgb(16 24 40 / 0.18);
      --outline: #4c5fd5;
      /* Each status tone, and the colour of text on it (4.5:1 or more). */
      --tone-sent: #6d4fd0;
      --on-sent: #ffffff;
      --tone-working: #e08a00;
      --on-working: #1b1f24;
      --tone-question: #2563d9;
      --on-question: #ffffff;
      --question-surface: #edf2fd;
      --question-text: #1f55c0;
      --tone-done: #1d8049;
      --on-done: #ffffff;
      --tone-ended: #6b7280;
      --on-ended: #ffffff;
      --danger: #d4483b;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1d2025;
        --surface: #272b31;
        --text: #e9ebee;
        --muted: #9ba3ae;
        --line: rgb(255 255 255 / 0.1);
        --accent: #8193ff;
        --accent-text: #0f1220;
        --shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 12px 32px -6px rgb(0 0 0 / 0.55);
        --outline: #8193ff;
        --tone-sent: #a48bff;
        --on-sent: #101318;
        --tone-working: #ffad33;
        --on-working: #101318;
        --tone-question: #6a9bff;
        --on-question: #101318;
        --question-surface: #222a38;
        --question-text: #8fb3ff;
        --tone-done: #4cc983;
        --on-done: #101318;
        --tone-ended: #8a919b;
        --on-ended: #101318;
        --danger: #ff7b6e;
      }
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    /* The hover outline and its label */
    .outline {
      position: fixed;
      border: 2px solid var(--outline);
      border-radius: 4px;
      background: color-mix(in srgb, var(--outline) 8%, transparent);
      transition: inset 60ms ease-out, width 60ms ease-out, height 60ms ease-out;
    }
    .outline.picked { transition: none; border-style: solid; background: color-mix(in srgb, var(--outline) 5%, transparent); }
    .tag {
      position: fixed;
      max-width: 360px;
      padding: 2px 7px;
      border-radius: 5px;
      background: var(--outline);
      color: var(--accent-text);
      font: 500 11.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tag .size { opacity: 0.75; margin-left: 6px; }
    .tag .source { opacity: 0.9; margin-left: 6px; padding-left: 6px; border-left: 1px solid color-mix(in srgb, currentColor 35%, transparent); }
    .tag .hint-word { font-family: system-ui, -apple-system, sans-serif; font-weight: 650; margin-right: 6px; }
    .outline.adding { border-style: dashed; }

    /* Selected text under the pointer while ⌥ is held, and the drag box */
    .text-mark, .mark.kind-text {
      position: fixed;
      border-radius: 2px;
      background: color-mix(in srgb, var(--outline) 22%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--outline) 55%, transparent);
    }
    .area-box {
      position: fixed;
      border: 1.5px dashed var(--outline);
      border-radius: 3px;
      background: color-mix(in srgb, var(--outline) 10%, transparent);
    }
    .area-box.dragging { box-shadow: 0 0 0 9999px rgb(16 24 40 / 0.08); }

    /* Marks: what an open composer or card points at, numbered */
    .marks { position: fixed; inset: 0; pointer-events: none; }
    .mark { position: fixed; border-radius: 4px; transition: opacity 120ms ease; animation: fade 140ms ease-out; }
    .mark.kind-element { border: 2px solid var(--outline); background: color-mix(in srgb, var(--outline) 5%, transparent); }
    .mark.kind-inside { border: 1.5px dashed color-mix(in srgb, var(--outline) 55%, transparent); }
    .mark.kind-area { border: 1.5px dashed var(--outline); border-radius: 3px; background: color-mix(in srgb, var(--outline) 10%, transparent); }
    .mark-number {
      position: absolute;
      top: -9px;
      left: -9px;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      display: grid;
      place-items: center;
      border: 2px solid var(--bg);
      border-radius: 9px;
      background: var(--outline);
      color: var(--accent-text);
      font: 700 10.5px/1 system-ui, -apple-system, sans-serif;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
    }
    .mark.kind-inside .mark-number { background: var(--bg); color: var(--outline); border-color: color-mix(in srgb, var(--outline) 55%, transparent); }

    /* The composer's list of what it points at */
    .picked { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; max-height: 168px; overflow: auto; overscroll-behavior: contain; }
    .picked li { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .picked .n {
      flex: none;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      background: var(--outline);
      color: var(--accent-text);
      font: 700 10.5px/1 system-ui, -apple-system, sans-serif;
      font-variant-numeric: tabular-nums;
    }
    .picked .what { min-width: 0; flex: 1; color: var(--muted); font: 11.5px/1.6 ui-monospace, "SF Mono", Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .picked .remove {
      flex: none;
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--muted);
      font: 15px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    .picked .remove:hover { background: var(--surface); color: var(--text); }
    .picked .remove:focus-visible { outline: 2px solid var(--outline); outline-offset: 1px; }
    .selection-quote {
      margin: 0;
      padding: 6px 10px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--outline) 9%, var(--bg));
      color: var(--text);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .pointed-at { display: grid; gap: 8px; }
    .pointed { margin: 0; color: var(--muted); font-size: 12px; }
    .pointed code { font: 11.5px ui-monospace, "SF Mono", Menlo, monospace; color: var(--text); }
    .tip { margin: 0; color: var(--muted); font-size: 11.5px; }

    /* Pins */
    .pin {
      position: fixed;
      width: 24px;
      height: 24px;
      margin: -24px 0 0 0; /* the pointed corner, bottom left, sits on the click point */
      transform-origin: 0 100%;
      display: grid;
      place-items: center;
      border: 2px solid var(--bg);
      border-radius: 50% 50% 50% 4px;
      background: var(--tone, var(--tone-sent));
      color: var(--on-tone, var(--on-sent));
      font: 650 11px/1 system-ui, -apple-system, sans-serif;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 1px 3px rgb(0 0 0 / 0.3), 0 0 0 1px rgb(0 0 0 / 0.06);
      cursor: pointer;
      pointer-events: auto;
      transition: transform 120ms ease, opacity 120ms ease, background-color 200ms ease;
    }
    .pin:hover { transform: scale(1.12); }
    .pin:focus-visible { outline: 2px solid var(--outline); outline-offset: 2px; }
    .pin.open { transform: scale(1.12); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 35%, transparent), 0 1px 3px rgb(0 0 0 / 0.3); }
    .pin.working::after {
      content: "";
      position: absolute;
      inset: -6px;
      border-radius: inherit;
      border: 2px solid var(--tone);
      opacity: 0;
      animation: ripple 1.6s ease-out infinite;
    }
    .picking .pin { opacity: 0.3; pointer-events: none; }

    /* The composer and the card share one panel */
    .panel {
      position: fixed;
      width: 320px;
      max-width: calc(100vw - 16px);
      display: grid;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--bg);
      color: var(--text);
      box-shadow: var(--shadow);
      pointer-events: auto;
      animation: rise 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
      /* A card taller than the viewport scrolls inside it, never off it. */
      max-height: calc(100vh - 16px);
      overflow: auto;
      overscroll-behavior: contain;
    }
    .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title { font-weight: 650; font-size: 13px; }
    .chip {
      min-width: 0;
      padding: 1px 7px;
      border-radius: 5px;
      background: var(--surface);
      color: var(--muted);
      font: 11.5px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .close {
      margin-left: auto;
      flex: none;
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font: 18px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    .close:hover { background: var(--surface); color: var(--text); }
    .close:focus-visible, .send:focus-visible { outline: 2px solid var(--outline); outline-offset: 1px; }
    textarea {
      width: 100%;
      min-height: 64px;
      max-height: 240px;
      resize: none;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      field-sizing: content;
    }
    textarea::placeholder { color: var(--muted); }
    textarea:focus { outline: none; border-color: var(--accent); background: var(--bg); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
    .foot { display: flex; align-items: center; gap: 8px; }
    .hint { color: var(--muted); font-size: 11.5px; }
    kbd { font: inherit; padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; }
    .send {
      margin-left: auto;
      padding: 6px 14px;
      border: 0;
      border-radius: 7px;
      background: var(--accent);
      color: var(--accent-text);
      font: 600 12.5px/1.3 system-ui, -apple-system, sans-serif;
      cursor: pointer;
      transition: opacity 120ms ease, filter 120ms ease;
    }
    .send:hover:not(:disabled) { filter: brightness(1.08); }
    .send:disabled { opacity: 0.45; cursor: default; }
    .error { color: var(--danger); font-size: 12px; }

    .status { display: flex; align-items: center; gap: 8px; font-weight: 550; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--tone); transition: background-color 200ms ease; }
    .status.working .dot { animation: pulse 1.4s ease-in-out infinite; }
    /* Claude hasn't picked it up: two lines, the dot on the first */
    .status.unanswered { align-items: flex-start; text-wrap: pretty; }
    .status.unanswered .dot { margin-top: 0.42em; }
    .retry { display: flex; align-items: center; gap: 8px; animation: rise 140ms cubic-bezier(0.2, 0.8, 0.2, 1); }    .request {
      margin: 0;
      padding-left: 10px;
      border-left: 2px solid var(--line);
      color: var(--muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 160px;
      overflow: auto;
    }
    /* The conversation after the request */
    .thread { display: grid; gap: 8px; max-height: 280px; overflow: auto; overscroll-behavior: contain; border-radius: 6px; }
    .thread:focus-visible { outline: 2px solid var(--outline); outline-offset: 2px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .entry { display: grid; gap: 2px; }
    .entry-label { color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .entry-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .entry.kind-question {
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--question-surface);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone-question) 28%, transparent);
    }
    .entry.kind-question .entry-label { color: var(--question-text); }
    .entry.kind-reply { padding-left: 10px; border-left: 2px solid var(--line); }
    .entry.kind-reply .entry-text, .entry.kind-plan .entry-text { color: var(--muted); }
    .entry.kind-reason .entry-label { color: var(--tone-ended); }
    /* What the tweak changed */
    .change { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid var(--line); max-height: 200px; overflow: auto; overscroll-behavior: contain; }
    .change:focus-visible { outline: 2px solid var(--outline); outline-offset: 2px; }
    .change .files { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }
    .change .file { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
    .change .path { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; min-width: 0; }
    .change .where {
      padding: 0 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
      white-space: nowrap;
    }
    .change .unrecorded { display: grid; gap: 3px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
    .change .note { margin: 0; color: var(--muted); font-size: 12px; }
    .change-unchanged .entry-label, .change-nothing-recorded .entry-label { text-transform: none; letter-spacing: 0; font-size: 12.5px; font-weight: 550; }
    .answer { display: grid; gap: 8px; animation: rise 140ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    .answer textarea { min-height: 52px; }

    .tone-sent { --tone: var(--tone-sent); --on-tone: var(--on-sent); }
    .tone-working { --tone: var(--tone-working); --on-tone: var(--on-working); }
    .tone-question { --tone: var(--tone-question); --on-tone: var(--on-question); }
    .tone-done { --tone: var(--tone-done); --on-tone: var(--on-done); }
    .tone-ended { --tone: var(--tone-ended); --on-tone: var(--on-ended); }

    @keyframes rise { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
    @keyframes fade { from { opacity: 0; } }
    @keyframes pulse { 50% { opacity: 0.35; } }
    @keyframes ripple { 0% { opacity: 0.6; transform: scale(0.8); } 100% { opacity: 0; transform: scale(1.4); } }
    @media (prefers-reduced-motion: reduce) {
      *, *::after { animation: none !important; transition: none !important; }
    }
  `;

  // Keys typed in the overlay stay in it, so the page's shortcuts don't fire.
  const KEY_EVENTS = ["keydown", "keyup", "keypress", "input", "beforeinput"];

  // Layering (design.md § Overlay layering). The host is a manual popover, so
  // it's in the top layer, above anything the page's z-index can do. A modal
  // dialog makes everything outside it inert, top layer included, so while
  // one is open the host lives inside the topmost one, and moves back when
  // it closes. Whenever the page puts something new in the top layer (its
  // own popovers, a dialog), the host is shown again, so it's on top.
  const layer = (() => {
    const modals = []; // the open modal dialogs, in the order they opened
    let queued = false;
    let raise = false;

    // opened puts a dialog that has just become modal on top. The observer's
    // records come in the order the page called showModal, so they decide.
    function opened(d) {
      if (!d.matches(":modal")) return;
      const i = modals.indexOf(d);
      if (i >= 0) modals.splice(i, 1);
      modals.push(d);
    }

    // home is where the host belongs: the topmost open modal dialog, or the
    // document. Modals found only here (open before this script ran) are
    // taken in document order, which is the best guess.
    function home() {
      for (let i = modals.length - 1; i >= 0; i--) if (!modals[i].isConnected || !modals[i].matches(":modal")) modals.splice(i, 1);
      for (const d of document.querySelectorAll("dialog:modal")) if (!modals.includes(d)) modals.push(d);
      return modals.at(-1) ?? document.documentElement;
    }

    // place moves the host home if it isn't there, and shows it again when
    // it moved (a move takes it out of the top layer) or when asked to.
    function place(again) {
      const { host, root } = ns.overlay;
      if (!host) return;
      const to = home();
      const moved = host.parentNode !== to;
      if (!moved && !again && host.matches(":popover-open")) return;
      const focused = root.activeElement; // a move or a hide takes the focus away
      if (moved) to.append(host);
      try {
        if (host.matches(":popover-open")) host.hidePopover();
        host.showPopover();
      } catch {
        // Not in the top layer; the page's stacking may cover it.
      }
      if (focused?.isConnected && root.activeElement !== focused) focused.focus({ preventScroll: true });
    }

    // Everything waits for a microtask, so a burst of changes moves the host
    // once, after the page's own call has finished, and before the paint.
    function soon(again = false) {
      raise ||= again;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const r = raise;
        raise = false;
        place(r);
      });
    }

    // toggle fires for popovers and dialogs (it doesn't bubble, so it's
    // heard in the capture phase); the host's own are ignored.
    const onToggle = (e) => {
      if (e.target !== ns.overlay.host) soon(e.newState === "open");
    };
    // The fallback: a dialog's open attribute changes as showModal and close
    // run, and the page may remove the dialog the host is in, or the host.
    const observer = new MutationObserver((records) => {
      let dialog = false;
      for (const r of records) {
        if (r.type !== "attributes" || r.target.localName !== "dialog") continue;
        dialog = true;
        if (r.target.hasAttribute("open")) opened(r.target);
      }
      if (dialog ||!ns.overlay.host?.isConnected || modals.some((d) => !d.isConnected)) soon();
    });

    return {
      start() {
        place(true);
        document.addEventListener("toggle", onToggle, true);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
      },
      stop() {
        document.removeEventListener("toggle", onToggle, true);
        observer.disconnect();
        modals.length = 0;
      },
    };
  })();

  ns.overlay = {
    host: null,
    root: null,
    attach() {
      if (this.host?.isConnected) return;
      const host = document.createElement("codaset-tweak");
      host.setAttribute("popover", "manual");
      const root = host.attachShadow({ mode: "closed" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      root.adoptedStyleSheets = [sheet];
      for (const type of KEY_EVENTS) root.addEventListener(type, (e) => e.stopPropagation());
      this.host = host;
      this.root = root;
      layer.start();
    },
    detach() {
      layer.stop();
      this.host?.remove();
      this.host = this.root = null;
    },
    // el makes an element in the overlay; text is set as text, never HTML.
    el(tag, className = "", text = "") {
      const e = document.createElement(tag);
      if (className) e.className = className;
      if (text) e.textContent = text;
      return e;
    },
    // contains says whether an event came from inside the overlay.
    contains(e) {
      return Boolean(this.host) && e.composedPath().includes(this.host);
    },
  };
  ns.teardowns.push(() => ns.overlay.detach());
})();
