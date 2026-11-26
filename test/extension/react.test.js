// The React mapper (design.md § Finding the source): the page probe reads
// the element's fibers and the content script maps what it gives. Both run
// here over metadata captured from the fixtures, saved in
// test/extension/fixtures/: React 18 fiber dumps (vite-react18), React 19
// ones with the modules Vite served (vite-react19), and a React 19 webpack
// build with an external .map (devtool "source-map", vendor chunk split off;
// there is no webpack fixture). A dump is the element's __reactFiber$ key
// with the fields the probe reads, owners nested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dump, load, plain, probe, read } from "./probe-world.js";

// The vite-react18 copy the dumps were captured from.
const R18 = "/private/var/folders/c4/f_jd56vn60bf888tcj7zc6500000gn/T/tweak-e2e-vite-react18-5mdOoB/src/";

test("React 18: _debugSource gives the element's file, line and column; its owners are the components it's rendered inside", async () => {
  const { react, element } = load();
  // Button.jsx:3:5 is the <button> tag; Toolbar.jsx:6:7 is <Button />,
  // inside Toolbar; App.jsx:8:7 is <Toolbar />, inside App.
  assert.deepEqual(await react(element(dump("react18", "export-button"))), [
    { file: `${R18}Button.jsx`, line: 3, column: 5, role: "element", via: "react" },
    { file: `${R18}Button.jsx`, line: 3, column: 5, role: "component", via: "react", name: "Button" },
    { file: `${R18}Toolbar.jsx`, line: 6, column: 7, role: "component", via: "react", name: "Toolbar" },
    { file: `${R18}App.jsx`, line: 8, column: 7, role: "component", via: "react", name: "App" },
  ]);
});

test("React 18: children passed to a component belong to the component that wrote them, not the one that renders them", async () => {
  const { react, element } = load();
  // The save button is written in App, inside <Panel>: its owner is App.
  assert.deepEqual(await react(element(dump("react18", "save"))), [
    { file: `${R18}App.jsx`, line: 10, column: 9, role: "element", via: "react" },
    { file: `${R18}App.jsx`, line: 10, column: 9, role: "component", via: "react", name: "App" },
  ]);
});

// What vite-react19 served, by URL.
const VITE = "http://localhost:56820/src/";
const served = Object.fromEntries(["App", "Button", "Panel", "Toolbar", "main"].map((m) => [`${VITE}${m}.jsx`, read(`./fixtures/react19/${m}.jsx.served.js`)]));

test("React 19: frame 1 of _debugStack is mapped through the served module's inline source map to the exact line", async () => {
  const { react, element } = load(served);
  assert.deepEqual(await react(element(dump("react19", "export-button"))), [
    { file: `${VITE}Button.jsx`, line: 3, column: 5, role: "element", via: "react" },
    { file: `${VITE}Button.jsx`, line: 3, column: 5, role: "component", via: "react", name: "Button" },
    { file: `${VITE}Toolbar.jsx`, line: 6, column: 7, role: "component", via: "react", name: "Toolbar" },
    { file: `${VITE}App.jsx`, line: 8, column: 7, role: "component", via: "react", name: "App" },
  ]);
  assert.deepEqual(await react(element(dump("react19", "save"))), [
    { file: `${VITE}App.jsx`, line: 10, column: 9, role: "element", via: "react" },
    { file: `${VITE}App.jsx`, line: 10, column: 9, role: "component", via: "react", name: "App" },
  ]);
});

test("React 19: a module's decoded map is cached per URL; a hover uses only what is cached", async () => {
  const { react, element, fetched } = load(served);
  const heading = dump("react19", "panel-title");
  // Before any pick, a hover fetches nothing and gives the file only.
  assert.deepEqual((await react(element(heading), { fetch: false }))[0], { file: `${VITE}Panel.jsx`, role: "element", via: "react" });
  assert.deepEqual(fetched, []);
  await react(element(heading));
  await react(element(dump("react19", "save")));
  await react(element(dump("react19", "title")));
  assert.deepEqual(fetched.toSorted(), [`${VITE}App.jsx`, `${VITE}Panel.jsx`], "each module once");
  // Panel.jsx:5:7 is the <h2>.
  assert.deepEqual((await react(element(heading), { fetch: false }))[0], { file: `${VITE}Panel.jsx`, line: 5, column: 7, role: "element", via: "react" });
});

test("React 19: a module that won't load gives its file only, and is fetched again next time", async () => {
  const files = { ...served };
  delete files[`${VITE}Button.jsx`];
  const { react, element, fetched } = load(files);
  const button = dump("react19", "export-button");
  assert.deepEqual((await react(element(button)))[0], { file: `${VITE}Button.jsx`, role: "element", via: "react" });
  await react(element(button));
  assert.equal(fetched.filter((u) => u === `${VITE}Button.jsx`).length, 2);
});

// What the webpack build served: its app chunk names an external .map.
const WEBPACK = "http://localhost:57099/";
const bundle = { [`${WEBPACK}main.js`]: read("./fixtures/react19-webpack/main.js"), [`${WEBPACK}main.js.map`]: read("./fixtures/react19-webpack/main.js.map") };

test("React 19 on webpack: frame 1 is mapped through the chunk's external .map, fetched once", async () => {
  const { react, element, fetched } = load(bundle);
  // webpack names its sources webpack://<name>/./path: kept as given.
  assert.deepEqual(await react(element(dump("react19-webpack", "export-button"))), [
    { file: "webpack://wp/./src/Button.jsx", line: 3, column: 5, role: "element", via: "react" },
    { file: "webpack://wp/./src/Button.jsx", line: 3, column: 5, role: "component", via: "react", name: "Button" },
    { file: "webpack://wp/./src/Toolbar.jsx", line: 6, column: 7, role: "component", via: "react", name: "Toolbar" },
    { file: "webpack://wp/./src/App.jsx", line: 8, column: 7, role: "component", via: "react", name: "App" },
  ]);
  await react(element(dump("react19-webpack", "save")));
  assert.deepEqual(fetched, [`${WEBPACK}main.js`, `${WEBPACK}main.js.map`]);
});

test("React 19 on webpack: a module fetched again at a new URL (a hot update's ?t=) reads its external .map again", async () => {
  const files = { ...bundle };
  const { react, element } = load(files);
  const at = (stack, query) => stack.replaceAll(`${WEBPACK}main.js:`, `${WEBPACK}main.js${query}:`);
  const versioned = (query) => {
    const d = dump("react19-webpack", "save");
    const fiber = Object.values(d)[0];
    fiber._debugStack.stack = at(fiber._debugStack.stack, query);
    return d;
  };
  files[`${WEBPACK}main.js?t=1`] = files[`${WEBPACK}main.js`];
  files[`${WEBPACK}main.js?t=2`] = files[`${WEBPACK}main.js`];
  assert.equal((await react(element(versioned("?t=1"))))[0].file, "webpack://wp/./src/App.jsx");
  // The rebuild renamed the file: same map URL, new map.
  files[`${WEBPACK}main.js.map`] = files[`${WEBPACK}main.js.map`].replaceAll("./src/App.jsx", "./src/Home.jsx");
  assert.equal((await react(element(versioned("?t=2"))))[0].file, "webpack://wp/./src/Home.jsx");
});

test("the probe answers at once on document, a JSON string carrying the request's ID; with no fiber, React is null", () => {
  const page = load();
  const plainDiv = page.element();
  const heard = probe(page, plainDiv, JSON.stringify({ id: "q1", what: "react" }));
  assert.equal(heard.length, 1, "answered during the dispatch");
  assert.equal(typeof heard[0], "string");
  assert.deepEqual(JSON.parse(heard[0]), { id: "q1", react: null });
  // The content script's side: nothing, at once, and its listener gone.
  assert.equal(page.ns.frameworks.ask(plainDiv, "react"), null);
  assert.equal(page.listeners.get("tweak:probe-result").length, 0);
});

test("the probe ignores a request that isn't JSON or has no ID, and answers only what it knows", () => {
  const page = load();
  const el = page.element(dump("react18", "save"));
  assert.deepEqual(probe(page, el, "not json"), []);
  assert.deepEqual(probe(page, el, JSON.stringify({ what: "react" })), []);
  assert.deepEqual(JSON.parse(probe(page, el, JSON.stringify({ id: "q2", what: "toString" }))[0]), { id: "q2" });
});

test("an answer to another request, such as one the page made up, is ignored", async () => {
  const page = load();
  page.document.addEventListener("tweak:probe", () =>
    page.document.dispatchEvent(new page.CustomEvent("tweak:probe-result", { detail: JSON.stringify({ id: "made-up", react: { element: { file: "/evil.jsx", line: 1 } } }) })),
  );
  assert.deepEqual((await page.react(page.element(dump("react18", "title")))).map((l) => `${l.file.split("/").pop()}:${l.line}`), ["App.jsx:7", "App.jsx:7"]);
});

test("the React mapper runs first, ahead of the DOM mappers", async () => {
  const page = load();
  const [first] = plain(await page.ns.mappers.run(page.element(dump("react18", "title")), { rules: [] }));
  assert.deepEqual(first, { file: `${R18}App.jsx`, line: 7, column: 7, role: "element", via: "react" });
});
