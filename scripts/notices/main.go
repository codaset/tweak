// Command notices writes the licence notices of the Go code compiled into the
// tweak binary: the standard library and every module, for each release
// target, with each module's licence identified against an allowlist.
//
//	go run ./scripts/notices [-C dir] [-version X.Y.Z] [-o file] [package]
//
// It fails, writing nothing, when a module has no licence file or one that
// isn't on the allowlist. The release workflow writes the result beside the
// plugin's THIRD_PARTY_NOTICES.md; CI runs it on every push. See
// docs/design.md, "Third-party notices".
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "notices:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("notices", flag.ContinueOnError)
	dir := flags.String("C", ".", "the module's folder")
	version := flags.String("version", "", "the Tweak version the notices are for")
	out := flags.String("o", "", "write the notices to this file instead of stdout")
	if err := flags.Parse(args); err != nil {
		return err
	}
	pkg := "./cmd/tweak"
	switch flags.NArg() {
	case 0:
	case 1:
		pkg = flags.Arg(0)
	default:
		return fmt.Errorf("one package at most, got %v", flags.Args())
	}

	notices, err := generate(options{Dir: *dir, Package: pkg, Version: *version, Targets: defaultTargets})
	if err != nil {
		return err
	}
	if *out == "" {
		_, err = io.WriteString(stdout, notices)
		return err
	}
	return os.WriteFile(*out, []byte(notices), 0o644)
}
