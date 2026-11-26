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
// project-relative one, or a dev-server URL, /@fs/ included. A path that
// can't be placed gives ok false, and the brief shows it as given.
func Place(folder, given string) (rel string, ok bool) {
	if folder == "" || given == "" {
		return "", false
	}
	p := given
	if u, err := url.Parse(given); err == nil && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "file") {
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

var windowsDrive = regexp.MustCompile(`^/[A-Za-z]:/`)

// inside is file relative to folder, if file is a regular file within it.
// Symlinks are resolved on both when the plain paths don't agree, since
// frameworks report real paths and folders (macOS /tmp) may be links.
func inside(folder, file string) (string, bool) {
	if info, err := os.Stat(file); err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	if rel, ok := within(folder, file); ok {
		return rel, true
	}
	realFolder, err1 := filepath.EvalSymlinks(folder)
	realFile, err2 := filepath.EvalSymlinks(file)
	if err1 != nil || err2 != nil {
		return "", false
	}
	return within(realFolder, realFile)
}

func within(folder, file string) (string, bool) {
	rel, err := filepath.Rel(folder, file)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}
