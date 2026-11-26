// The context per element (docs/design.md, "Context per element"), as a
// tweak's targets carry it (schema/create.json): label, selector and text
// (describe.js), its search clues (clues.js), accessibility role and name,
// size, key computed styles without defaults, matching CSS rules, nearby
// text and trimmed HTML; and the viewport once per tweak. Gathered at pick
// time, so it is what the developer was pointing at. Every string is page
// text: the bridge renders it as data. Then the mappers (mappers.js) add
// the source locations and rule lines, in the background: locate. The
// pure parts are tested in node.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // The styles read and the caps are the brief's too (internal/brief): a Go
  // test, TestContextAgreesWithTheBrief, checks the two sides agree.
  const STYLE_KEYS = [
    "display", "position", "font-family", "font-size", "font-weight", "line-height", "color",
    "background-color", "padding", "margin", "gap", "border", "border-radius", "box-shadow",
  ];
  const DEFAULTS = new Set(["", "none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)", "transparent"]);
  const SIDES = ["top", "right", "bottom", "left"];
  const STYLE_CAP = 120;
  const SELECTOR_CAP = 200;
  const HTML_CAP = 1600;
  const ATTR_CAP = 100;
  const LABEL_CAP = 60;
  const TEXT_CAP = 80;
  const RULES = 10;
  const NEARBY = 5;
  const NEARBY_LEVELS = 3; // the element's siblings, its parent's, and its grandparent's
  const UNSHOWN = new Set(["script", "style", "template", "noscript", "link", "meta"]);
  const CLONE_LIMIT = 300; // descendants; past this the HTML is the element's own tag

  // cut shortens s to n characters (code points), ending in … when longer.
  function cut(s, n) {
    const cps = [...s];
    return cps.length > n ? `${cps.slice(0, n - 1).join("")}…` : s;
  }

  const oneLine = (s) => s.replace(/\s+/g, " ").trim();

  // isDefault is a computed value that says nothing: none, normal, 0px,
  // transparent, and a static position or a border of no width.
  function isDefault(key, value) {
    if (DEFAULTS.has(value)) return true;
    if (key === "position") return value === "static";
    if (key === "border") return /^0px\b/.test(value) || /\bnone\b/.test(value);
    return false;
  }

  // styles are the key computed styles of a CSSStyleDeclaration, leaving out
  // defaults. Chrome gives no border shorthand when the sides differ; then
  // the sides that have one are listed.
  function styles(cs) {
    const out = {};
    for (const key of STYLE_KEYS) {
      let value = oneLine(cs.getPropertyValue(key));
      if (key === "border" && value === "") {
        value = SIDES.map((side) => [side, oneLine(cs.getPropertyValue(`border-${side}`))])
          .filter(([, v]) => !isDefault("border", v))
          .map(([side, v]) => `${side} ${v}`)
          .join(", ");
      }
      if (!isDefault(key, value)) out[key] = cut(value, STYLE_CAP);
    }
    return out;
  }

  // trimHTML puts HTML on as few characters as reads well: whitespace
  // between tags dropped, other runs collapsed, then capped.
  const trimHTML = (html) => cut(html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim(), HTML_CAP);

  // html is el's outer HTML, its long attribute values (SVG paths, data
  // URLs) shortened; a big subtree gives the element's own tag alone. It is
  // trimmed in an inert copy, a <template>'s contents, never in live nodes:
  // cloning would upgrade custom elements (running the page's code) and
  // start image fetches.
  function html(el) {
    const template = document.createElement("template");
    let copy;
    if (el.getElementsByTagName("*").length <= CLONE_LIMIT) {
      template.innerHTML = el.outerHTML;
      copy = template.content.firstElementChild;
    } else {
      copy = template.content.ownerDocument.createElementNS(el.namespaceURI, el.localName);
      for (const attr of el.attributes) copy.setAttribute(attr.name, attr.value);
      copy.textContent = "…";
    }
    if (!copy) return "";
    // The overlay host lives inside an open modal dialog: it isn't the page's.
    for (const host of copy.querySelectorAll("codaset-tweak")) host.remove();
    for (const node of [copy, ...copy.querySelectorAll("*")]) {
      for (const attr of [...node.attributes]) {
        if (attr.value.length > ATTR_CAP) node.setAttribute(attr.name, cut(attr.value, ATTR_CAP));
      }
    }
    return trimHTML(copy.outerHTML);
  }

  // Implicit ARIA roles for the common elements.
  const INPUT_ROLES = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox",
    radio: "radio", range: "slider", number: "spinbutton", search: "searchbox" };
  const TAG_ROLES = { button: "button", nav: "navigation", main: "main", aside: "complementary", ul: "list",
    ol: "list", li: "listitem", table: "table", tr: "row", td: "cell", th: "columnheader", select: "combobox",
    textarea: "textbox", dialog: "dialog", img: "img", form: "form", header: "banner", footer: "contentinfo",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    hr: "separator", progress: "progressbar", option: "option", fieldset: "group", summary: "button" };
  // Roles whose name comes from their content.
  const NAMED_BY_CONTENT = new Set(["button", "link", "heading", "listitem", "cell", "columnheader", "option",
    "tab", "menuitem", "checkbox", "radio", "switch", "row"]);

  function role(el) {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : "";
    if (tag === "input") return INPUT_ROLES[el.type] ?? (el.type === "hidden" ? "" : "textbox");
    return TAG_ROLES[tag] ?? "";
  }

  // name is the accessible name, simplified: aria-labelledby, aria-label,
  // a form control's label, alt, the content for roles named by it, then
  // title and placeholder.
  function name(el, r) {
    const text = (node) => oneLine(node?.innerText ?? node?.textContent ?? "");
    const ids = el.getAttribute("aria-labelledby");
    const parts = [
      ids && ids.split(/\s+/).map((id) => text(document.getElementById(id))).join(" "),
      el.getAttribute("aria-label"),
      el.labels?.length ? [...el.labels].map(text).join(" ") : "",
      el.localName === "img" || el.localName === "area" || el.type === "image" ? el.getAttribute("alt") : "",
      el.localName === "input" && ["button", "submit", "reset"].includes(el.type) ? el.value : "",
      NAMED_BY_CONTENT.has(r) ? text(el) : "",
      el.getAttribute("title"),
      el.getAttribute("placeholder"),
    ];
    const found = parts.map((p) => oneLine(p ?? "")).find(Boolean) ?? "";
    return cut(found, TEXT_CAP);
  }

  // sheetFile is where a stylesheet comes from: Vite's dev ID, or its URL.
  function sheetFile(sheet) {
    for (let s = sheet; s; s = s.parentStyleSheet) {
      const id = s.ownerNode?.getAttribute?.("data-vite-dev-id");
      if (id) return id;
      if (s.href) return s.href;
    }
    return "";
  }

  // nest is a nested rule's selector made absolute against its parent's
  // (CSS nesting): & is the parent; with no &, the rule is a descendant,
  // or follows its own leading combinator.
  // A list nests branch by branch: `> .a, > .b` is two relative selectors.
  function nest(selector, parent) {
    if (!parent) return selector;
    return branches(selector)
      .map((branch) => {
        if (branch.includes("&")) return branch.replaceAll("&", `:is(${parent})`);
        if (/^[>+~]/.test(branch)) return `:is(${parent}) ${branch}`;
        return `:is(${parent}) :is(${branch})`;
      })
      .join(", ");
  }

  // branches are a selector list's top-level selectors: commas inside
  // parentheses, brackets or strings don't split it.
  function branches(selector) {
    const out = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let i = 0; i < selector.length; i++) {
      const c = selector[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "\\") i++;
      else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "," && depth === 0) {
        out.push(selector.slice(start, i));
        start = i + 1;
      }
    }
    out.push(selector.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
  }

  // scopeRoot is the root an @scope rule styles el from: the nearest
  // ancestor (or el itself) matching its start, unless el is past the
  // scope's limit within it. It is null when el is outside the scope, and
  // undefined when the scope can't be told (an implicit scope, with no
  // start, or a selector we can't evaluate): then the rule is kept, still
  // shown inside its @scope.
  function scopeRoot(el, rule) {
    if (!rule.start) return undefined;
    try {
      const root = el.closest(rule.start);
      if (root && rule.end) {
        const limit = el.closest(rule.end);
        if (limit && limit !== root && root.contains(limit)) return null;
      }
      return root;
    } catch {
      return undefined;
    }
  }

  // matches says whether el matches a selector. Inside an @scope, :scope
  // (and a top-level &) is the scope root, not el, so the selector is
  // matched from the root.
  function matches(el, selector, root) {
    if (!root || !/:scope|&/.test(selector)) return el.matches(selector);
    if (el === root) return el.matches(selector);
    for (const found of root.querySelectorAll(selector)) if (found === el) return true;
    return false;
  }

  // rules are the CSS rules matching el, in cascade source order, the
  // latest 10, nested rules included (shown inside their parent's
  // braces). Media and supports conditions are checked; a container
  // query can't be from script, so a rule inside one keeps its condition
  // around it (`@container (min-width: 40rem) { .card }`), never shown as
  // simply matching. Cross-origin sheets can't be read and are skipped.
  // Each rule carries, unlisted (it isn't sent), its `source`: the sheet
  // it is in and its own selector text, for the CSS rules mapper's line.
  function rules(el) {
    const out = [];
    // parent is the enclosing style rule's absolute selector, and shown how
    // the brief names it; when are the container conditions around it,
    // outermost first; root is the @scope root around it, if any.
    const visit = (list, from, parent = null, when = [], root = undefined) => {
      for (const rule of list) {
        if (rule.selectorText !== undefined) {
          const text = rule.selectorText;
          const absolute = parent ? nest(text, parent.absolute) : text;
          // How the brief names it: made only for a rule that matches or nests others.
          const shown = () => (parent ? `${parent.shown} { ${oneLine(text)} }` : oneLine(text));
          let hit = false;
          try {
            hit = matches(el, absolute, root);
          } catch {}
          if (hit) {
            const selector = when.reduceRight((s, condition) => `${condition} { ${s} }`, shown());
            const file = sheetFile(from);
            const found = { selector: cut(selector, SELECTOR_CAP), ...(file && { file }) };
            Object.defineProperty(found, "source", { value: { sheet: from, selector: text } });
            out.push(found);
          }
          const nested = rule.cssRules;
          if (nested?.length) visit(nested, from, { absolute, shown: shown() }, when, root);
        } else if (rule.styleSheet) {
          sheet(rule.styleSheet); // @import
        } else if (rule.cssRules) {
          if (rule.media && rule.media.mediaText && !matchMedia(rule.media.mediaText).matches) continue;
          if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
          if (typeof CSSScopeRule !== "undefined" && rule instanceof CSSScopeRule) {
            const scope = scopeRoot(el, rule);
            if (scope === null) continue;
            const prelude = `${rule.start ? ` (${oneLine(rule.start)})` : ""}${rule.end ? ` to (${oneLine(rule.end)})` : ""}`;
            visit(rule.cssRules, from, parent, [...when, `@scope${prelude}`], scope ?? root);
            continue;
          }
          const container = typeof CSSContainerRule !== "undefined" && rule instanceof CSSContainerRule;
          visit(rule.cssRules, from, parent, container ? [...when, `@container ${oneLine(rule.conditionText)}`] : when, root);
        }
      }
    };
    const sheet = (s) => {
      if (s.disabled || (s.media?.mediaText && !matchMedia(s.media.mediaText).matches)) return;
      let list;
      try {
        list = s.cssRules;
      } catch {
        return;
      }
      visit(list, s);
    };
    for (const s of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) sheet(s);
    return out.slice(-RULES);
  }

  // nearby is visible text around el: its siblings' first lines, nearest
  // first, then its parent's siblings' and its grandparent's, at most 5.
  function nearby(el) {
    const own = ns.describe.text(el);
    const seen = new Set([own]);
    const out = [];
    const take = (node) => {
      if (out.length === NEARBY || node === ns.overlay?.host || UNSHOWN.has(node.localName)) return;
      if (node.checkVisibility && !node.checkVisibility()) return;
      const t = ns.describe.text(node);
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    };
    let level = 0;
    for (let node = el; node && node !== document.body && out.length < NEARBY && level++ < NEARBY_LEVELS; node = node.parentElement) {
      let prev = node.previousElementSibling;
      let next = node.nextElementSibling;
      while ((prev || next) && out.length < NEARBY) {
        if (prev) take(prev), (prev = prev.previousElementSibling);
        if (next) take(next), (next = next.nextElementSibling);
      }
    }
    return out;
  }

  const round = (n) => Math.round(n * 100) / 100;

  // element is one element's context, leaving out what's empty. A part that
  // fails is left out too: the tweak still goes, with what could be read.
  function element(el) {
    const out = ns.describe.element(el);
    out.label = cut(out.label, LABEL_CAP);
    if (out.text) out.text = cut(out.text, TEXT_CAP);
    else delete out.text;
    const part = (key, fn, empty = (v) => !v || v.length === 0) => {
      try {
        const v = fn();
        if (!empty(v)) out[key] = v;
      } catch {}
    };
    part("clues", () => ns.clues.of(el));
    part("role", () => role(el));
    part("name", () => name(el, out.role ?? ""));
    part("size", () => {
      const box = el.getBoundingClientRect();
      return { width: round(box.width), height: round(box.height) };
    }, (v) => !v);
    part("styles", () => styles(getComputedStyle(el)), (v) => Object.keys(v).length === 0);
    part("rules", () => rules(el));
    part("nearby", () => nearby(el));
    part("html", () => html(el));
    return out;
  }

  // targets are a tweak's targets for the elements, numbered in order.
  const targets = (els) => ({
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    elements: els.map(element),
  });

  // locate runs the mappers for each element of targets (gathered from els
  // by targets()), and adds what they find: the locations, and lines on the
  // CSS rules. It resolves when every mapper has answered or until (an
  // ns.mappers.deadline(), which Send starts) has passed. The rules' lines
  // come from the CSS rules mapper's work, read once.
  const locate = (gathered, els, until) =>
    Promise.all(
      els.map(async (el, i) => {
        const e = gathered.elements[i];
        const rules = e.rules ?? [];
        const [locations, lines] = await Promise.all([ns.mappers.run(el, { rules, until }), ns.mappers.ruleLines(rules, { until })]);
        if (locations.length) e.locations = locations;
        lines.forEach((at, j) => at && Object.assign(rules[j], at));
      }),
    );

  ns.context = { targets, locate, rules, element, styles, trimHTML, role, nest, cut };
})();
