// The two worlds the framework mappers run in, for their unit tests: the
// page probe (extension/content/probe.js) in the page's world and the content
// script's mappers in another, over one stand-in page. Used by react.test.js,
// vue.test.js and svelte.test.js, over metadata captured from the fixtures
// and saved in test/extension/fixtures/.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
export const plain = (v) => JSON.parse(JSON.stringify(v));
export const dump = (dir, name) => JSON.parse(read(`./fixtures/${dir}/${name}.json`));

// A page: one document both worlds share, elements that dispatch events
// up to it, and no attributes anywhere (setAttribute throws).
function page() {
  const listeners = new Map();
  const on = (type) => listeners.get(type) ?? listeners.set(type, []).get(type);
  class CustomEvent {
    constructor(type, init = {}) {
      Object.assign(this, { type, detail: init.detail ?? null, bubbles: Boolean(init.bubbles), composed: Boolean(init.composed) });
    }
    composedPath() {
      return this.path ?? [this.target];
    }
  }
  const document = {
    addEventListener: (type, fn) => on(type).push(fn),
    removeEventListener: (type, fn) => on(type).splice(on(type).indexOf(fn) >>> 0, 1),
    dispatchEvent(event) {
      event.target ??= document;
      for (const fn of [...on(event.type)]) fn(event);
      return true;
    },
  };
  const element = (dump = {}) => {
    const el = {
      ...dump,
      setAttribute() {
        throw new Error("no attributes are written onto the page");
      },
      dispatchEvent(event) {
        event.target = el;
        event.path = [el, document];
        return event.bubbles ? document.dispatchEvent(event) : true;
      },
    };
    return el;
  };
  return { document, element, CustomEvent, listeners };
}

// load runs the probe in the page's world and the content script's
// mappers in another, over one page, with fetch serving `files` by URL.
// map(via, el, options) runs one framework mapper.
export function load(files = {}) {
  const { document, element, CustomEvent, listeners } = page();
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    return url in files ? { ok: true, text: async () => files[url] } : { ok: false, status: 404 };
  };
  runInNewContext(read("../../extension/content/probe.js"), { window: {}, document, CustomEvent, JSON, Object, Symbol });
  const ns = { ready: false, teardowns: [], context: { rules: () => [] } };
  const context = {
    codasetTweak: ns, globalThis: { codasetTweak: ns }, document, CustomEvent, setTimeout, clearTimeout, URL, Promise, atob, TextDecoder, fetch,
    location: { href: "http://localhost:3000/" },
  };
  for (const file of ["sourcemap", "frameworks", "mappers"]) runInNewContext(read(`../../extension/content/${file}.js`), context);
  const map = (via, el, options) => ns.frameworks[via].map(el, options).then(plain);
  return { ns, document, element, CustomEvent, fetched, listeners, map, react: (el, options) => map("react", el, options) };
}

// probe sends a tweak:probe on el the way the content script does and gives
// the tweak:probe-result details heard on document during the dispatch.
export function probe({ document, CustomEvent }, el, detail) {
  const heard = [];
  const hear = (e) => heard.push(e.detail);
  document.addEventListener("tweak:probe-result", hear);
  el.dispatchEvent(new CustomEvent("tweak:probe", { bubbles: true, composed: true, detail }));
  document.removeEventListener("tweak:probe-result", hear);
  return heard;
}

// A content script (extension/content/<file>) run in a fresh context: by
// default over a codasetTweak namespace `ns`, the way the page shares one;
// `extra` adds the globals the script uses. runScripts runs several over one
// ready-made context. Either way the namespace gets ns.util, the shared
// helpers namespace.js (the first file) puts there.
const script = (file) => read(`../../extension/content/${file}`);
const first = {};
runInNewContext(script("namespace.js"), { globalThis: first });
const { util } = first.codasetTweak;
export function loadScript(file, ns, extra = {}) {
  ns.util ??= util;
  runInNewContext(script(file), { codasetTweak: ns, globalThis: { codasetTweak: ns }, ...extra });
}
export function runScripts(files, context) {
  const ns = context.globalThis?.codasetTweak ?? context.codasetTweak;
  if (ns) ns.util ??= util;
  for (const file of files) runInNewContext(script(file), context);
}
