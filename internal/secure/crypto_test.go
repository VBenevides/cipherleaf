package secure

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	key, err := RandomBytes(KeySize)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("# private note")
	aad := []byte("vault:note:one")

	nonce, ciphertext, err := Seal(key, plaintext, aad)
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := Open(key, nonce, ciphertext, aad)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("got %q, want %q", decrypted, plaintext)
	}
}

func TestOpenRejectsWrongKeyAndTampering(t *testing.T) {
	key, _ := RandomBytes(KeySize)
	wrongKey, _ := RandomBytes(KeySize)
	nonce, ciphertext, err := Seal(key, []byte("secret"), []byte("aad"))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := Open(wrongKey, nonce, ciphertext, []byte("aad")); err == nil {
		t.Fatal("expected wrong-key decryption to fail")
	}
	ciphertext[0] ^= 0xff
	if _, err := Open(key, nonce, ciphertext, []byte("aad")); err == nil {
		t.Fatal("expected tampered ciphertext to fail")
	}
}

func TestSealUsesUniqueNonces(t *testing.T) {
	key, _ := RandomBytes(KeySize)
	seen := make(map[string]struct{}, 256)
	for range 256 {
		nonce, _, err := Seal(key, []byte("same plaintext"), nil)
		if err != nil {
			t.Fatal(err)
		}
		encoded := string(nonce)
		if _, exists := seen[encoded]; exists {
			t.Fatal("nonce collision")
		}
		seen[encoded] = struct{}{}
	}
}

func TestRandomSecret256(t *testing.T) {
	first, err := RandomSecret256()
	if err != nil {
		t.Fatal(err)
	}
	second, err := RandomSecret256()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("generated secrets unexpectedly match")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(first)
	if err != nil {
		t.Fatalf("secret is not valid Base64URL: %v", err)
	}
	if len(decoded) != SecretSize {
		t.Fatalf("got %d secret bytes, want %d", len(decoded), SecretSize)
	}
	if !IsSecret256(first) || IsSecret256(first+"x") {
		t.Fatal("secret validation returned an unexpected result")
	}
}
