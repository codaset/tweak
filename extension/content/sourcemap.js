// Source maps (docs/design.md, "Finding the source", Source maps): a small
// VLQ decoder of our own (no dependency), and the maps a served file names
// in its sourceMappingURL, an inline data URL or an external file fetched
// from the page's origin. Decoded maps are cached per URL. The CSS rules
// mapper uses it for rule lines; React 19's frame 1 reuses it.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

  // vlq decodes one run of Base64 VLQ values: 5 bits a digit, least
  // significant first, the sixth bit says another digit follows, and the
  // value's lowest bit is its sign.
  function vlq(s) {
    const out = [];
    let value = 0;
    let shift = 0;
    for (const c of s) {
      const digit = DIGIT.get(c);
      if (digit === undefined) throw new Error(`not a VLQ digit: ${c}`);
      value += (digit & 31) * 2 ** shift;
      if (digit & 32) {
        shift += 5;
        continue;
      }
      out.push(value % 2 ? -(value - 1) / 2 : value / 2);
      value = 0;
      shift = 0;
    }
    if (shift) throw new Error("VLQ value cut short");
    return out;
  }

  // decode turns a map's mappings into lines of segments, each
  // [column, source, sourceLine, sourceColumn] with every value absolute
  // and 0-based (a segment with no source is [column]).
  function decode(mappings) {
    let source = 0;
    let sourceLine = 0;
    let sourceColumn = 0;
    return mappings.split(";").map((line) => {
      let column = 0;
      const segments = [];
      for (const part of line.split(",")) {
        if (!part) continue;
        const v = vlq(part);
        column += v[0];
        if (v.length < 4) {
          segments.push([column]);
          continue;
        }
        source += v[1];
        sourceLine += v[2];
        sourceColumn += v[3];
        segments.push([column, source, sourceLine, sourceColumn]);
      }
      return segments.sort((a, b) => a[0] - b[0]);
    });
  }

  // sourcePath is a map's source as a file the bridge can place: a
  // relative one is resolved against the map's URL (a dev-server URL);
  // an absolute path or another scheme (webpack://) is kept as given.
  function sourcePath(source, root, mapURL) {
    const s = root ? `${root.replace(/\/?$/, "/")}${source}` : source;
    if (s.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
    try {
      return new URL(s, mapURL).href;
    } catch {
      return s;
    }
  }

  // parse reads a map's JSON: its resolved sources and decoded lines.
  function parse(json, mapURL) {
    const raw = typeof json === "string" ? JSON.parse(json) : json;
    if (raw.version !== 3 || typeof raw.mappings !== "string" || !Array.isArray(raw.sources)) throw new Error("not a source map");
    return { sources: raw.sources.map((s) => sourcePath(String(s ?? ""), raw.sourceRoot, mapURL)), lines: decode(raw.mappings) };
  }

  // lookup maps a 0-based position in the served file to its source:
  // {source, line, column}, 1-based, or null where nothing maps it.
  function lookup(map, line, column) {
    let best = null;
    for (const seg of map.lines[line] ?? []) {
      if (seg[0] > column) break;
      best = seg.length === 4 ? seg : null; // a one-field segment starts unmapped code
    }
    if (!best || !map.sources[best[1]]) return null;
    return { source: map.sources[best[1]], line: best[2] + 1, column: best[3] + 1 };
  }

  // mapURL is the last sourceMappingURL a file names (CSS or JS comment).
  function mapURL(text) {
    const all = [...text.matchAll(/[#@]\s*sourceMappingURL=([^\s*'"]+)/g)];
    return all.length ? all[all.length - 1][1] : "";
  }

  // fromData reads a data: URL's JSON, base64 or percent-encoded.
  function fromData(url) {
    const comma = url.indexOf(",");
    const head = url.slice(0, comma);
    const body = url.slice(comma + 1);
    if (!/;base64$/i.test(head)) return decodeURIComponent(body);
    return new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
  }

  // Maps by URL: {loading, map}, the map set once it has loaded.
  const cache = new Map();

  // forText is the map a served file's text names, given the file's URL.
  // Without fetch, only an inline map or one already loaded is given.
  // With reload, an external map is fetched again (its file was read again).
  async function forText(text, fileURL, { fetch: fetching = true, reload = false } = {}) {
    const named = mapURL(text);
    if (!named) return null;
    if (named.startsWith("data:")) {
      try {
        return parse(fromData(named), fileURL);
      } catch {
        return null;
      }
    }
    let url;
    try {
      url = new URL(named, fileURL).href;
    } catch {
      return null;
    }
    if (reload) cache.delete(url);
    let entry = cache.get(url);
    if (!fetching) return entry?.map ?? null;
    if (!entry) {
      entry = { map: null };
      entry.loading = fetch(url, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
        .then((json) => (entry.map = parse(json, url)))
        // A map that wouldn't load is tried again on the next pick.
        .catch(() => (cache.delete(url), null));
      cache.set(url, entry);
    }
    return entry.loading;
  }

  // cached is the decoded map at a URL, once it has loaded.
  const cached = (url) => cache.get(url)?.map ?? null;

  // Served modules' maps (React 19's frames), by module URL: {loading, map}.
  // Vite's maps are inline, so they are cached here, decoded once per URL.
  const modules = new Map();

  // forModule is the map of the served JavaScript module at url, fetched
  // (same origin) and decoded once. Without fetch, only a map already
  // loaded is given. A module or map that wouldn't load is tried again.
  async function forModule(url, { fetch: fetching = true } = {}) {
    let entry = modules.get(url);
    if (!fetching) return entry?.map ?? null;
    if (!entry) {
      entry = { map: null };
      entry.loading = fetch(url, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
        // A module read afresh (a hot update's new ?t= URL) reads its
        // external map afresh too, though the map's URL is the same.
        .then((text) => forText(text, url, { reload: true }))
        .then((map) => (map ? (entry.map = map) : Promise.reject(new Error("no source map"))))
        .catch(() => (modules.delete(url), null));
      modules.set(url, entry);
    }
    return entry.loading;
  }

  ns.sourcemap = { vlq, decode, parse, lookup, mapURL, forText, forModule, cached };
})();
