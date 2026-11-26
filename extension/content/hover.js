// The hover label's source (docs/design.md, "When mapping runs"): the
// mappers run without fetching, over the CSS rules gathered once, and the
// label names the strongest place found; with none, the latest matching
// rule's stylesheet. The picker shows it once the pointer rests.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // label is how the hover label names an element's source: the first
  // place that isn't a style (the mappers come in priority order), else the
  // first style, by its last two path segments, with a line if it has one.
  function label(locations) {
    const best = locations.find((l) => l.role !== "style") ?? locations[0];
    if (!best) return "";
    const path = best.file.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
    const short = path.split("/").filter(Boolean).slice(-2).join("/");
    return best.line ? `${short}:${best.line}` : short;
  }

  // source is the hover label's text for el.
  async function source(el) {
    const rules = ns.context.rules(el);
    const found = await ns.mappers.run(el, { fetch: false, rules }).catch(() => []);
    if (found.length) return label(found);
    const latest = [...rules].reverse().find((r) => r.file);
    return latest ? label([{ file: latest.file, role: "style", via: "css" }]) : "";
  }

  ns.hover = { label, source };
})();
