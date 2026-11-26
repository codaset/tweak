// Optional improvements (docs/design.md, Optional improvements): what this
// page could add to point Claude closer, for the side panel to suggest. The
// app is never changed.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // suggestions are this page's: a Rails page (its CSRF meta tag names
  // Rails' authenticity_token) with no template annotations.
  function suggestions(doc = document) {
    const isRails = doc.querySelector('meta[name="csrf-param"][content="authenticity_token"]');
    return isRails && ns.mappers.annotations(doc).length === 0 ? ["rails-annotations"] : [];
  }

  ns.improvements = { suggestions };
})();
