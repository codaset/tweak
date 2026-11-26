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
// no sheet or source-map fetches, only what is cached) and rules (the
// element's gathered CSS rules, whose lines the CSS rules mapper fills in).
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const TIMEOUT = 300;
  const ROLES = new Set(["element", "component", "usage", "style"]);

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

  // comments walks the page's comments from el: back (nearest first) or on.
  function* comments(el, back) {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    walker.currentNode = el;
    for (let node; (node = back ? walker.previousNode() : walker.nextNode()); ) yield node.data;
  }

  // suggestions are the optional improvements this page could use, for the
  // side panel (design.md, Optional improvements): a Rails page (its CSRF
  // meta tag names Rails' authenticity_token) with no template annotations.
  function suggestions() {
    const isRails = document.querySelector('meta[name="csrf-param"][content="authenticity_token"]');
    if (!isRails) return [];
    for (const comment of comments(document.documentElement, false)) if (annotation(comment)) return [];
    for (const comment of comments(document.documentElement, true)) if (annotation(comment)) return [];
    return ["rails-annotations"];
  }

  const rails = {
    via: "rails",
    map: async (el) => templates(comments(el, true), comments(el, false)).map((file) => ({ file, role: "component", via: "rails" })),
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
  function modules(classNames, sheets) {
    const out = [];
    for (const name of classNames) {
      const m = MODULE_CLASS.exec(name);
      if (!m) continue;
      const [, hash, want] = m;
      const sheet = sheets.find((s) => s.id === `_${hash}`) ?? sheets.find((s) => suffix(pathOf(s.url).slice(1)) === want);
      const file = sheet && pathOf(sheet.url);
      if (file && !out.includes(file)) out.push(file);
    }
    return out;
  }

  const proscenium = {
    via: "proscenium",
    map: async (el) => {
      const sheets = [...document.querySelectorAll('link[rel~="stylesheet"][href], style[data-href]')].map((node) => ({
        url: node.localName === "link" ? node.href : node.dataset.href,
        id: node.id,
      }));
      return modules([...el.classList], sheets).map((file) => ({ file, role: "style", via: "proscenium" }));
    },
  };

  // ---- CSS rules: the matching rules, with a line through the sheet's source map ----

  // squash is a selector as compared: whitespace runs as one space, none
  // around combinators and commas.
  const squash = (s) => s.replace(/\s+/g, " ").replace(/ ?([>+~,]) ?/g, "$1").trim();

  // prelude finds a selector in a sheet's text as a whole rule prelude (the
  // text before a {), skipping comments and strings: its 0-based line and
  // column, or null when it is there other than once.
  function prelude(text, selector) {
    const want = squash(selector);
    let found = null;
    let count = 0;
    let start = 0;
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
      if (c === "{" || c === "}" || c === ";") {
        if (c === "{") {
          const raw = text.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
          if (squash(raw) === want) {
            count++;
            found = start + (raw.length - raw.trimStart().length);
          }
        }
        start = i + 1;
      }
    }
    if (count !== 1) return null;
    const before = text.slice(0, found);
    const line = before.split("\n").length - 1;
    return { line, column: found - (before.lastIndexOf("\n") + 1) };
  }

  // Served sheets' text by URL, fetched once: {loading, text}.
  const sheets = new Map();

  // sheetText is a sheet's text: a <style>'s own, or its URL's, fetched
  // (or, without fetch, only if fetched before).
  async function sheetText(sheet, fetching) {
    if (!sheet.href) return sheet.ownerNode?.textContent ?? "";
    let entry = sheets.get(sheet.href);
    if (!fetching) return entry?.text ?? "";
    if (!entry) {
      entry = { text: "" };
      entry.loading = fetch(sheet.href, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
        .then((text) => (entry.text = text))
        .catch(() => (sheets.delete(sheet.href), ""));
      sheets.set(sheet.href, entry);
    }
    return entry.loading;
  }

  // line gives a gathered rule its source's file, line and column, when the
  // sheet has a source map and the rule's selector is in it once.
  async function line(rule, fetching) {
    const { sheet, selector } = rule.source ?? {};
    if (!sheet) return null;
    const text = await sheetText(sheet, fetching);
    const map = text && (await ns.sourcemap.forText(text, sheet.href ?? location.href, { fetch: fetching }));
    const at = map && prelude(text, selector);
    const found = at && ns.sourcemap.lookup(map, at.line, at.column);
    if (!found) return null;
    Object.assign(rule, { file: found.source, line: found.line, column: found.column });
    return { file: found.source, line: found.line, column: found.column, role: "style", via: "css" };
  }

  const css = {
    via: "css",
    map: async (el, { fetch: fetching = true, rules } = {}) => {
      const lines = await Promise.all((rules ?? ns.context.rules(el)).map((rule) => line(rule, fetching)));
      return lines.filter(Boolean);
    },
  };

  // ---- Running them ----

  // MAPPERS in priority order; the framework mappers go first.
  const MAPPERS = [rails, proscenium, css];

  const valid = (l) => l && typeof l.file === "string" && l.file.trim() !== "" && ROLES.has(l.role) && typeof l.via === "string";

  // within is a mapper's result, or nothing if it fails or takes too long.
  function within(mapper, el, options) {
    let timer;
    const late = new Promise((done) => (timer = setTimeout(() => done([]), TIMEOUT)));
    const result = Promise.resolve()
      .then(() => mapper.map(el, options))
      .then((ls) => (Array.isArray(ls) ? ls.filter(valid) : []), () => []);
    return Promise.race([result, late]).finally(() => clearTimeout(timer));
  }

  // run is every mapper's locations for el, one mapper after another in
  // priority order, each innermost first.
  async function run(el, { mappers = MAPPERS, ...options } = {}) {
    const results = await Promise.all(mappers.map((m) => within(m, el, options)));
    return results.flat();
  }

  ns.mappers = { run, templates, modules, prelude, suggestions };
})();
