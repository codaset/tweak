package brief

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Place turns a path as the page gave it into a project-relative one, with
// forward slashes, if it names a file inside folder (docs/design.md,
// "Finding the source", Paths). The page may give an absolute path, a
// project-relative one, a dev-server URL, /@fs/ included, or a webpack
// source (webpack://<name>/./path). A path that
// can't be placed gives ok false, and the brief shows it as given.
func Place(folder, given string) (rel string, ok bool) {
	if folder == "" || given == "" {
		return "", false
	}
	p := given
	if rest, found := strings.CutPrefix(given, "webpack://"); found {
		p = webpackPath(rest)
	} else if u, err := url.Parse(given); err == nil && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "file") {
		p = u.Path // decoded, without the query and hash
	}
	if rest, found := strings.CutPrefix(p, "/@fs/"); found {
		p = "/" + rest
		if windowsDrive.MatchString(p) {
			p = p[1:] // /@fs/C:/x is C:/x
		}
	}
	native := filepath.FromSlash(p)
	var tries []string
	if filepath.IsAbs(native) {
		tries = append(tries, native)
	}
	// A path from the server's root, or one relative to the project.
	tries = append(tries, filepath.Join(folder, native))
	for _, try := range tries {
		if rel, ok := inside(folder, filepath.Clean(try)); ok {
			return rel, true
		}
	}
	return "", false
}

// webpackPath is a webpack://<name>/./path source (after the scheme) as a
// path relative to the project: the name dropped (empty, `[name]`, or a
// scoped package's @scope/name), then any loader query and a leading ./.
// Cut as a string: url.Parse refuses a bracketed `[name]` host.
func webpackPath(rest string) string {
	skip := 1
	if strings.HasPrefix(rest, "@") {
		skip = 2
	}
	for range skip {
		_, after, ok := strings.Cut(rest, "/")
		if !ok {
			return ""
		}
		rest = after
	}
	if i := strings.IndexAny(rest, "?#"); i >= 0 {
		rest = rest[:i]
	}
	return strings.TrimPrefix(rest, "./")
}

var windowsDrive = regexp.MustCompile(`^/[A-Za-z]:/`)

// stat is os.Stat; a test watches what is looked at.
var stat = os.Stat

// inside is file relative to folder, if file is a regular file within it.
// Containment is checked on the path alone, against the folder as given and
// with its symlinks resolved (frameworks report real paths, and a folder
// such as macOS /tmp may be a link), before the disk is touched: the path
// came from the page.
func inside(folder, file string) (string, bool) {
	rel, ok := within(folder, file)
	if !ok {
		real, err := filepath.EvalSymlinks(folder)
		if err != nil {
			return "", false
		}
		if rel, ok = within(real, file); !ok {
			return "", false
		}
	}
	path := filepath.Join(folder, filepath.FromSlash(rel))
	if info, err := stat(path); err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	// A link in the project counts only if it leads to a file in the
	// project: one leading outside isn't a project file to edit.
	realFolder, err1 := filepath.EvalSymlinks(folder)
	realPath, err2 := filepath.EvalSymlinks(path)
	if err1 != nil || err2 != nil {
		return "", false
	}
	if _, ok := within(realFolder, realPath); !ok {
		return "", false
	}
	return rel, true
}

func within(folder, file string) (string, bool) {
	rel, err := filepath.Rel(folder, file)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}
