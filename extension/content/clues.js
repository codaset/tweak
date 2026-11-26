// Search clues (docs/design.md, "Finding the source", Search clues):
// always gathered, whatever the mappers find, at most 8 per element, in
// this order: test IDs, id, aria-label, placeholder, title, alt, the
// element's own visible text, unusual class names, and a link's href path.
// Within each kind (the four test IDs are one), clues unique on the page
// come first. Text that is only numbers or dates is skipped; a class on more
// than 10 elements, one that looks generated, and a Tailwind variant are
// left out. Each clue is {kind, value}, page text the bridge renders as
// data.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const CLUES = 8;
  const TEXT_CAP = 80;
  const COMMON = 10; // a class on more elements than this says little
  const TEST_IDS = ["data-testid", "data-test", "data-qa", "data-cy"];
  const ORDER = ["id", "aria-label", "placeholder", "title", "alt", "text", "class", "href"]; // after the test IDs
  const ATTRIBUTES = [...TEST_IDS, ...ORDER.slice(0, 5)];
  // Class names a build generates: CSS-module hashes (css-loader and Next's
  // `Name_local__hash`, Vite's `_local_hash_line`, Proscenium's
  // `local_<8 hex>_path-module`), emotion, styled-components and Svelte.
  const GENERATED = [/^css-/, /^sc-/, /^svelte-/, /__[A-Za-z0-9_-]{5,}$/, /_[0-9a-f]{8}_[A-Za-z0-9_-]+-module$/, /^_[\w-]+_[a-z0-9]{5}_\d+$/];
  // What's left of a date or number once its parts are taken out.
  const MONTHS = "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december";
  const DAYS = "mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday";
  const NOT_WORDS = new RegExp(`[\\d\\s.,:;/%$€£¥+\\-–—()#]|\\b(${MONTHS}|${DAYS}|am|pm|st|nd|rd|th)\\b`, "gi");

  function cut(s, n) {
    const cps = [...s];
    return cps.length > n ? `${cps.slice(0, n - 1).join("")}…` : s;
  }

  // numberOrDate is text with nothing to search for: 42, $19.99, 26 Nov
  // 2026. A date has a digit in it, so a lone "May" or "Sun" is a word.
  const numberOrDate = (text) => /\d/.test(text) && text.replace(NOT_WORDS, "") === "";

  const unusual = (name, count) => count <= COMMON && !/[:[]/.test(name) && !GENERATED.some((re) => re.test(name));

  // href is a link's path on the page's origin, or its whole URL elsewhere;
  // none for a link to the page itself or a fragment.
  function href(el, origin) {
    if (el.localName !== "a" || !el.href || (el.getAttribute("href") ?? "").startsWith("#")) return "";
    try {
      const url = new URL(el.href);
      if (url.origin !== origin) return url.href;
      return url.pathname === "/" ? "" : url.pathname;
    } catch {
      return "";
    }
  }

  // onPage is how many elements on the page carry a clue. The text and a
  // link's path are the element's own, not counted.
  function onPage(kind, value) {
    try {
      if (kind === "class") return document.getElementsByClassName(value).length;
      if (kind === "text" || kind === "href") return 1;
      return document.querySelectorAll(`[${kind}="${CSS.escape(value)}"]`).length;
    } catch {
      return 1;
    }
  }

  // candidates are el's clues of every kind, in order, before ordering
  // within a kind and the limit.
  function candidates(el, origin) {
    const out = [];
    const add = (kind, value) => {
      const v = (value ?? "").replace(/\s+/g, " ").trim();
      if (v) out.push({ kind, value: v });
    };
    for (const a of ATTRIBUTES) add(a, el.getAttribute(a));
    const text = ns.describe.text(el);
    if (text && !numberOrDate(text)) add("text", text);
    for (const name of el.classList) add("class", name);
    add("href", href(el, origin));
    return out;
  }

  // group is a clue's kind, by its place in the order (the test IDs are one).
  const group = (kind) => (TEST_IDS.includes(kind) ? 0 : ORDER.indexOf(kind) + 1);

  // of is el's search clues. count tells how many elements on the page
  // carry a clue.
  function of(el, { count = onPage, origin = location.origin } = {}) {
    return candidates(el, origin)
      .map((c, i) => ({ ...c, i, n: count(c.kind, c.value) }))
      .filter((c) => c.kind !== "class" || unusual(c.value, c.n))
      .sort((a, b) => group(a.kind) - group(b.kind) || (a.n !== 1) - (b.n !== 1) || a.i - b.i)
      .slice(0, CLUES)
      .map(({ kind, value }) => ({ kind, value: cut(value, TEXT_CAP) }));
  }

  ns.clues = { of };
})();
