package secure

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

const KeySize = chacha20poly1305.KeySize
const SecretSize = 32

var ErrInvalidKey = errors.New("invalid encryption key")

type KDFParams struct {
	Time    uint32
	Memory  uint32
	Threads uint8
}

func RandomBytes(size int) ([]byte, error) {
	if size <= 0 {
		return nil, fmt.Errorf("random byte size must be positive")
	}
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return nil, fmt.Errorf("generate secure random bytes: %w", err)
	}
	return value, nil
}

// RandomSecret256 returns 256 bits of CSPRNG output encoded as unpadded
// Base64URL. The encoded value is safe to paste into password fields and files.
func RandomSecret256() (string, error) {
	value, err := RandomBytes(SecretSize)
	if err != nil {
		return "", err
	}
	defer Zero(value)
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func IsSecret256(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return false
	}
	defer Zero(decoded)
	return len(decoded) == SecretSize &&
		base64.RawURLEncoding.EncodeToString(decoded) == value
}

func DeriveKey(passphrase string, salt []byte, params KDFParams) ([]byte, error) {
	if passphrase == "" {
		return nil, errors.New("passphrase is required")
	}
	if len(salt) < 16 {
		return nil, errors.New("KDF salt must be at least 16 bytes")
	}
	if params.Time == 0 || params.Memory < 8*1024 || params.Threads == 0 {
		return nil, errors.New("invalid Argon2id parameters")
	}
	return argon2.IDKey([]byte(passphrase), salt, params.Time, params.Memory, params.Threads, KeySize), nil
}

func Seal(key, plaintext, associatedData []byte) (nonce []byte, ciphertext []byte, err error) {
	if len(key) != KeySize {
		return nil, nil, ErrInvalidKey
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, nil, fmt.Errorf("create XChaCha20-Poly1305 cipher: %w", err)
	}
	nonce, err = RandomBytes(aead.NonceSize())
	if err != nil {
		return nil, nil, err
	}
	return nonce, aead.Seal(nil, nonce, plaintext, associatedData), nil
}

func Open(key, nonce, ciphertext, associatedData []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, ErrInvalidKey
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("create XChaCha20-Poly1305 cipher: %w", err)
	}
	if len(nonce) != aead.NonceSize() {
		return nil, errors.New("invalid XChaCha20-Poly1305 nonce")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, associatedData)
	if err != nil {
		return nil, errors.New("ciphertext authentication failed")
	}
	return plaintext, nil
}

func Zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

// ZeroString overwrites the backing memory of a string with zeros. It is
// best-effort because Go strings are immutable in practice, but it limits
// the window during which the secret lingers in the heap.
func ZeroString(value string) {
	Zero([]byte(value))
}
