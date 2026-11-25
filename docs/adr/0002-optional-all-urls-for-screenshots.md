# Site access: optional `<all_urls>`, asked for once

The extension declares `<all_urls>` as an optional host permission and asks for it once, from the side panel's **Allow access** button on the first claim, instead of asking for each claimed domain. Every tweak needs a screenshot, and Chrome's `captureVisibleTab` only works with `activeTab` or the literal `<all_urls>` pattern: grants for single domains, even `*://*/*`, aren't enough (verified in [Chrome extension APIs for the v1 design](https://github.com/codaset/tweak/issues/8)). ⌥-click and Send aren't the user gestures that grant `activeTab`, so most tweaks would go without a screenshot. Content scripts are still registered only for claimed patterns, so unclaimed pages stay untouched in practice, even though the permission would allow more.

## Considered Options

- **Ask for each domain, screenshots through `activeTab`.** The prompts are narrower, but only tweaks started from the toolbar, a shortcut or the context menu get a screenshot, and there is still one prompt per new dev domain.
- **Ask for each domain, then `<all_urls>` the first time a screenshot is needed.** The broad prompt comes anyway, later and at a more confusing moment, on top of the per-domain prompts.

## Consequences

- The one prompt reads "read and change all your data on all websites". The side panel says why before the button, and a Chrome Web Store listing will need the same reason. Because the permission is optional, it isn't requested at install.
- A new dev domain (`*.test`, `lvh.me`) needs no further prompt after the first.
- With access to every URL, the worker can read any tab's URL, so the badge's grey `!` is limited to origins that look like a dev server, to avoid putting a `!` on every website.
- Before access is granted, the worker can't read tab URLs, and we don't add the `tabs` permission (with its "read your browsing history" install warning) to fix that. So until you click **Allow access**, one grey `!` shows on the toolbar icon in every tab, meaning "action needed", rather than only on the claimed page.
- If you remove the access in `chrome://extensions`, the extension goes back to the Allow state. Registrations stay in place but don't inject until access is granted again.
