// The e2e suite's browser: Chrome for Testing, pinned, in new headless.
// chrome-headless-shell doesn't load extensions, so it's never downloaded.
// Bumped by hand; CI caches the download keyed on this version.
module.exports = {
  chrome: { version: "158.0.8127.88" },
  "chrome-headless-shell": { skipDownload: true },
  firefox: { skipDownload: true },
};
