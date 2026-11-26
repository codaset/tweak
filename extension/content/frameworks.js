// The framework mappers (docs/design.md, "Finding the source"): thin stubs
// that ask the page probe (probe.js, in the page's own world) about an
// element, then turn what it gives into locations. They go ahead of the DOM
// mappers in mappers.js, in priority order: React, Vue, Svelte.
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

  const named = (n) => (typeof n === "string" && n ? n : undefined);
  const file = (f) => (typeof f === "string" && f.trim() ? f : undefined);

  // Vue gives files only (type.__file has no line): the element's is the
  // component whose template wrote it, and the brief says to search it for
  // the element's clues. The components it's rendered inside follow, named.
  const vue = {
    via: "vue",
    map: async (el) => {
      const found = ask(el, "vue");
      const components = Array.isArray(found?.components) ? found.components.filter((c) => c && typeof c === "object") : [];
      const out = [];
      if (file(components[0]?.file)) out.push({ file: components[0].file, role: "element", via: "vue" });
      for (const c of components) {
        if (file(c.file)) out.push(clean({ file: c.file, role: "component", via: "vue", name: named(c.name) }));
      }
      return out;
    },
  };

  // spot is a Svelte position as a location's {file, line?, column?}:
  // lines 1-based (Svelte 4's are 0-based, so `zero` adds one), columns
  // 0-based in both, so one is added.
  function spot(p, zero) {
    if (!p || !file(p.file)) return null;
    const line = Number.isInteger(p.line) ? p.line + (zero ? 1 : 0) : undefined;
    const column = Number.isInteger(p.column) && count(line) ? p.column + 1 : undefined;
    return { file: p.file, line: count(line), column: count(column) };
  }

  // Svelte gives the element's own tag, and in Svelte 5 where each
  // component it's inside is used (its parents of type component, named by
  // their tag). Blocks between (if, each, snippets) and components in
  // node_modules (SvelteKit's root and layout) are left out.
  const svelte = {
    via: "svelte",
    map: async (el) => {
      const found = ask(el, "svelte");
      if (!found || typeof found !== "object") return [];
      const own = spot(found.loc, typeof found.loc?.char === "number");
      const out = [];
      if (own) out.push(clean({ ...own, role: "element", via: "svelte" }));
      for (const p of Array.isArray(found.parents) ? found.parents : []) {
        if (!p || (p.type !== undefined && p.type !== "component") || /(^|\/)node_modules\//.test(p.file ?? "")) continue;
        const used = spot(p, false);
        if (used) out.push(clean({ ...used, role: "usage", via: "svelte", name: named(p.name) }));
      }
      return out;
    },
  };

  ns.frameworks = { ask, react, vue, svelte, mappers: [react, vue, svelte] };
})();
