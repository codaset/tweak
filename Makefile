# The plugin's version, from the launcher's VERSION= line (the release workflow keeps them in step).
VERSION := $(shell sed -n 's/^VERSION=//p' plugins/codaset/bin/tweak)
# TWEAK_STATE_DIR moves the state folder, as it does for the launcher and the binary.
STATE   := $(or $(TWEAK_STATE_DIR),$(HOME)/.local/state/codaset-tweak)

.PHONY: build install

# A development build (version "dev") for TWEAK_BIN and the e2e suite.
build:
	go build -o dist/tweak ./cmd/tweak

# Your local build as your Tweak: stamped with the plugin's version and put where the plugin's
# launcher looks before downloading, so every Claude Code session with the plugin runs it, on the
# usual port and state folder. A running bridge is stopped; the next tweak command, or a watcher
# within about 10 seconds, starts this one. Releases are built by .github/workflows/release.yml.
install:
	@mkdir -p "$(STATE)/bin/$(VERSION)"
	go build -trimpath -ldflags "-X github.com/codaset/tweak/internal/version.Version=$(VERSION)" \
		-o "$(STATE)/bin/$(VERSION)/.tweak.make.download" ./cmd/tweak
	@mv -f "$(STATE)/bin/$(VERSION)/.tweak.make.download" "$(STATE)/bin/$(VERSION)/tweak"
	@echo "installed tweak $(VERSION) at $(STATE)/bin/$(VERSION)/tweak"
	@port=$$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$(STATE)/bridge.json" 2>/dev/null); \
	if [ -n "$$port" ] && curl -fsS -m 5 -X POST -H 'x-tweak: 1' "http://127.0.0.1:$$port/shutdown" >/dev/null 2>&1; then \
		echo "stopped the running bridge: the next tweak command, or a watcher within about 10 seconds, starts the new one"; fi
