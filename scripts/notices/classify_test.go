package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readText(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "texts", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Real licence files, copied from the module cache, in the layouts modules
// actually use: a title before or after the copyright, numbered or bulleted
// clauses, a trailing URL, Apache with and without its appendix.
func TestIdentifiesPermissiveLicences(t *testing.T) {
	for file, want := range map[string]string{
		"mit-humanize":      "MIT",
		"mit-isatty":        "MIT",
		"mit-strftime":      "MIT",
		"bsd2-check":        "BSD-2-Clause",
		"bsd3-sqlite":       "BSD-3-Clause",
		"bsd3-uuid":         "BSD-3-Clause",
		"bsd3-libc":         "BSD-3-Clause",
		"isc-spew":          "ISC",
		"apache-btree":      "Apache-2.0",
		"apache-logr":       "Apache-2.0",
		"apache-jsonschema": "Apache-2.0",
	} {
		t.Run(file, func(t *testing.T) {
			got, ok := identify(readText(t, file))
			if !ok || got != want {
				t.Errorf("identify(%s) = %q, %v; want %q", file, got, ok, want)
			}
		})
	}
}

// Anything that isn't one of the allowlisted texts, word for word apart from
// the copyright holder, is unidentified, so it fails the release.
func TestRefusesAnythingElse(t *testing.T) {
	mit := readText(t, "mit-strftime")
	bsd3 := readText(t, "bsd3-sqlite")
	advertising := "3. All advertising materials mentioning features or use of this software\n" +
		"   must display the following acknowledgement: This product includes software\n" +
		"   developed by the author.\n\n"
	for name, text := range map[string]string{
		"empty":         "",
		"public domain": readText(t, "sqlite-public-domain"),
		"GPL": "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\n" +
			"Everyone is permitted to copy and distribute verbatim copies of this license document.",
		"MIT with an extra condition": strings.Replace(mit, "copies or substantial portions of the Software.",
			"copies or substantial portions of the Software.\n\nThe Software shall be used for Good, not Evil.", 1),
		"MIT with a sentence after it": mit + "\nThis licence doesn't apply to commercial use.\n",
		"BSD with an advertising clause": strings.Replace(bsd3, "THIS SOFTWARE IS PROVIDED",
			advertising+"THIS SOFTWARE IS PROVIDED", 1),
		"half an MIT licence": mit[:len(mit)/2],
	} {
		t.Run(name, func(t *testing.T) {
			if got, ok := identify(text); ok {
				t.Errorf("identify(%s) = %q; want unidentified", name, got)
			}
		})
	}
}
