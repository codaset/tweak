// Command tweak is the Codaset Tweak binary: the bridge, the CLI the /tweak
// skill runs, and the plugin's hooks.
package main

import (
	"io"
	"os"

	"github.com/codaset/tweak/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], cli.OSEnv()))
}

func run(args []string, stdout, stderr io.Writer) int {
	env := cli.OSEnv()
	env.Stdout, env.Stderr = stdout, stderr
	return cli.Run(args, env)
}
