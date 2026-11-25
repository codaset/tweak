// The overlay host: one element holding a closed shadow root with its own
// styles, so the page can't reach in and nothing is added to the page's CSS.
// The picker, pins and card are drawn inside it (later).
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      pointer-events: none;
      contain: strict;
    }
  `;

  ns.overlay = {
    host: null,
    root: null,
    attach() {
      if (this.host?.isConnected) return;
      const host = document.createElement("codaset-tweak");
      const root = host.attachShadow({ mode: "closed" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      root.adoptedStyleSheets = [sheet];
      document.documentElement.append(host);
      this.host = host;
      this.root = root;
    },
    detach() {
      this.host?.remove();
      this.host = this.root = null;
    },
  };
  ns.teardowns.push(() => ns.overlay.detach());
})();
