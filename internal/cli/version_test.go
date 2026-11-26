package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/config"
	"github.com/codaset/tweak/internal/version"
)

// tweak version prints what GET /bridge says: the bridge's version, its
// protocol when it isn't this binary's, and the connected extension's.
func TestVersionNamesTheBridgeAndExtension(t *testing.T) {
	for _, tc := range []struct {
		name string
		info bridge.Info
		want string
	}{
		{"connected", bridge.Info{Version: "0.2.0", Protocol: version.Protocol, Extension: "0.2.0"}, "bridge 0.2.0\nextension 0.2.0\n"},
		{"another protocol", bridge.Info{Version: "0.3.0", Protocol: version.Protocol + 1}, fmt.Sprintf("bridge 0.3.0 (protocol %d)\nextension not connected\n", version.Protocol+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set(bridge.HeaderVersion, tc.info.Version)
				json.NewEncoder(w).Encode(tc.info)
			}))
			defer srv.Close()
			_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
			var n int
			fmt.Sscan(port, &n)
			var out bytes.Buffer
			c := &context{Env: Env{Stdout: &out}, cfg: config.Config{Port: n, StateDir: t.TempDir()}}
			if err := showVersion(c, nil); err != nil {
				t.Fatal(err)
			}
			if want := fmt.Sprintf("binary %s\nprotocol %d\n", version.Version, version.Protocol) + tc.want; out.String() != want {
				t.Fatalf("got %q, want %q", out.String(), want)
			}
		})
	}
}
