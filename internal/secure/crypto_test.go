package secure

import (
	"bytes"
	"encoding/base64"
	"errors"
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

func TestCryptoValidation(t *testing.T) {
	if _, err := RandomBytes(0); err == nil {
		t.Fatal("expected non-positive random size error")
	}
	if _, err := DeriveKey("", make([]byte, 16), KDFParams{}); err == nil {
		t.Fatal("expected empty passphrase error")
	}
	if _, err := DeriveKey("pass", make([]byte, 15), KDFParams{}); err == nil {
		t.Fatal("expected short salt error")
	}
	if _, err := DeriveKey("pass", make([]byte, 16), KDFParams{Memory: 8 * 1024, Threads: 1}); err == nil {
		t.Fatal("expected zero time error")
	}
	if _, err := DeriveKey("pass", make([]byte, 16), KDFParams{Time: 1, Threads: 1}); err == nil {
		t.Fatal("expected low memory error")
	}
	if _, _, err := Seal(make([]byte, KeySize-1), nil, nil); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("Seal invalid key = %v", err)
	}
	if _, err := Open(make([]byte, KeySize-1), nil, nil, nil); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("Open invalid key = %v", err)
	}
	key, err := RandomBytes(KeySize)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := Seal(key, []byte("value"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(key, make([]byte, 1), nil, nil); err == nil {
		t.Fatal("expected invalid nonce error")
	}
	if IsSecret256("") || IsSecret256("not-base64") {
		t.Fatal("unexpected empty or malformed secret validation")
	}
	value := []byte{1, 2, 3}
	Zero(value)
	if !bytes.Equal(value, []byte{0, 0, 0}) {
		t.Fatalf("Zero() = %v", value)
	}
}
