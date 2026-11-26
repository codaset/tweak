// The page probe, in the page's own world, at document_start: it never draws
// anything (docs/design.md, "Finding the source", The interface). The
// content script dispatches a bubbling, composed `tweak:probe` CustomEvent
// on the element itself, its detail a JSON string {id, what}; the probe
// hears it on document, reads the element, and answers at once with
// `tweak:probe-result` on document, its detail a JSON string {id, [what]}
// (null when it finds nothing). Strings, because objects don't cross worlds;
// never attributes written onto the page. The page can see and spoof this
// traffic; the answers are only data describing elements.
//
// It reads framework metadata only: source maps are fetched and decoded by
// the content script.
(() => {
  const GUARD = Symbol.for("codaset-tweak.probe");
  if (window[GUARD]) return; // registration and executeScript can both run it
  Object.defineProperty(window, GUARD, { value: true });

  // ---- React: fibers on the element (__reactFiber$<random>) ----

  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    return key ? el[key] : null;
  };

  const nameOf = (type) => {
    if (!type || typeof type === "string") return undefined;
    const name = type.displayName || type.name || type.render?.displayName || type.render?.name || type.type?.displayName || type.type?.name;
    return typeof name === "string" && name ? name : undefined;
  };

  // FRAME is one frame of a V8 stack: "at fn (url:line:col)" or
  // "at url:line:col".
  const FRAME = /^\s*at\s+(?:.*?\s+\()?(\S+?):(\d+):(\d+)\)?\s*$/;

  // frame is React 19's frame 1 of _debugStack: frame 0 is React's own
  // jsxDEV (or createElement), and frame 1 is the JSX call site in the
  // served module, {url, line, column} as the engine gives them (1-based).
  function frame(stack) {
    if (typeof stack !== "string") return null;
    const frames = [];
    for (const line of stack.split("\n")) {
      const m = FRAME.exec(line);
      if (m) frames.push({ url: m[1], line: Number(m[2]), column: Number(m[3]) });
    }
    return frames[1] ?? null;
  }

  // position is where a fiber's JSX is written: React 18's _debugSource
  // {file, line, column}, or React 19's frame {url, line, column}.
  function position(fiber) {
    const s = fiber?._debugSource;
    if (s && typeof s.fileName === "string") return { file: s.fileName, line: s.lineNumber, column: s.columnNumber };
    return frame(fiber?._debugStack?.stack);
  }

  // react is the element's position and the components it's rendered
  // inside, innermost first: each owner (the component whose render wrote
  // the JSX) with the position, in its own file, of the JSX on the way to
  // the element. Children passed through another component stay with the
  // component that wrote them.
  function react(el) {
    const fiber = fiberOf(el);
    if (!fiber) return null;
    const element = position(fiber);
    const components = [];
    let at = element;
    const seen = new Set();
    for (let owner = fiber._debugOwner; owner && !seen.has(owner) && components.length < 20; owner = owner._debugOwner) {
      seen.add(owner);
      const name = nameOf(owner.type) ?? (typeof owner.name === "string" ? owner.name : undefined);
      if (at) components.push({ ...at, ...(name && { name }) });
      at = position(owner);
    }
    return { element, components };
  }

  // ---- Vue 3: the component instance on the element ----

  const text = (v) => (typeof v === "string" && v ? v : undefined);

  // vue is the components the element is rendered inside, innermost first,
  // each {file?, name?}: its type's __file (an absolute path, set by
  // plugin-vue in dev) and name. The first is the one whose template wrote
  // the element: the vnode's ctx, which for slot content is the component
  // that wrote the slot, not the one rendering it (__vueParentComponent).
  function vue(el) {
    const first = el.__vnode?.ctx ?? el.__vueParentComponent;
    if (!first || typeof first !== "object") return null;
    const components = [];
    const seen = new Set();
    for (let c = first; c && typeof c === "object" && !seen.has(c) && components.length < 20; c = c.parent) {
      seen.add(c);
      const type = c.type ?? {};
      components.push({ file: text(type.__file), name: text(type.__name) ?? text(type.name) });
    }
    return { components };
  }

  // ---- Svelte: __svelte_meta on the element ----

  const written = (p) => ({ file: text(p?.file), line: p?.line, column: p?.column });

  // svelte is the element's loc as Svelte gives it ({file, line, column},
  // plus char in Svelte 4, whose lines are 0-based), and in Svelte 5 its
  // parents, innermost first: each block or component it's inside, with
  // where it is written ({type, file, line, column, name}). They're copied:
  // the page's are circular.
  function svelte(el) {
    const meta = el.__svelte_meta;
    if (!meta?.loc || typeof meta.loc !== "object") return null;
    const loc = written(meta.loc);
    if (typeof meta.loc.char === "number") loc.char = meta.loc.char;
    if (!("parent" in meta)) return { loc };
    const parents = [];
    const seen = new Set();
    for (let p = meta.parent; p && typeof p === "object" && !seen.has(p) && parents.length < 50; p = p.parent) {
      seen.add(p);
      parents.push({ type: text(p.type), ...written(p), name: text(p.componentTag) });
    }
    return { loc, parents };
  }

  const READERS = { react, vue, svelte };

  document.addEventListener("tweak:probe", (e) => {
    let q;
    try {
      q = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!q || typeof q.id !== "string") return;
    const read = Object.hasOwn(READERS, q.what) ? READERS[q.what] : null;
    let found = null;
    try {
      // The element itself, inside a shadow root too (the event is composed).
      found = read ? read(e.composedPath()[0] ?? e.target) : null;
    } catch {}
    const body = { id: q.id };
    if (read) body[q.what] = found;
    document.dispatchEvent(new CustomEvent("tweak:probe-result", { detail: JSON.stringify(body) }));
  });

  // ---- HMR signals ----
  // On a Vite page (one that loads /@vite/client) the probe opens a hot
  // context of its own and tells the content script of each hot update
  // with tweak:updated on document, so no reload follows one (design.md,
  // "Reloading after a change"). It imports the client from the very URL
  // the page did, so it shares the page's HMR client rather than starting
  // another. The probe runs before the page's scripts exist, so it looks
  // once the HTML has been read.
  function hot() {
    const client = [...(document.scripts ?? [])].find((s) => s.type === "module" && /\/@vite\/client(?:[?#]|$)/.test(s.src));
    if (!client) return;
    import(client.src)
      .then((vite) => {
        const context = vite.createHotContext?.("/@codaset-tweak/probe");
        context?.on("vite:afterUpdate", () => document.dispatchEvent(new CustomEvent("tweak:updated", { detail: JSON.stringify({ via: "vite" }) })));
      })
      .catch(() => {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hot, { once: true });
  else hot();
})();
