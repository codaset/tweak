package brief

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// webpack names a module's sources webpack://<name>/./path. Each source in
// the captured map of the React 19 webpack build
// (test/extension/fixtures/react19-webpack) is placed in the project, as a
// dev-server URL is.
func TestWebpackSourcesArePlacedInTheProject(t *testing.T) {
	raw, err := os.ReadFile("../../test/extension/fixtures/react19-webpack/main.js.map")
	if err != nil {
		t.Fatal(err)
	}
	var m struct{ Sources []string }
	if err := json.Unmarshal(raw, &m); err != nil || len(m.Sources) == 0 {
		t.Fatal("no sources in the captured map", err)
	}
	project := t.TempDir()
	os.MkdirAll(filepath.Join(project, "src"), 0o755)
	for _, f := range []string{"App.jsx", "Button.jsx", "Panel.jsx", "Toolbar.jsx", "main.jsx"} {
		os.WriteFile(filepath.Join(project, "src", f), nil, 0o644)
	}
	for _, given := range m.Sources {
		want := "src/" + filepath.Base(given)
		if got, ok := Place(project, given); !ok || got != want {
			t.Errorf("Place(%q) = %q, %v; want %q", given, got, ok, want)
		}
	}

	for _, c := range []struct{ given, want string }{
		{"webpack:///./src/App.jsx", "src/App.jsx"},                // no name
		{"webpack://[name]/./src/App.jsx", "src/App.jsx"},          // the template left unfilled
		{"webpack://@scope/app/./src/App.jsx", "src/App.jsx"},      // a scoped package's name
		{"webpack://wp/src/App.jsx", "src/App.jsx"},                // no ./
		{"webpack://wp/./src/App.jsx?babel-loader", "src/App.jsx"}, // a loader query
	} {
		if got, ok := Place(project, c.given); !ok || got != c.want {
			t.Errorf("Place(%q) = %q, %v; want %q", c.given, got, ok, c.want)
		}
	}

	for _, given := range []string{
		"webpack://wp/./node_modules/react/index.js", // not in the project
		"webpack://wp/./../secret.txt",               // escaping with ..
		"webpack://wp/../secret.txt",
		"webpack://",
	} {
		if got, ok := Place(project, given); ok {
			t.Errorf("Place(%q) = %q; want not found", given, got)
		}
	}
}
