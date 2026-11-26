package brief

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathsArePlacedInTheProject(t *testing.T) {
	project := t.TempDir() // behind a symlink on macOS: /var is /private/var
	os.MkdirAll(filepath.Join(project, "src", "my components"), 0o755)
	os.WriteFile(filepath.Join(project, "src", "App.tsx"), nil, 0o644)
	os.WriteFile(filepath.Join(project, "src", "my components", "Card.vue"), nil, 0o644)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(outside, nil, 0o644)
	real, _ := filepath.EvalSymlinks(project)
	slash := filepath.ToSlash

	for _, c := range []struct{ given, want string }{
		{project + "/src/App.tsx", "src/App.tsx"},                     // absolute (React 18, Vue)
		{real + "/src/App.tsx", "src/App.tsx"},                        // the real path, symlinks resolved
		{"src/App.tsx", "src/App.tsx"},                                // project-relative (Svelte)
		{"./src/App.tsx", "src/App.tsx"},                              //
		{"http://localhost:5173/src/App.tsx?t=1712#x", "src/App.tsx"}, // a dev-server URL (React 19)
		{"/src/App.tsx", "src/App.tsx"},                               // a path from the server's root
		{"http://localhost:5173/@fs/" + strings.TrimPrefix(slash(real), "/") + "/src/App.tsx", "src/App.tsx"}, // /@fs/, outside the Vite root
		{"/@fs/" + strings.TrimPrefix(slash(project), "/") + "/src/App.tsx", "src/App.tsx"},                   //
		{"http://localhost:5173/src/my%20components/Card.vue", "src/my components/Card.vue"},
	} {
		if got, ok := Place(project, c.given); !ok || got != c.want {
			t.Errorf("Place(%q) = %q, %v; want %q", c.given, got, ok, c.want)
		}
	}

	for _, given := range []string{
		outside, // absolute, outside the project
		"../" + filepath.Base(filepath.Dir(outside)) + "/secret.txt",
		"src/../../secret.txt",                // escaping with ..
		"http://localhost:5173/../secret.txt", //
		"src/Missing.tsx",                     // not there
		"src",                                 // a folder, not a file
		"http://localhost:5173/assets/app-3f2a.css", // a built asset
		"",
	} {
		if got, ok := Place(project, given); ok {
			t.Errorf("Place(%q) = %q; want not found", given, got)
		}
	}

	if _, ok := Place("", "src/App.tsx"); ok {
		t.Error("placed a path with no project folder")
	}
}
