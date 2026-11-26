// Toasts: one short line at the bottom of the page, drawn in the overlay's
// closed shadow root. ns.toast(text) shows one; it leaves by itself.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const SHOW_MS = 4000;
  const STYLE = `
    .toasts {
      position: fixed;
      inset: auto 0 24px 0;
      display: grid;
      justify-items: center;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      max-width: min(420px, calc(100vw - 32px));
      padding: 10px 16px;
      border-radius: 10px;
      background: #1f2328;
      color: #f6f7f9;
      font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: -0.005em;
      box-shadow: 0 1px 2px rgb(0 0 0 / 0.2), 0 8px 24px rgb(0 0 0 / 0.18);
      opacity: 0;
      translate: 0 8px;
      transition: opacity 180ms ease-out, translate 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .toast.shown {
      opacity: 1;
      translate: 0 0;
    }
    @media (prefers-color-scheme: dark) {
      .toast {
        background: #e7e9ec;
        color: #1b1d21;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast {
        transition: opacity 120ms linear;
        translate: none;
      }
    }
  `;

  let stack = null;
  const timers = new Set();

  ns.toast = (text) => {
    const root = ns.overlay.root;
    if (!root) return;
    if (!stack?.isConnected) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      stack = document.createElement("div");
      stack.className = "toasts";
      stack.setAttribute("role", "status");
      stack.setAttribute("aria-live", "polite");
      root.append(stack);
    }
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    stack.append(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("shown")));
    const t = setTimeout(() => {
      timers.delete(t);
      el.classList.remove("shown");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400); // no transition ran (hidden tab)
    }, SHOW_MS);
    timers.add(t);
  };
  ns.teardowns.push(() => {
    for (const t of timers) clearTimeout(t);
    stack?.remove();
  });
})();
