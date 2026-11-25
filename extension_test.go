package tweak

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
)

// Chrome derives an extension's ID from its public key: the first 16 bytes of
// the key's SHA-256, written in hex with the digits 0-f mapped to a-p.
func extensionIDFromKey(t *testing.T, key string) string {
	t.Helper()
	der, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		t.Fatalf("manifest key isn't base64: %v", err)
	}
	sum := sha256.Sum256(der)
	id := []byte(hex.EncodeToString(sum[:16]))
	for i, c := range id {
		if c <= '9' {
			id[i] = 'a' + (c - '0')
		} else {
			id[i] = 'a' + 10 + (c - 'a')
		}
	}
	return string(id)
}

func TestEmbeddedManifestKeyGivesExtensionID(t *testing.T) {
	raw, err := Extension.ReadFile("extension/manifest.json")
	if err != nil {
		t.Fatalf("manifest not embedded: %v", err)
	}
	var m struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("manifest isn't JSON: %v", err)
	}
	if got := extensionIDFromKey(t, m.Key); got != ExtensionID {
		t.Fatalf("manifest key gives extension ID %s, want %s", got, ExtensionID)
	}
}
