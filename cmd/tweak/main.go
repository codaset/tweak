// Command tweak is the Codaset Tweak binary: the bridge, the CLI the /tweak
// skill runs, and the plugin's hooks.
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/codaset/tweak/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	switch args[0] {
	case "version":
		fmt.Fprintf(stdout, "binary %s\nprotocol %d\n", version.Version, version.Protocol)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q: run tweak with no arguments to list commands\n", args[0])
		return 2
	}
}

func usage(w io.Writer) {
	fmt.Fprint(w, `usage: tweak <command>

commands:
  version   print the binary and protocol versions
`)
}
