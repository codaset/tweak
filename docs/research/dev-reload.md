# Dev servers: do they already reload on file changes? (#6)

Researched 2026-11-25. Each claim is marked **[verified]** (read in primary source: framework source, official docs, or the installed gem) or **[inferred]** (reasoned from verified facts).

## Answer

- **Proscenium (Bert and Ernie): nothing.** The installed gem has no live-reload, HMR, websocket or SSE code, and neither app adds one. A file change reaches the browser only on the next manual request. Its README says "NO additional process or server - Just run `rails server`". [verified]
- **Rails 8 defaults: nothing in the browser.** `enable_reloading` reloads Ruby constants on the *next request*. The generated Gemfile has no `hotwire-spark`, `listen` or other live-reload gem. [verified]
- **Vite and SvelteKit: yes, automatic, over a websocket.** CSS-only edits swap or update the stylesheet in place (no page reload). Component edits hot-update when a module accepts them, otherwise full reload. HTML edits full-reload. [verified]
- **Next.js: yes.** Fast Refresh for component and CSS edits, `hmrRefresh()` for server components, full reload as the fallback. [verified]
- **Consequence for the design:** the "wait briefly, reload only if the page hasn't already" approach is right. For the two apps v1 is checked on (Proscenium) the extension will almost always have to reload itself. For Vite, Next and SvelteKit it must detect "something already happened" from the DOM or navigation, because the framework events (`vite:afterUpdate` etc.) are not DOM events.
- **What a content script can observe, by signal:** a full reload (the content script re-runs, or `performance.getEntriesByType('navigation')` / `pageshow` shows a new load) and `<link rel=stylesheet>` or `<style data-vite-dev-id>` mutations (MutationObserver). A JS-only hot update (component swap) shows up only as DOM mutations, which are indistinguishable from app activity. [inferred]
- Caveat: `Gemfile.lock` pins proscenium 0.28.0 but the only installed gem is 0.28.1; `bundle show` fails because the shell Ruby is 4.0.10 and the Gemfile wants 3.4.13. I read 0.28.1.

## Summary table

"Observable" = what an extension content script (isolated world, DOM access) can see.

| Stack | CSS-only change | Template change | Component / JS change | Observable by content script |
|---|---|---|---|---|
| Proscenium + Rails dev (Bert, Ernie) | Nothing. Next request serves new CSS | Nothing. Next request renders new template | Nothing. Next request reloads Ruby / rebuilds JS | Nothing pushed. Only the extension's own reload is observable |
| Rails 8 default (no Spark) | Nothing | Nothing | Nothing (Ruby reloaded on next request) | Nothing |
| Rails + hotwire-spark (opt-in) | Reloads only the changed stylesheet | Morph (importmaps) or Turbo visit (JS bundling) | Stimulus reload (importmaps) or Turbo visit (bundling) | `<link>` change; DOM morph mutations; Turbo events on navigation |
| Vite (plain) | `<link>`: cloned and swapped; JS-imported CSS: `<style data-vite-dev-id>` textContent updated. No reload | `.html` edit: full reload | JS: hot update if a boundary accepts, else full reload | `<link>`/`<style>` mutations; navigation entry for full reload. `vite:*` events are NOT DOM events |
| SvelteKit (Vite + vite-plugin-svelte) | Separate CSS update, state preserved | Svelte HMR (JS update) | Svelte HMR, local state not preserved; fallback to full reload | Same as Vite |
| Next.js | Applied instantly via Fast Refresh | Server components: `hmrRefresh()`; edit to non-React importers: full reload | Fast Refresh re-render; full reload on error or non-React importer | DOM mutations; navigation entry on `performFullReload`; no window events dispatched |

## Details and sources

### Proscenium (Bert and Ernie)

- Bert: `/Users/joelmoss/dev/clients/harleytherapy/london`; Ernie: `.../platform`. Both lock proscenium 0.28.0 (Gemfile.lock); Ernie adds `proscenium-view_component` 0.7.1, Bert `proscenium-phlex`. [verified]
- Both `config/environments/development.rb` set `config.enable_reloading = true` and nothing else reload-related. Neither Gemfile lists `listen`, `hotwire-spark`, or a live-reload gem (only `puma`, `rails_caddy_dev`, `web-console`). Neither has a Procfile.dev; `bin/dev` is a Docker-services helper, `make up` starts caddy and `rails server`. [verified]
- Gem source (`gems/proscenium-0.28.1-arm64-darwin`): `grep -i livereload|hmr|EventSource|websocket|reload|hot` across `lib` and `README.md` finds nothing relevant. The hits are the Bun test-runner `--watch` support in `lib/proscenium/runtime/server.rb` and a `WATCHED` file list for mapping generation in `lib/proscenium/contexts/mapping_generation.rb`. Neither pushes anything to a browser. [verified]
- The middleware (`lib/proscenium/railtie.rb`, `initializer 'proscenium.middleware'`) is inserted before `ActionDispatch::Reloader` when reloading is enabled; it builds assets on request. `middleware/base.rb` sets `response.etag = result[:content_hash]`, so a changed file gets a new ETag on the next fetch. Pull only. [verified]
- Rails reloading: "Rails unloads all autoloaded constants ... just before the next request is processed", and the guide describes nothing pushed to the browser. https://guides.rubyonrails.org/autoloading_and_reloading_constants.html [verified]
- Implication: after Claude edits a Proscenium app, the page shows the change only after the extension reloads it. [inferred]

### Rails 8 defaults

- `config.enable_reloading` defaults to `true` in development; `config.file_watcher` defaults to `ActiveSupport::FileUpdateChecker`. The configuring guide mentions no browser live reload. https://guides.rubyonrails.org/configuring.html (first 100k chars of 226k read; the rest was not checked) [verified]
- Generator Gemfile template: dev group is `kamal` and `web-console` plus `debug`, `brakeman` and similar; no `hotwire-spark` or `listen`. https://github.com/rails/rails/blob/main/railties/lib/rails/generators/rails/app/templates/Gemfile.tt [verified]
- Hotwire Spark is opt-in (`gem "hotwire-spark"` in the development group). Reloads CSS per stylesheet; HTML via idiomorph morph (importmaps) or Turbo visit (JS bundling); Stimulus controllers likewise. Transport is not stated in its README. https://github.com/hotwired/spark [verified]

### Vite

- Events (dispatched to `import.meta.hot.on`): `vite:beforeUpdate`, `vite:afterUpdate`, `vite:beforeFullReload`, `vite:beforePrune`, `vite:invalidate`, `vite:error`, `vite:ws:disconnect`, `vite:ws:connect`. https://vite.dev/guide/api-hmr [verified]
- These are not DOM events: `hot.on` appends to an in-module `customListenersMap: Map<string, callback[]>`, run by `notifyListeners`. https://github.com/vitejs/vite/blob/main/packages/vite/src/shared/hmr.ts [verified]. Neither a content script nor ordinary page script can subscribe without a module `import.meta.hot` context. A page-world script could in principle import `/@vite/client` and use `createHotContext`; untested [inferred].
- CSS update for a `<link>`: the tag is cloned with a timestamped `href`, inserted with `el.after`, and the old tag removed after the new one loads or errors. For CSS imported from JS, `updateStyle` sets `style.textContent` on the existing `<style data-vite-dev-id>`. `vite:beforeUpdate` fires, then `vite:afterUpdate` after all CSS links have loaded. https://github.com/vitejs/vite/blob/main/packages/vite/src/client/client.ts [verified]
- Full reload: `vite:beforeFullReload`, then `location.reload()` after a 20 ms debounce; there is no "after" event. [verified, same file]
- Server decision (`server/hmr.ts`): the update type is `css-update` or `js-update` by boundary type; a module chain with no accepting boundary (dead end) gives `full-reload`; an `.html` change gives `full-reload` ("html file cannot be hot updated"); a changed file not in the module graph logs and sends nothing. https://github.com/vitejs/vite/blob/main/packages/vite/src/node/server/hmr.ts [verified]
- Websocket: subprotocol `vite-hmr`; a message `{type:'full-reload'}` and `{type:'update'}` is visible to anyone who opens their own socket (needs the `?token=` value). Possible but fragile [inferred].

### SvelteKit

- SvelteKit runs on Vite, so the Vite behaviour above applies [inferred from architecture; I did not read SvelteKit source]. HMR is built into the Svelte compiler via `compilerOptions.hmr` (default `false` for the compiler, set by `vite-plugin-svelte` in dev). https://svelte.dev/docs/svelte/svelte-compiler , https://github.com/sveltejs/vite-plugin-svelte/blob/main/docs/config.md [verified]
- A change only to `<style>` is a separate CSS update that fully preserves component state; script or markup changes are JS updates and local state is not preserved. https://github.com/sveltejs/vite-plugin-svelte/blob/main/docs/faq.md [verified]
- When SvelteKit falls back to a full reload (route and server file edits) was not covered by the sources read [open].

### Next.js

- Fast Refresh (9.4+, default): a file exporting only components is re-rendered; non-component exports re-run importers; a file imported from outside the React tree falls back to a full reload. https://nextjs.org/docs/architecture/fast-refresh [verified]
- "In development (`next dev`), CSS updates apply instantly with Fast Refresh." https://nextjs.org/docs/app/getting-started/css [verified]
- App router client (`hot-reloader-app.tsx`): `BUILT` leads to webpack `module.hot.check/apply` or Turbopack HMR, falling back to `performFullReload` on error; `SERVER_COMPONENT_CHANGES` leads to `router.hmrRefresh()` (or full reload after a runtime error); `RELOAD_PAGE` leads to `window.location.reload()`. It dispatches no custom `window` events; the only test hook is `self.__NEXT_HMR_CB` under `__NEXT_TEST_MODE`. https://github.com/vercel/next.js/blob/canary/packages/next/src/client/dev/hot-reloader/app/hot-reloader-app.tsx [verified]
- Observable from DOM only: mutations and, for full reloads, a new navigation entry. [inferred]

## Open questions

- Is the content script's DOM-mutation heuristic reliable enough to tell "framework already updated" from unrelated page activity? Watching only `<link rel=stylesheet>` and `<style>` plus navigation is cleaner, but misses pure JS hot updates. Candidate for a prototype ticket.
- Does an `import('/@vite/client')` page-world shim give a clean `vite:afterUpdate` signal? Untested.
