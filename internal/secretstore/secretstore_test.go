package secretstore

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func init() {
	keyring.MockInit()
}

func TestStoreRoundTrip(t *testing.T) {
	store := New()
	vaultID := "round-trip-vault"
	if err := store.Save(vaultID, "top-secret", time.Hour); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if got != "top-secret" {
		t.Fatalf("Load() = %q, want top-secret", got)
	}
}

func TestStoreLoadMissing(t *testing.T) {
	store := New()
	_, err := store.Load("never-saved")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Load(missing) = %v, want ErrNotFound", err)
	}
}

func TestStoreLoadExpired(t *testing.T) {
	store := New()
	vaultID := "expired-vault"
	if err := store.Save(vaultID, "stale", 2*time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2100 * time.Millisecond)
	_, err := store.Load(vaultID)
	if !errors.Is(err, ErrExpired) {
		t.Fatalf("Load(expired) = %v, want ErrExpired", err)
	}
	if _, err := store.Load(vaultID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Load after expiry cleanup = %v, want ErrNotFound", err)
	}
}

func TestStoreForget(t *testing.T) {
	store := New()
	vaultID := "forgetful-vault"
	if err := store.Save(vaultID, "value", time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := store.Forget(vaultID); err != nil {
		t.Fatal(err)
	}
	_, err := store.Load(vaultID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Load after Forget = %v, want ErrNotFound", err)
	}
	if err := store.Forget(vaultID); err != nil {
		t.Fatalf("Forget on missing entry should be a no-op, got %v", err)
	}
}

func TestStoreSaveValidations(t *testing.T) {
	store := New()
	if err := store.Save("", "secret", time.Hour); err == nil {
		t.Fatal("expected error for empty vault id")
	}
	if err := store.Save("vault", "", time.Hour); err == nil {
		t.Fatal("expected error for empty secret")
	}
	if err := store.Save("vault", "secret", 0); err == nil {
		t.Fatal("expected error for non-positive ttl")
	}
}

func TestStoreLoadMissingExpiry(t *testing.T) {
	store := New()
	vaultID := "dangling-secret"
	if err := keyring.Set(servicePrefix+vaultID, accountSecret, "value"); err != nil {
		t.Fatal(err)
	}
	_, err := store.Load(vaultID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Load with missing expiry = %v, want ErrNotFound", err)
	}
}

func TestStoreValidationAndExpiryFailures(t *testing.T) {
	store := New()
	if _, err := store.Load(""); err == nil {
		t.Fatal("expected empty vault id error from Load")
	}
	if err := store.Forget(""); err == nil {
		t.Fatal("expected empty vault id error from Forget")
	}

	malformed := servicePrefix + "malformed-expiry"
	if err := keyring.Set(malformed, accountExpiry, "not-a-timestamp"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load("malformed-expiry"); err == nil {
		t.Fatal("expected malformed expiry error")
	}

	missingSecret := servicePrefix + "missing-secret"
	if err := keyring.Set(missingSecret, accountExpiry, fmt.Sprint(time.Now().Add(time.Hour).Unix())); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load("missing-secret"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Load with missing secret = %v, want ErrNotFound", err)
	}

	for _, value := range []string{"dbus unavailable", "Secret Service unavailable", "ordinary error"} {
		wrapped := wrapUnavailable(errors.New(value))
		if value == "ordinary error" && errors.Is(wrapped, ErrUnavailable) {
			t.Fatalf("ordinary error was marked unavailable: %v", wrapped)
		}
	}
	if containsAny("needle", "") != true || containsAny("needle", "missing") {
		t.Fatal("containsAny returned an unexpected result")
	}
	if indexOf("needle", "needle") != 0 || indexOf("needle", "missing") != -1 {
		t.Fatal("indexOf returned an unexpected result")
	}
}
