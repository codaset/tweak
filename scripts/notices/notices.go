package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// The release targets, as in .github/workflows/release.yml.
var defaultTargets = []string{"darwin/arm64", "darwin/amd64", "linux/amd64", "linux/arm64", "windows/amd64"}

var (
	// Files that carry a licence or a notice: LICENSE, LICENSE.md,
	// LICENSE-3RD-PARTY.md, NOTICE, PATENTS and the like, but not license.go.
	// Each one in a module's folder, or in the folder of a compiled package or
	// any folder between, is copied.
	licenceName = regexp.MustCompile(`(?i)^(licen[cs]e|copying|notice|patents|unlicense)([-_ ][^.]*)?(\.(txt|md|rst))?$`)
	// The module's own licence, which must be on the allowlist.
	mainLicenceName = regexp.MustCompile(`(?i)^(licen[cs]e|copying)(\.(txt|md))?$`)
)

const stdKey = "std"

type options struct {
	Dir     string   // the main module's folder
	Package string   // the main package, e.g. ./cmd/tweak
	Version string   // the Tweak version, for the heading
	Targets []string // GOOS/GOARCH pairs
}

// unit is the standard library or one module.
type unit struct {
	path, version, replace string
	root                   string            // its folder
	dirs                   map[string]bool   // folders of its compiled packages
	targets                map[string]bool   // targets it's compiled into
	files                  map[string][]byte // licence files, by path relative to root
}

type listedPackage struct {
	ImportPath string
	Dir        string
	Standard   bool
	Module     *struct {
		Path, Version, Dir string
		Main               bool
		Replace            *struct{ Path, Version, Dir string }
	}
}

func generate(opts options) (string, error) {
	env, err := goEnv(opts.Dir)
	if err != nil {
		return "", err
	}
	units := map[string]*unit{}
	for _, target := range opts.Targets {
		pkgs, err := listDeps(opts.Dir, opts.Package, target)
		if err != nil {
			return "", err
		}
		for _, p := range pkgs {
			var u *unit
			switch {
			case p.Standard:
				u = units[stdKey]
				if u == nil {
					u = &unit{path: "Go standard library", version: env.GOVERSION, root: env.GOROOT}
				}
				units[stdKey] = u
			case p.Module == nil:
				return "", fmt.Errorf("%s isn't in a module", p.ImportPath)
			case p.Module.Main:
				continue
			default:
				m := p.Module
				u = units[m.Path]
				if u == nil {
					u = &unit{path: m.Path, version: m.Version, root: m.Dir}
					if r := m.Replace; r != nil {
						u.replace = strings.TrimSpace(r.Path + " " + r.Version)
						if r.Dir != "" {
							u.root = r.Dir
						}
					}
					if u.root == "" {
						return "", fmt.Errorf("%s %s isn't in the module cache: run go mod download", m.Path, m.Version)
					}
				}
				units[m.Path] = u
			}
			if u.dirs == nil {
				u.dirs, u.targets = map[string]bool{}, map[string]bool{}
			}
			u.dirs[p.Dir] = true
			u.targets[target] = true
		}
	}

	var problems []string
	for _, u := range units {
		if err := u.readFiles(); err != nil {
			return "", err
		}
		if p := u.check(); p != "" {
			problems = append(problems, p)
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return "", errors.New("licence check failed:\n  " + strings.Join(problems, "\n  "))
	}
	return render(opts, env.GOVERSION, units), nil
}

type goEnvironment struct{ GOROOT, GOVERSION string }

func goEnv(dir string) (goEnvironment, error) {
	cmd := exec.Command("go", "env", "-json", "GOROOT", "GOVERSION")
	cmd.Dir = dir
	out, err := output(cmd)
	var env goEnvironment
	if err == nil {
		err = json.Unmarshal(out, &env)
	}
	return env, err
}

func listDeps(dir, pkg, target string) ([]listedPackage, error) {
	goos, goarch, ok := strings.Cut(target, "/")
	if !ok {
		return nil, fmt.Errorf("target %q isn't GOOS/GOARCH", target)
	}
	cmd := exec.Command("go", "list", "-deps", "-json=ImportPath,Dir,Standard,Module", pkg)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED=0")
	out, err := output(cmd)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", target, err)
	}
	var pkgs []listedPackage
	dec := json.NewDecoder(bytes.NewReader(out))
	for {
		var p listedPackage
		if err := dec.Decode(&p); err == io.EOF {
			return pkgs, nil
		} else if err != nil {
			return nil, err
		}
		pkgs = append(pkgs, p)
	}
}

func output(cmd *exec.Cmd) ([]byte, error) {
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%s: %v: %s", strings.Join(cmd.Args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// readFiles collects the licence files in the unit's folder and in each
// compiled package's folder and the folders between.
func (u *unit) readFiles() error {
	u.files = map[string][]byte{}
	seen := map[string]bool{}
	for dir := range u.dirs {
		for {
			rel, err := filepath.Rel(u.root, dir)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return fmt.Errorf("%s: package folder %s is outside %s", u.path, dir, u.root)
			}
			if !seen[dir] {
				seen[dir] = true
				entries, err := os.ReadDir(dir)
				if err != nil {
					return err
				}
				for _, e := range entries {
					if !e.Type().IsRegular() || !licenceName.MatchString(e.Name()) {
						continue
					}
					text, err := os.ReadFile(filepath.Join(dir, e.Name()))
					if err != nil {
						return err
					}
					u.files[filepath.ToSlash(filepath.Join(rel, e.Name()))] = text
				}
			}
			if rel == "." {
				break
			}
			dir = filepath.Dir(dir)
		}
	}
	return nil
}

// mainLicence is the unit's own licence file, in its folder.
func (u *unit) mainLicence() string {
	var names []string
	for name := range u.files {
		if mainLicenceName.MatchString(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return ""
	}
	return names[0]
}

func (u *unit) heading() string {
	return strings.TrimSpace(u.path + " " + u.version)
}

func (u *unit) check() string {
	name := u.mainLicence()
	if name == "" {
		return u.heading() + ": no licence file (LICENSE, LICENCE or COPYING)"
	}
	if _, ok := identify(string(u.files[name])); !ok {
		return fmt.Sprintf("%s: %s isn't MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or ISC", u.heading(), name)
	}
	return ""
}

func render(opts options, goVersion string, units map[string]*unit) string {
	var b strings.Builder
	release := "Codaset Tweak"
	if opts.Version != "" {
		release += " " + opts.Version
	}
	fmt.Fprintf(&b, "# Go licence notices\n\n"+
		"The licences of the Go code compiled into the `tweak` binary of %s, built with %s for %s. "+
		"Each release generates this file with `scripts/notices`: don't edit it by hand.\n",
		release, goVersion, strings.Join(opts.Targets, ", "))

	keys := make([]string, 0, len(units))
	for k := range units {
		if k != stdKey {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if units[stdKey] != nil {
		keys = append([]string{stdKey}, keys...)
	}
	for _, k := range keys {
		u := units[k]
		main := u.mainLicence()
		licence, _ := identify(string(u.files[main]))
		fmt.Fprintf(&b, "\n## %s\n\n", u.heading())
		if u.replace != "" {
			fmt.Fprintf(&b, "- Replaced by: %s\n", u.replace)
		}
		fmt.Fprintf(&b, "- Licence: %s\n- Built into: %s\n", licence, targetList(opts.Targets, u.targets))

		names := make([]string, 0, len(u.files))
		for name := range u.files {
			if name != main {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		for _, name := range append([]string{main}, names...) {
			fmt.Fprintf(&b, "\n### %s\n\n", name)
			writeFenced(&b, string(u.files[name]))
		}
	}
	return b.String()
}

func targetList(all []string, in map[string]bool) string {
	var list []string
	for _, t := range all {
		if in[t] {
			list = append(list, t)
		}
	}
	if len(list) == len(all) {
		return "all targets"
	}
	return strings.Join(list, ", ")
}

var backticks = regexp.MustCompile("`+")

// writeFenced writes text verbatim in a code fence longer than any run of
// backticks inside it.
func writeFenced(b *strings.Builder, text string) {
	longest := 2
	for _, run := range backticks.FindAllString(text, -1) {
		longest = max(longest, len(run))
	}
	fence := strings.Repeat("`", longest+1)
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	fmt.Fprintf(b, "%stext\n%s%s\n", fence, text, fence)
}
