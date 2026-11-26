package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	tweak "github.com/codaset/tweak"
	"github.com/codaset/tweak/internal/pattern"
	"github.com/codaset/tweak/internal/store"
	"github.com/codaset/tweak/internal/version"
)

// Headers of the bridge contract.
const (
	HeaderTweak    = "x-tweak"          // always "1": a web page can't send it without a preflight
	HeaderProtocol = "x-tweak-protocol" // the client's protocol integer
	HeaderSession  = "x-tweak-session"  // the agent's session ID
	HeaderVersion  = "x-tweak-version"  // on every response: the bridge's version
)

func (b *Bridge) routes() http.Handler {
	mux := http.NewServeMux()
	// Exempt from the protocol check, so any CLI can find and replace an older bridge.
	mux.HandleFunc("GET /bridge", func(w http.ResponseWriter, r *http.Request) { reply(w, 200, b.info()) })
	mux.HandleFunc("POST /shutdown", b.shutdown)
	// The extension's socket: its protocol is checked in the hello.
	mux.HandleFunc("GET /ws", b.socket)

	api := http.NewServeMux()
	api.HandleFunc("POST /sessions", b.registerSession)
	api.HandleFunc("GET /claims", b.listClaims)
	api.HandleFunc("POST /claims", b.claim)
	api.HandleFunc("DELETE /claims", b.release)
	api.HandleFunc("GET /inbox", b.inbox)
	api.HandleFunc("POST /tweaks/{n}/work", b.work)
	api.HandleFunc("POST /tweaks/{n}/status", b.status)
	api.HandleFunc("POST /tweaks/{n}/entries", b.entries)
	api.HandleFunc("POST /edits/before", b.editBefore)
	api.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		refuse(w, 404, "not-found", fmt.Sprintf("no such endpoint: %s %s", r.Method, r.URL.Path))
	})
	mux.Handle("/", b.checkProtocol(b.checkIn(api)))

	return b.versioned(b.guard(mux))
}

// versioned sets x-tweak-version on every response, refusals included.
func (b *Bridge) versioned(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(HeaderVersion, b.opts.Version)
		next.ServeHTTP(w, r)
	})
}

// extensionOrigin is the Codaset Tweak extension's exact origin: its ID is
// fixed by the manifest's pinned key, so no other extension can call the bridge.
var extensionOrigin = "chrome-extension://" + tweak.ExtensionID

// guard is the Security section of docs/design.md: only 127.0.0.1:<port> or
// localhost:<port> as Host (no DNS rebinding), no Origin but the extension's,
// and x-tweak: 1 on every request. No CORS header is ever sent, so no
// preflight passes.
func (b *Bridge) guard(next http.Handler) http.Handler {
	hosts := map[string]bool{
		fmt.Sprintf("127.0.0.1:%d", b.Port()): true,
		fmt.Sprintf("localhost:%d", b.Port()): true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch origin := r.Header.Get("Origin"); {
		case !hosts[strings.ToLower(r.Host)]:
			refuse(w, 403, "forbidden", fmt.Sprintf("Host %q refused: use 127.0.0.1:%d", r.Host, b.Port()))
		case r.URL.Path == "/ws":
			// A WebSocket can't carry x-tweak, so its Origin must be exactly the
			// extension's: never absent, never a web page's.
			if origin != extensionOrigin {
				refuse(w, 403, "forbidden", fmt.Sprintf("WebSocket from Origin %q refused: only the Codaset Tweak extension may connect", origin))
				return
			}
			next.ServeHTTP(w, r)
		case origin != "" && origin != extensionOrigin:
			refuse(w, 403, "forbidden", fmt.Sprintf("Origin %q refused: only the Codaset Tweak extension and the CLI may call the bridge", origin))
		case r.Header.Get(HeaderTweak) != "1":
			refuse(w, 403, "forbidden", "x-tweak: 1 header missing")
		default:
			next.ServeHTTP(w, r)
		}
	})
}

func (b *Bridge) checkProtocol(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(HeaderProtocol)
		if got == "" {
			refuse(w, 400, "protocol", fmt.Sprintf("no %s header; the bridge speaks protocol %d: update the plugin, then /reload-plugins", HeaderProtocol, version.Protocol))
			return
		}
		if got != strconv.Itoa(version.Protocol) {
			refuse(w, 400, "protocol", fmt.Sprintf("tweak speaks protocol %s; the bridge speaks %d: update the plugin, then /reload-plugins", got, version.Protocol))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// checkIn counts every request from a registered session as a check-in.
func (b *Bridge) checkIn(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := r.Header.Get(HeaderSession); id != "" {
			if _, err := b.store.CheckIn(id); err != nil {
				b.log.Printf("check-in %s: %v", id, err)
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (b *Bridge) shutdown(w http.ResponseWriter, r *http.Request) {
	reply(w, 202, map[string]string{"status": "stopping"})
	b.Shutdown()
}

func (b *Bridge) registerSession(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}
	var body struct{ Agent, Folder, Label string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Agent == "" || body.Folder == "" {
		refuse(w, 400, "bad-request", "POST /sessions needs agent and folder")
		return
	}
	if err := b.store.RegisterSession(store.Session{ID: id, Agent: body.Agent, Folder: body.Folder, Label: body.Label}); err != nil {
		b.internal(w, err)
		return
	}
	se, err := b.store.Session(id)
	if err != nil {
		b.internal(w, err)
		return
	}
	reply(w, 200, sessionJSON(se))
}

func (b *Bridge) listClaims(w http.ResponseWriter, r *http.Request) {
	claims, err := b.store.Claims()
	if err != nil {
		b.internal(w, err)
		return
	}
	out := struct {
		Claims []claimOut `json:"claims"`
	}{Claims: []claimOut{}}
	for _, c := range claims {
		out.Claims = append(out.Claims, claimJSON(c))
	}
	reply(w, 200, out)
}

func (b *Bridge) claim(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}
	var body struct{ Pattern string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		refuse(w, 400, "bad-request", "POST /claims needs a pattern")
		return
	}
	p, err := pattern.Parse(body.Pattern)
	if err != nil {
		refuse(w, 400, "bad-pattern", err.Error())
		return
	}
	c, err := b.store.Claim(id, p)
	var overlap *store.OverlapError
	switch {
	case errors.As(err, &overlap):
		holder := claimJSON(overlap.Holder)
		reply(w, 409, errorOut{Error: "overlap", Message: err.Error(), Holder: &holder})
	case errors.Is(err, store.ErrNoSession):
		refuse(w, 404, "no-session", fmt.Sprintf("session %s isn't registered: run tweak claim", id))
	case err != nil:
		b.internal(w, err)
	default:
		reply(w, 201, claimReply{claimJSON(c), b.claimWarnings()})
	}
}

func (b *Bridge) release(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}
	// No pattern parameter releases all of the session's claims; one that is
	// present, even empty, must be a valid pattern.
	want := ""
	if raw, given := r.URL.Query()["pattern"]; given {
		p, err := pattern.Parse(raw[0])
		if err != nil {
			refuse(w, 400, "bad-pattern", err.Error())
			return
		}
		want = p.String()
	}
	released, err := b.store.Release(id, want)
	// Releasing the capturing tweak's page, or every claim, ends its undo
	// capture (docs/design.md, "Capture").
	if err == nil && b.releaseEndsCapture(id, released) {
		if cerr := b.endCapture(id); cerr != nil {
			b.log.Printf("release: ending capture for %s: %v", id, cerr)
		}
	}
	switch {
	case errors.Is(err, store.ErrNotClaimed):
		refuse(w, 404, "not-claimed", fmt.Sprintf("%s isn't claimed by this session: run tweak claims", want))
	case err != nil:
		b.internal(w, err)
	default:
		if released == nil {
			released = []string{}
		}
		reply(w, 200, map[string][]string{"released": released})
	}
}

func sessionID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.Header.Get(HeaderSession)
	if id == "" {
		refuse(w, 400, "no-session-id", "no session ID: run tweak inside Claude Code, or pass --session <id>")
	}
	return id, id != ""
}

type sessionOut struct {
	ID          string `json:"id"`
	Agent       string `json:"agent"`
	Folder      string `json:"folder"`
	Label       string `json:"label"`
	LastCheckIn string `json:"lastCheckIn"`
}

type claimOut struct {
	ID      int64      `json:"id"`
	Pattern string     `json:"pattern"`
	Session sessionOut `json:"session"`
	Created string     `json:"created"`
}

// claimReply is the reply to POST /claims: the claim, and the lines tweak
// claim prints as warnings.
type claimReply struct {
	claimOut
	Warnings []string `json:"warnings,omitempty"`
}

type errorOut struct {
	Error   string    `json:"error"`
	Message string    `json:"message"`
	Holder  *claimOut `json:"holder,omitempty"`
}

// stamp is RFC 3339 in UTC with milliseconds, the store's precision.
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }

func sessionJSON(s store.Session) sessionOut {
	return sessionOut{ID: s.ID, Agent: s.Agent, Folder: s.Folder, Label: s.Label, LastCheckIn: stamp(s.LastCheckIn)}
}

func claimJSON(c store.Claim) claimOut {
	return claimOut{ID: c.ID, Pattern: c.Pattern, Session: sessionJSON(c.Session), Created: stamp(c.Created)}
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func refuse(w http.ResponseWriter, status int, code, message string) {
	reply(w, status, errorOut{Error: code, Message: message})
}

func (b *Bridge) internal(w http.ResponseWriter, err error) {
	b.log.Print(err)
	refuse(w, 500, "internal", "the bridge failed: "+err.Error())
}
