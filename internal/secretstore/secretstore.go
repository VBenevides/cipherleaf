// Package secretstore persists vault secrets in the operating system's secure
// credential store (macOS Keychain, Windows Credential Manager, or the
// freedesktop Secret Service via libsecret on Linux). Entries are scoped to a
// single vault and carry an expiry timestamp so callers can enforce a TTL.
package secretstore

import (
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	servicePrefix = "cipherleaf.vault."
	accountSecret = "secret"
	accountExpiry = "expires"
)

// ErrUnavailable is returned when the OS credential store cannot be reached
// (no Keychain, no Secret Service running, etc.). Callers should treat this
// as "remember me" being unsupported and continue without it.
var ErrUnavailable = errors.New("operating system credential store is unavailable")

// ErrNotFound is returned when no remembered secret exists for the vault.
var ErrNotFound = errors.New("no remembered secret")

// ErrExpired is returned when the remembered secret has passed its TTL.
// The entry is deleted before returning so subsequent lookups behave as if
// it never existed.
var ErrExpired = errors.New("remembered secret has expired")

// Store persists vault secrets in the OS keychain.
type Store struct {
	mu sync.Mutex
}

// New returns a Store backed by the host operating system's keychain.
func New() *Store {
	return &Store{}
}

// Save writes the secret for vaultID with the given time-to-live. The secret
// and its expiry are stored as two keychain entries so they can be revoked
// independently of one another.
func (s *Store) Save(vaultID, secret string, ttl time.Duration) error {
	if vaultID == "" {
		return errors.New("vault id is required")
	}
	if secret == "" {
		return errors.New("secret is required")
	}
	if ttl <= 0 {
		return errors.New("remember duration must be positive")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	service := servicePrefix + vaultID
	expiresAt := time.Now().Add(ttl).Unix()
	if err := keyring.Set(service, accountSecret, secret); err != nil {
		return fmt.Errorf("write vault secret to keychain: %w", wrapUnavailable(err))
	}
	if err := keyring.Set(service, accountExpiry, strconv.FormatInt(expiresAt, 10)); err != nil {
		// Best-effort cleanup so a partial save does not leave a secret
		// without an expiry.
		_ = keyring.Delete(service, accountSecret)
		return fmt.Errorf("write vault secret expiry to keychain: %w", wrapUnavailable(err))
	}
	return nil
}

// Load returns the remembered secret for vaultID. It returns ErrNotFound when
// no entry exists, ErrExpired when the TTL has elapsed (the entry is removed
// before returning), and ErrUnavailable when the host keychain is not
// reachable.
func (s *Store) Load(vaultID string) (string, error) {
	if vaultID == "" {
		return "", errors.New("vault id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	service := servicePrefix + vaultID
	expiresRaw, err := keyring.Get(service, accountExpiry)
	if err != nil {
		if isKeyringNotFound(err) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("read vault secret expiry: %w", wrapUnavailable(err))
	}
	expiresAt, err := strconv.ParseInt(expiresRaw, 10, 64)
	if err != nil {
		_ = keyring.Delete(service, accountSecret)
		_ = keyring.Delete(service, accountExpiry)
		return "", fmt.Errorf("decode vault secret expiry: %w", err)
	}
	if time.Now().Unix() >= expiresAt {
		_ = keyring.Delete(service, accountSecret)
		_ = keyring.Delete(service, accountExpiry)
		return "", ErrExpired
	}
	secret, err := keyring.Get(service, accountSecret)
	if err != nil {
		if isKeyringNotFound(err) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("read vault secret: %w", wrapUnavailable(err))
	}
	return secret, nil
}

// Forget removes any remembered secret for vaultID. It is a no-op when no
// entry exists so it is safe to call unconditionally.
func (s *Store) Forget(vaultID string) error {
	if vaultID == "" {
		return errors.New("vault id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	service := servicePrefix + vaultID
	if err := keyring.Delete(service, accountSecret); err != nil && !isKeyringNotFound(err) {
		return fmt.Errorf("delete vault secret: %w", wrapUnavailable(err))
	}
	if err := keyring.Delete(service, accountExpiry); err != nil && !isKeyringNotFound(err) {
		return fmt.Errorf("delete vault secret expiry: %w", wrapUnavailable(err))
	}
	return nil
}

func isKeyringNotFound(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, keyring.ErrNotFound)
}

func wrapUnavailable(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if msg == "The name was not provided in the keychain" ||
		msg == "The user name is not in the secret service" ||
		msg == "no such service \"org.freedesktop.secrets\"" ||
		msg == "Operation not permitted" ||
		msg == "Access is denied." ||
		containsAny(msg, "dbus", "Secret Service", "keyring", "Keychain") {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return err
}

func containsAny(s string, needles ...string) bool {
	for _, needle := range needles {
		if len(needle) <= len(s) && indexOf(s, needle) >= 0 {
			return true
		}
	}
	return false
}

func indexOf(s, needle string) int {
	if len(needle) == 0 {
		return 0
	}
outer:
	for i := 0; i+len(needle) <= len(s); i++ {
		for j := 0; j < len(needle); j++ {
			if s[i+j] != needle[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}
