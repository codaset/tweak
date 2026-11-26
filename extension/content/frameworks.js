// The framework mappers (docs/design.md, "Finding the source"): thin stubs
// that ask the page probe (probe.js, in the page's own world) about an
// element, then turn what it gives into locations. They go ahead of the DOM
// mappers in mappers.js. Vue and Svelte join `mappers` here later.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  let asked = 0;

  // ask dispatches tweak:probe on the element and gives the probe's answer
  // to `what`, or null. Dispatch is synchronous across worlds, so the probe
  // has answered by the time dispatchEvent returns; no answer means no
  // probe in this page.
  function ask(el, what) {
    const id = `${Date.now().toString(36)}-${++asked}`;
    let answer = null;
    const hear = (e) => {
      try {
        const body = typeof e.detail === "string" ? JSON.parse(e.detail) : null;
        if (body?.id === id) answer = body[what] ?? null;
      } catch {}
    };
    document.addEventListener("tweak:probe-result", hear);
    try {
      el.dispatchEvent(new CustomEvent("tweak:probe", { bubbles: true, composed: true, detail: JSON.stringify({ id, what }) }));
    } finally {
      document.removeEventListener("tweak:probe-result", hear);
    }
    return answer;
  }

  const count = (n) => (Number.isInteger(n) && n > 0 ? n : undefined);

  // withoutQuery is a served module's URL as a file: Vite's ?v= and ?t= and
  // any hash dropped.
  const withoutQuery = (url) => url.replace(/[?#].*$/, "");

  // place turns a probe position into {file, line?, column?}: React 18's
  // file as given, or React 19's frame mapped through its module's source
  // map. A frame that can't be mapped (no map, or none loaded yet on a
  // hover) gives its module's file only: the served line isn't the source's.
  async function place(p, fetching) {
    if (!p || typeof p !== "object") return null;
    if (typeof p.file === "string") return { file: p.file, line: count(p.line), column: count(p.column) };
    if (typeof p.url !== "string" || !count(p.line) || !count(p.column)) return null;
    const map = await ns.sourcemap.forModule(p.url, { fetch: fetching }).catch(() => null);
    const found = map && ns.sourcemap.lookup(map, p.line - 1, p.column - 1);
    return found ? { file: found.source, line: found.line, column: found.column } : { file: withoutQuery(p.url) };
  }

  const clean = (l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));

  const react = {
    via: "react",
    map: async (el, { fetch: fetching = true } = {}) => {
      const found = ask(el, "react");
      if (!found || typeof found !== "object") return [];
      const components = Array.isArray(found.components) ? found.components : [];
      const [element, ...enclosing] = await Promise.all([found.element, ...components].map((p) => place(p, fetching)));
      const out = [];
      if (element) out.push(clean({ ...element, role: "element", via: "react" }));
      enclosing.forEach((at, i) => {
        const name = typeof components[i].name === "string" && components[i].name ? components[i].name : undefined;
        if (at) out.push(clean({ ...at, role: "component", via: "react", name }));
      });
      return out;
    },
  };

  ns.frameworks = { ask, react, mappers: [react] };
})();
