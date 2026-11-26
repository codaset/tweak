package cli

import (
	"fmt"
	"net/url"

	"github.com/codaset/tweak/internal/allowrule"
)

type claimOut struct {
	Pattern string `json:"pattern"`
	Session struct {
		ID     string `json:"id"`
		Folder string `json:"folder"`
	} `json:"session"`
	Warnings []string `json:"warnings"`
}

// claim registers the session and claims a pattern.
func claim(c *context, args []string) error {
	if len(args) != 1 {
		return usageError("usage: tweak claim <url>, for example tweak claim https://ernie.localhost/*")
	}
	if c.session == "" {
		return errNoSession
	}
	cl, err := c.connect()
	if err != nil {
		return err
	}
	if err := cl.call("POST", "/sessions", map[string]string{"agent": "claude-code", "folder": c.Dir}, nil); err != nil {
		return err
	}
	var made claimOut
	if err := cl.call("POST", "/claims", map[string]string{"pattern": args[0]}, &made); err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "claimed %s\n", made.Pattern)
	warnings := made.Warnings
	if !allowrule.Present(c.Getenv, c.Home, c.Dir) {
		warnings = append(warnings, fmt.Sprintf("allow rule missing: add %q to permissions.allow in your Claude Code settings, or tweak commands may stop for permission", allowrule.Rule))
	}
	for _, w := range warnings {
		fmt.Fprintln(c.Stdout, w)
	}
	fmt.Fprintln(c.Stdout, "now run tweak watch")
	return nil
}

// listClaims prints every claim: pattern, session and folder, one per line.
func listClaims(c *context, args []string) error {
	if len(args) != 0 {
		return usageError("usage: tweak claims")
	}
	cl, err := c.connect()
	if err != nil {
		return err
	}
	var out struct{ Claims []claimOut }
	if err := cl.call("GET", "/claims", nil, &out); err != nil {
		return err
	}
	if len(out.Claims) == 0 {
		fmt.Fprintln(c.Stdout, "no claims")
	}
	for _, x := range out.Claims {
		fmt.Fprintf(c.Stdout, "%s  session %s in %s\n", x.Pattern, x.Session.ID, x.Session.Folder)
	}
	return nil
}

// release ends one of this session's claims, or all of them.
func release(c *context, args []string) error {
	if len(args) > 1 {
		return usageError("usage: tweak release [pattern]")
	}
	if c.session == "" {
		return errNoSession
	}
	cl, err := c.connect()
	if err != nil {
		return err
	}
	path := "/claims"
	if len(args) == 1 {
		path += "?pattern=" + url.QueryEscape(args[0])
	}
	var out struct{ Released []string }
	if err := cl.call("DELETE", path, nil, &out); err != nil {
		return err
	}
	if len(out.Released) == 0 {
		fmt.Fprintln(c.Stdout, "no claims to release")
	}
	for _, p := range out.Released {
		fmt.Fprintf(c.Stdout, "released %s\n", p)
	}
	return nil
}
