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
    .request {
      margin: 0;
      padding-left: 10px;
      border-left: 2px solid var(--line);
      color: var(--muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 160px;
      overflow: auto;
    }
    .summary { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .summary-label { color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }

    .tone-sent { --tone: var(--tone-sent); --on-tone: var(--on-sent); }
    .tone-working { --tone: var(--tone-working); --on-tone: var(--on-working); }
    .tone-question { --tone: var(--tone-question); --on-tone: var(--on-question); }
    .tone-done { --tone: var(--tone-done); --on-tone: var(--on-done); }
    .tone-ended { --tone: var(--tone-ended); --on-tone: var(--on-ended); }

    @keyframes rise { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
    @keyframes pulse { 50% { opacity: 0.35; } }
    @keyframes ripple { 0% { opacity: 0.6; transform: scale(0.8); } 100% { opacity: 0; transform: scale(1.4); } }
    @media (prefers-reduced-motion: reduce) {
      *, *::after { animation: none !important; transition: none !important; }
    }
  `;

  // Keys typed in the overlay stay in it, so the page's shortcuts don't fire.
  const KEY_EVENTS = ["keydown", "keyup", "keypress", "input", "beforeinput"];

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
      document.documentElement.append(host);
      try {
        host.showPopover();
      } catch {
        // Not in the top layer; the page's stacking may cover it.
      }
      this.host = host;
      this.root = root;
    },
    detach() {
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
