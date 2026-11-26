// Package schema holds the bridge contract's JSON Schema files; this test checks
// the Go side against the shared examples.
package schema

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// schemaFor returns the schema file an example belongs to: the part of its
// name before the first dot.
func schemaFor(example string) string {
	name, _, _ := strings.Cut(filepath.Base(example), ".")
	return name + ".json"
}

func compile(t *testing.T, file string) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	s, err := c.Compile(file)
	if err != nil {
		t.Fatalf("compile %s: %v", file, err)
	}
	return s
}

func load(t *testing.T, file string) any {
	t.Helper()
	f, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	v, err := jsonschema.UnmarshalJSON(f)
	if err != nil {
		t.Fatalf("%s isn't JSON: %v", file, err)
	}
	return v
}

func TestExamplesValidate(t *testing.T) {
	examples, _ := filepath.Glob("examples/*.json")
	if len(examples) == 0 {
		t.Fatal("no examples")
	}
	for _, ex := range examples {
		t.Run(filepath.Base(ex), func(t *testing.T) {
			if err := compile(t, schemaFor(ex)).Validate(load(t, ex)); err != nil {
				t.Errorf("should validate: %v", err)
			}
		})
	}
}

func TestInvalidExamplesAreRefused(t *testing.T) {
	examples, _ := filepath.Glob("examples/invalid/*.json")
	for _, ex := range examples {
		t.Run(filepath.Base(ex), func(t *testing.T) {
			if err := compile(t, schemaFor(ex)).Validate(load(t, ex)); err == nil {
				t.Error("should be refused")
			}
		})
	}
}

// The targets definitions are repeated in every schema that carries a
// tweak; the copies must not drift from create.json's.
func TestTargetsAreTheSameEverywhere(t *testing.T) {
	defs := func(file string) map[string]any {
		return load(t, file).(map[string]any)["$defs"].(map[string]any)
	}
	want := defs("create.json")
	for _, file := range []string{"event.json", "snapshot.json"} {
		got := defs(file)
		for _, name := range []string{"targets", "viewport", "element", "location", "clue", "size", "rule", "anchor", "selection", "area", "box"} {
			if !reflect.DeepEqual(got[name], want[name]) {
				t.Errorf("%s $defs.%s differs from create.json's", file, name)
			}
		}
	}
}

// Every schema needs both kinds of example (schema/README.md): one that
// validates and one that is refused.
func TestEverySchemaHasAValidAndAnInvalidExample(t *testing.T) {
	schemas, _ := filepath.Glob("*.json")
	if len(schemas) == 0 {
		t.Fatal("no schemas")
	}
	for _, s := range schemas {
		name := strings.TrimSuffix(s, ".json")
		if m, _ := filepath.Glob("examples/" + name + ".*.json"); len(m) == 0 {
			t.Errorf("%s has no valid example in examples/", s)
		}
		if m, _ := filepath.Glob("examples/invalid/" + name + ".*.json"); len(m) == 0 {
			t.Errorf("%s has no invalid example in examples/invalid/", s)
		}
	}
}
