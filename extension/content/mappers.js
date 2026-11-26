// The mappers (docs/design.md, "Finding the source"): each finds source
// locations for an element from one kind of clue. Every mapper is
// map(element, options) → Promise of locations, innermost first, each
// {file, line?, column?, role, via, name?}. All of them always run, each
// with 300 ms; one that fails or times out gives nothing, silently. The
// list is in priority order; merging, deduplication and the "rendered
// inside" chain are the brief's (internal/brief/where.go), so run() only
// puts the results one after another.
//
// These are the DOM mappers, which need no page code: Rails template
// comments, Proscenium CSS-module class names, and CSS rules (with a line
// where the sheet has a source map). The framework mappers, which ask the
// page probe, go ahead of them. Options: fetch (false for the hover label:
// no sheet or source-map fetches, only what has been read) and rules (the
// element's gathered CSS rules, so the CSSOM is walked once).
//
// What a hover repeats is cached: each document's annotation comments
// (until its comments change), and each sheet's text, source map and rule
// preludes (per sheet object, so a replaced sheet is read again).
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const TIMEOUT = 300;
  const ROLES = new Set(["element", "component", "usage", "style"]);

  // within is what a promise gives in TIMEOUT, or `none` (failures too).
  function within(promise, none) {
    let timer;
    const late = new Promise((done) => (timer = setTimeout(() => done(none), TIMEOUT)));
    return Promise.race([Promise.resolve(promise).catch(() => none), late]).finally(() => clearTimeout(timer));
  }

  // ---- Rails: <!-- BEGIN/END path --> from annotate_rendered_view_with_filenames ----

  const annotation = (comment) => /^\s*(BEGIN|END) (\S[^\n]*?)\s*$/.exec(comment);

  // templates are the files of the Rails templates around an element,
  // innermost first, from the comments before it (nearest first) and after
  // it (in order). Only balanced pairs count: a template closed before the
  // element is passed over, and one that never ends isn't one.
  function templates(before, after) {
    const closed = new Map(); // END seen walking back, not yet matched
    const open = [];
    for (const comment of before) {
      const m = annotation(comment);
      if (!m) continue;
      const [, kind, file] = m;
      if (kind === "END") closed.set(file, (closed.get(file) ?? 0) + 1);
      else if (closed.get(file)) closed.set(file, closed.get(file) - 1);
      else open.push(file);
    }
    if (!open.length) return [];
    const nested = new Map(); // BEGIN seen walking on, not yet ended
    const ended = new Map(); // the open templates' ENDs found
    let left = open.length;
    for (const comment of after) {
      const m = annotation(comment);
      if (!m) continue;
      const [, kind, file] = m;
      if (kind === "BEGIN") nested.set(file, (nested.get(file) ?? 0) + 1);
      else if (nested.get(file)) nested.set(file, nested.get(file) - 1);
      else if (open.includes(file)) {
        ended.set(file, (ended.get(file) ?? 0) + 1);
        if (--left === 0) break;
      }
    }
    // The innermost of a file's open templates end first.
    const kept = new Map();
    return open.filter((file) => {
      const n = (kept.get(file) ?? 0) + 1;
      kept.set(file, n);
      return n <= (ended.get(file) ?? 0);
    });
  }

  // A document's annotation comments, in document order, found in one walk
  // and kept until a comment is added, removed or changed.
  const indexes = new WeakMap();
  const watched = new WeakSet();

  function annotations(doc) {
    let list = indexes.get(doc);
    if (list) return list;
    list = [];
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
    for (let node; (node = walker.nextNode()); ) if (annotation(node.data)) list.push(node);
    indexes.set(doc, list);
    if (!watched.has(doc)) {
      watched.add(doc);
      const observer = new MutationObserver((records) => {
        const now = indexes.get(doc);
        if (now && records.some((r) => touchesComments(r, now))) indexes.delete(doc);
      });
      observer.observe(doc, { childList: true, subtree: true, characterData: true });
      ns.teardowns.push(() => observer.disconnect());
    }
    return list;
  }

  // touchesComments says whether a mutation may change the annotations: a
  // comment changed, added or removed, or an element brought in with
  // comments inside, or one taken out holding an indexed one.
  function touchesComments(record, list) {
    if (record.type === "characterData") return record.target.nodeType === Node.COMMENT_NODE;
    for (const node of record.addedNodes) {
      if (node.nodeType === Node.COMMENT_NODE) return true;
      if (node.nodeType === Node.ELEMENT_NODE && node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_COMMENT).nextNode()) return true;
    }
    for (const node of record.removedNodes) {
      if (node.nodeType === Node.COMMENT_NODE) return true;
      if (node.nodeType === Node.ELEMENT_NODE && list.some((c) => node.contains(c))) return true;
    }
    return false;
  }

  // around is el's annotation comments: before it (nearest first) and after
  // it (its own descendants first), found by a binary search of the index.
  function around(el) {
    const list = annotations(el.ownerDocument);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) lo = mid + 1;
      else hi = mid;
    }
    function* before() {
      for (let i = lo - 1; i >= 0; i--) yield list[i].data;
    }
    function* after() {
      for (let i = lo; i < list.length; i++) yield list[i].data;
    }
    return [before(), after()];
  }

  const rails = {
    via: "rails",
    map: async (el) => templates(...around(el)).map((file) => ({ file, role: "component", via: "rails" })),
  };

  // ---- Proscenium: CSS-module class names like title_<8 hex>_app-components-card-module ----

  const MODULE_CLASS = /^.+_([0-9a-f]{8})_([A-Za-z0-9_-]+-module)$/;

  // suffix is a module's path as Proscenium writes it into class names:
  // the extension dropped, / \ and . as -, any other odd character as _,
  // and a leading digit guarded.
  const suffix = (path) =>
    path.replace(/\.[^./]*$/, "").replace(/[/\\.]/g, "-").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^(?=\d)/, "_");

  const pathOf = (url) => {
    try {
      return new URL(url, "http://page.invalid").pathname;
    } catch {
      return "";
    }
  };

  // modules are the CSS modules an element's class names come from, found
  // among the sheets the page loaded ({url, id?}: a <link>'s href, or
  // Proscenium's own <style id="_<hash>" data-href>), as server paths.
  function modules(classNames, loaded) {
    const out = [];
    for (const name of classNames) {
      const m = MODULE_CLASS.exec(name);
      if (!m) continue;
      const [, hash, want] = m;
      const sheet = loaded.find((s) => s.id === `_${hash}`) ?? loaded.find((s) => suffix(pathOf(s.url).slice(1)) === want);
      const file = sheet && pathOf(sheet.url);
      if (file && !out.includes(file)) out.push(file);
    }
    return out;
  }

  const proscenium = {
    via: "proscenium",
    map: async (el) => {
      const loaded = [...document.querySelectorAll('link[rel~="stylesheet"][href], style[data-href]')].map((node) => ({
        url: node.localName === "link" ? node.href : node.dataset.href,
        id: node.id,
      }));
      return modules([...el.classList], loaded).map((file) => ({ file, role: "style", via: "proscenium" }));
    },
  };

  // ---- CSS rules: the matching rules, with a line through the sheet's source map ----

  // squash is a selector as compared: whitespace runs as one space, none
  // around combinators and commas.
  const squash = (s) => s.replace(/\s+/g, " ").replace(/ ?([>+~,]) ?/g, "$1").trim();

  // preludes indexes a sheet's text: each rule prelude (the text before a
  // {, comments and strings skipped), squashed, with how often it appears
  // and where it first starts, 0-based.
  function preludes(text) {
    const index = new Map();
    let start = 0;
    // at is a position's line and column; positions only move forward, so
    // the text is counted through once.
    let line = 0;
    let lineStart = 0;
    let counted = 0;
    const at = (pos) => {
      for (; counted < pos; counted++) {
        if (text[counted] === "\n") {
          line++;
          lineStart = counted + 1;
        }
      }
      return { line, column: pos - lineStart };
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      if (c === '"' || c === "'") {
        for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
        continue;
      }
      if (c !== "{" && c !== "}" && c !== ";") continue;
      if (c === "{") {
        const raw = text.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
        const key = squash(raw);
        const seen = index.get(key);
        if (seen) seen.count++;
        else index.set(key, { count: 1, ...at(start + (raw.length - raw.trimStart().length)) });
      }
      start = i + 1;
    }
    return index;
  }

  // prelude finds a selector in an indexed sheet's text: its 0-based line
  // and column, or null when it is there other than once.
  function prelude(index, selector) {
    if (typeof index === "string") index = preludes(index);
    const found = index.get(squash(selector));
    return found?.count === 1 ? { line: found.line, column: found.column } : null;
  }

  // Each sheet object's text, source map and prelude index:
  // {loading, text, map, index, done, fetched}. A dev server that replaces
  // a sheet (even at the same URL) gives a new sheet object, so it is read
  // again and its map reloaded.
  const sheetCache = new WeakMap();

  // read reads a sheet. Without fetch, a <style>'s own text and inline map
  // are read (an external map only if already loaded), and a <link>'s
  // nothing; a later read with fetch completes it.
  function read(sheet, fetching) {
    let entry = sheetCache.get(sheet);
    if (entry && (entry.fetched || !fetching)) return entry.loading;
    if (!fetching && sheet.href) return Promise.resolve({});
    entry = { done: false, fetched: fetching };
    entry.loading = (async () => {
      const text = sheet.href
        ? await fetch(sheet.href, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
        : sheet.ownerNode?.textContent ?? "";
      const map = text ? await ns.sourcemap.forText(text, sheet.href ?? location.href, { fetch: fetching, reload: fetching }) : null;
      // A map the sheet names that didn't load (a rebuild's 503) is tried
      // again on the next pick: the read isn't kept.
      if (!map && fetching && ns.sourcemap.mapURL(text)) sheetCache.delete(sheet);
      return Object.assign(entry, { text, map, index: map ? preludes(text) : null, done: true });
    })().catch(() => (sheetCache.delete(sheet), {})); // tried again on the next pick
    sheetCache.set(sheet, entry);
    return entry.loading;
  }

  // line is where a gathered rule's source is, {file, line, column}, when
  // its sheet has a source map and its selector is there once; else null.
  async function line(rule, fetching) {
    const { sheet, selector } = rule.source ?? {};
    if (!sheet) return null;
    const { map, index } = await read(sheet, fetching);
    const at = map && prelude(index, selector);
    const found = at && ns.sourcemap.lookup(map, at.line, at.column);
    return found ? { file: found.source, line: found.line, column: found.column } : null;
  }

  // ruleLines are the gathered rules' source lines, in their order (null
  // where there's none), within the timeout. The rules aren't changed.
  const ruleLines = (rules, { fetch: fetching = true } = {}) =>
    within(Promise.all(rules.map((rule) => line(rule, fetching).catch(() => null))), rules.map(() => null));

  const css = {
    via: "css",
    map: async (el, { fetch: fetching = true, rules } = {}) => {
      const lines = await ruleLines(rules ?? ns.context.rules(el), { fetch: fetching });
      return lines.filter(Boolean).map((at) => ({ ...at, role: "style", via: "css" }));
    },
  };

  // ---- Running them ----

  // MAPPERS in priority order; the framework mappers go first.
  const MAPPERS = [...(ns.frameworks?.mappers ?? []), rails, proscenium, css];

  const valid = (l) => l && typeof l.file === "string" && l.file.trim() !== "" && ROLES.has(l.role) && typeof l.via === "string";

  // run is every mapper's locations for el, one mapper after another in
  // priority order, each innermost first.
  async function run(el, { mappers = MAPPERS, ...options } = {}) {
    const results = await Promise.all(
      mappers.map((m) =>
        within(
          Promise.resolve().then(() => m.map(el, options)).then((ls) => (Array.isArray(ls) ? ls.filter(valid) : [])),
          [],
        ),
      ),
    );
    return results.flat();
  }

  ns.mappers = { run, ruleLines, annotations, templates, modules, preludes, prelude };
})();
