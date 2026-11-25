# Framework dev metadata: React 18/19, Vue 3, Svelte 4/5

Research for codaset/tweak#5. Question: on real development builds, what source-location metadata does each framework attach to rendered DOM, and how does a script in the page's own JS world read it?

Evidence labels: **[verified]** = I ran it in headless Chrome against a Vite dev server and read the value with `agent-browser eval`. **[source]** = read in the published npm package source. **[inferred]** = reasoned, not run.

Test apps (minimal Vite dev servers, each with a plain `<main>`/`<h1>` in the root component and a `Card` component whose root is `<section id="card-root">` containing `<p id="card-p">`): react@18.3.1, react@19.2.0 (plugin-react 6.3.0, Vite 8.3.8), vue@3.5.46 (plugin-vue 6.0.11), svelte@5.59.2 (plugin-svelte 7.3.2), svelte@4.2.20 (plugin-svelte 3.1.2, Vite 5.4.21). All defaults; no extra dev settings were needed anywhere. The apps are not committed.

## Answer

- **React 18**: every fiber has `_debugSource {fileName, lineNumber, columnNumber}`, an absolute path with a 1-based line and column of the JSX tag. Reach it via `el['__reactFiber$…']`. Host elements give the tag's own location; a component fiber gives where `<Card/>` is used. Needs a JSX dev transform (Vite plugin-react does it by default). No source map needed. [verified]
- **React 19**: `_debugSource` is gone. Each fiber has `_debugStack`, an `Error` whose `.stack` is a V8 stack. Frame 0 is React's own `jsxDEV`; **frame 1 is the JSX call site** as `http://host/src/Card.jsx:4:25` in the *transformed* module. Fetch that URL, read its inline `sourceMappingURL` (Vite serves a base64 data URI), and map line/col: that yielded `Card.jsx:3:5`, exactly the `<section>` tag. The route works end to end. [verified]
- **Vue 3**: `el.__vueParentComponent.type.__file` is the absolute path of the `.vue` file. File only: no line or column. `__vueParentComponent` is the component whose render created the element, so a component root and a plain element inside it give the same answer (the owning component); the usage site of `<Card/>` is not recorded, though the parent instance is (`.parent.type.__file`). [verified]
- **Svelte 5**: `el.__svelte_meta.loc {file, line, column}` (project-relative file, 1-based line, 0-based column), plus `.parent {file,line,column}` = where the component owning the element is used (a stack; `null` for the top-level component's own elements). [verified]
- **Svelte 4**: `el.__svelte_meta.loc {file, line, column, char}`; **line is 0-based** (an element on file line 4 reports 3), column 0-based. No component or usage info. [verified]
- All of it exists only in dev builds; none needs a non-default dev setting under Vite. Only React 19 needs a source-map fetch. Only React 19 and Svelte 5 can give a component's usage site from the element alone; React 18 can too.

## React 18

- **Field**: `fiber._debugSource = { fileName, lineNumber, columnNumber }`. [verified] Set from `element._source` in react-dom (`react-dom.development.js` line 13288: `existing._debugSource = element._source`). [source]
- **Example** (react 18.3.1, Vite): `<section id="card-root">` -> `{fileName: ".../react18/src/Card.jsx", lineNumber: 3, columnNumber: 5}`; `<Card/>` fiber -> `main.jsx` line 4, column 90. [verified]
- **Reach**: `el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]`, then walk `.return`. [verified]
- **Plain element vs component root**: the host fiber (`section`, `p`, `main`, `h1`) carries the location of its own JSX tag. The component fiber (`Card`, the parent of the root element) carries the location where `<Card/>` is written. A component root DOM node therefore has two answers: its own tag (host fiber) and the usage site (the next function-component fiber up). `_debugOwner` points at the rendering component's fiber. [verified]
- **Caveats**: needs the JSX dev transform emitting `__source` (plugin-react on Vite 8 did, with no config; esbuild `jsxDev`, as the prototype's Proscenium path, also works). `fileName` is an absolute filesystem path here. Absent in production. Absent on non-JSX `createElement` calls [inferred].

```js
const fiberOf = el => el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]
function react18(el) {
  const out = []
  for (let f = fiberOf(el); f; f = f.return)
    if (f._debugSource) out.push({ name: typeof f.type === 'string' ? f.type : f.type?.name, ...f._debugSource })
  return out
}
```

## React 19

- **Field**: `fiber._debugStack`, an `Error` created inside `jsxDEV` with message `react-stack-top-frame`. Defined on elements in `react/cjs/react-jsx-dev-runtime.development.js` (line 181 `Object.defineProperty(type, "_debugStack"…)`, line 119/333 `Error("react-stack-top-frame")`) and copied to fibers by react-dom (`react-dom-client.development.js` line 5044 `mode._debugStack = element._debugStack`). [source] `_debugSource` does not exist on fibers (checked with `"_debugSource" in fiber`). [verified] `_debugStack` appears 0 times in the production `react-jsx-runtime.production.js` and `react-dom-client.production.js`. [source]
- **Example** (`<p id="card-p">`, react 19.2.0, Vite):
  ```
  Error: react-stack-top-frame
      at exports.jsxDEV (http://localhost:5102/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=2c8b8274:192:83)
      at Card (http://localhost:5102/src/Card.jsx:6:29)
      at Object.react_stack_bottom_frame (...react-dom_client.js...)
      ...
  ```
  [verified]
- **Full route, verified**: (1) take frame 1 (the first frame after `jsxDEV`): `http://localhost:5102/src/Card.jsx:6:29`. (2) `fetch()` that URL: Vite returns the transformed module (the original `<p>` is now line 6 of 46 lines: `children: /* @__PURE__ */ _jsxDEV("p", {`), ending in `//# sourceMappingURL=data:application/json;base64,…`. (3) Decode the map (`version, sources: ["Card.jsx"], sourcesContent, mappings, names`; `sources` is relative to the module URL, so original = `http://localhost:5102/src/Card.jsx`; the data-URI map also carries `sourcesContent`). (4) Map line 6, column 29 (V8 columns are 1-based; source-map libraries want 0-based, so pass 28) -> `{source: "Card.jsx", line: 4, column: 6}` = 1-based col 7, exactly `<p` in the file. `<section>`: frame `Card.jsx:4:25` -> `Card.jsx` 3:5. `<Card/>` fiber: frame `main.jsx:15:28` -> `main.jsx` 4:90. All three equal React 18's `_debugSource` values for the same elements. (Mapping done with `source-map-js` in Node; the fetch and the data-URI map are the same bytes the page sees.)
- **Reach**: same `__reactFiber$` key as React 18, then `fiber._debugStack.stack`. [verified]
- **Plain element vs component root**: same shape as 18. A host fiber's stack frame 1 is the JSX tag inside the render function that created the element (`Card.jsx:4:25` for the root `<section>`); a component fiber's stack is the usage site (`main.jsx:15:28` for `<Card/>`, rendered at top level so the frame has no function name). `_debugOwner` also present. [verified]
- **Caveats**:
  - Frame 0 is always React's `jsxDEV`; take the first frame that is not `jsxDEV` [verified for this layout].
  - The stack is only 10 frames deep in the example and is a V8 string; Firefox and Safari format `.stack` differently (`fn@url:line:col`) [inferred], so a reader must handle both formats if the extension supports them.
  - Module URLs may carry Vite query strings (`?v=`, `?t=` after HMR) [inferred for `?t=`]; fetch the URL exactly as it appears.
  - Positions are in the transformed module, so a source map is mandatory; without one the line is wrong (here the shift is 2 to 3 lines). Vite always emits an inline map for transformed JSX in dev. [verified]
  - The frame URL is a dev-server URL, not a path; mapping `sources` against it gives a URL, which the tool then has to turn into a project file path (dev-server root known from `new URL(...).origin`; Vite serves `/@fs/` for files outside root [inferred]).
  - Absent in production.

```js
const fiberOf = el => el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]
const FRAME = /\(?(https?:\/\/[^\s()]+?):(\d+):(\d+)\)?$/
function react19Frame(fiber) {
  const lines = fiber._debugStack?.stack.split('\n').slice(1) ?? []
  for (const l of lines) {
    if (/jsxDEV|jsxs?\b|react-stack/.test(l)) continue
    const m = l.trim().match(FRAME); if (m) return { url: m[1], line: +m[2], col: +m[3] }
  }
}
// then: code = await (await fetch(url)).text(); take the last //# sourceMappingURL=;
// data: URI -> atob, else fetch(new URL(ref, url)); originalPositionFor({line, column: col - 1});
// original = new URL(map.sources[i], url)
```

## Vue 3

- **Field**: `el.__vueParentComponent.type.__file`. `__vueParentComponent` and `__vnode` are defined non-enumerable on every element when `process.env.NODE_ENV !== "production" || __VUE_PROD_DEVTOOLS__` (`@vue/runtime-core/dist/runtime-core.esm-bundler.js` line 5951-5953). [source] `__file` is attached by `@vitejs/plugin-vue` (`dist/index.mjs` line 1382: `if (devToolsEnabled || devServer && !isProduction) attachedProps.push(['__file', …])`), absolute path in dev, basename in a production build with devtools. [source]
- **Example** (vue 3.5.46): `__vueParentComponent.type.__file` = `/…/fw-apps/vue3/src/Card.vue` for `#card-root` and `#card-p`; `/…/src/App.vue` for `#plain` and `#h`. Compiled module ends `['__file', "/…/src/Card.vue"]`. [verified]
- **Reach**: `el.__vueParentComponent` (not enumerable, so use the property directly, not `Object.keys`). `instance.parent` walks up; `instance.type.__name` is the component name. [verified]
- **Plain element vs component root**: both resolve to the component that owns the template containing the element (`#card-root` and `#card-p` both give `Card`). `instance.subTree.el === el` tells you it is the component root (verified true for `#card-root`, `#plain`). The usage site of `<Card/>` is not available, only the parent component's file via `instance.parent`. **No line or column anywhere**; `type.__file` is file-level only. A mapper has to locate the element within the file some other way (for example by searching the SFC text or a template compiler location lookup). [verified]
- **Caveats**: file granularity only. In a production build `__file` and `__vueParentComponent` are absent unless `__VUE_PROD_DEVTOOLS__`. SFC-only: components defined in plain JS or JSX have no `__file`. [inferred]

```js
function vue3(el) {
  const out = []
  for (let c = el.__vueParentComponent; c; c = c.parent)
    out.push({ name: c.type.__name ?? c.type.name, file: c.type.__file, isRoot: out.length === 0 && c.subTree?.el === el })
  return out
}
```

## Svelte 5

- **Field**: `el.__svelte_meta = { loc: {file, line, column}, parent: {file, line, column, parent…} | null, component }`, defined non-enumerable by `set_dev_metadata` in `svelte/src/internal/client/dev/elements.js` (line 12-21). The compiler output in dev calls `$.add_locations($.from_html(...), Card[$.FILENAME], [[4, 0, [[5, 2]]]])`. [source + verified]
- **Example** (svelte 5.59.2): `#card-p` -> `loc {file: "src/Card.svelte", line: 5, column: 2}`, `parent {file: "src/App.svelte", line: 4, column: 38}`. `#card-root` -> `loc {Card.svelte, 4, 0}`, same `parent`. `#plain` -> `loc {App.svelte, 4, 0}`, `parent null`. `#h` -> `loc {App.svelte, 4, 17}`. [verified]
- **Reach**: `el.__svelte_meta` directly. [verified]
- **Plain vs component root**: both are ordinary elements with their own `loc` (the element's own tag, in the file that contains it). Elements inside a child component additionally get `parent`: the location where that component was used (`<Card>` at App.svelte 4:38, which is exactly the column of `<Card` in the file). Elements in the top-level component have `parent: null`. [verified]
- **Caveats**: `file` is project-root-relative (`src/Card.svelte`), not absolute. Line is 1-based, column 0-based. `parent` and `component` objects are circular (do not `JSON.stringify` the meta; copy the fields). Dev only (plugin-svelte sets `dev: !viteConfig.isProduction`, `src/utils/options.js` line 210). No setting needed. [source + verified]

```js
function svelte5(el) {
  const m = el.__svelte_meta; if (!m) return null
  const trail = []
  for (let p = m.parent; p; p = p.parent) trail.push({ file: p.file, line: p.line, column: p.column })
  return { ...m.loc, usedAt: trail }
}
```

## Svelte 4

- **Field**: `el.__svelte_meta = { loc: { file, line, column, char } }`, from `add_location(element, file, line, column, char)` calls in compiled dev output (`add_location(section, file, 3, 0, 43)`). [verified]
- **Example** (svelte 4.2.20): `#card-p` -> `{file: "src/Card.svelte", line: 4, column: 2, char: 70}` while `<p>` is on file line 5. `#card-root` -> `line: 3` for file line 4. **Line is 0-based** (verified by comparing against the source file); column 0-based; `char` is the 0-based character offset. [verified]
- **Reach**: `el.__svelte_meta`. Enumerable? `getOwnPropertyNames` shows it. [verified]
- **Plain vs component root**: identical, each element gets its own tag location; there is no component or usage-site link, because a component tag is not an element and is not recorded. [verified/inferred]
- **Caveats**: dev only. Needs `dev: true`, which plugin-svelte sets from Vite mode (not independently checked for v3). Note the line-base difference between Svelte 4 (0) and 5 (1).

```js
function svelte4(el) {
  const l = el.__svelte_meta?.loc
  return l && { file: l.file, line: l.line + 1, column: l.column }   // normalise to 1-based line
}
```

## Cross-framework summary

| | field | line/col | usage site of component | needs source map |
|---|---|---|---|---|
| React 18 | `fiber._debugSource` | 1-based line, col as emitted (1-based) | yes (component fiber) | no |
| React 19 | `fiber._debugStack.stack` frame 1 | transformed-module position | yes (component fiber) | yes (inline, in the module) |
| Vue 3 | `__vueParentComponent.type.__file` | none (file only) | parent file only | no |
| Svelte 5 | `__svelte_meta.loc` / `.parent` | 1-based line, 0-based col | yes (`parent`) | no |
| Svelte 4 | `__svelte_meta.loc` | 0-based line, 0-based col | no | no |

Path form also differs: React and Vue give absolute filesystem paths (React 19 gives a dev-server URL); Svelte gives a project-relative path.

## Not tested

Production builds (checked only by grep that React 19 `_debugStack` is absent from the production bundles), SvelteKit, SSR/hydration paths (Svelte 5 `hydrate_assign_locations` exists, so hydrated elements should still get metadata [source]), Firefox/Safari stack formats, and webpack or other bundlers for React 19 (source-map delivery differs: external `.map` files or `eval`-style devtool).
