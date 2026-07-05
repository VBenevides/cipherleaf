# Cipherleaf

A local-first desktop Markdown editor built with Go, React, and the Wails v3
alpha. Notes, titles, and the note manifest are encrypted before being written
to the vault folder.

## Security model

- A random 256-bit master key is generated for each vault.
- Creation presents a one-time, CSPRNG-generated 256-bit vault secret.
- The master key is wrapped with a key derived from that secret using Argon2id
  (64 MiB, 3 iterations).
- Notes use XChaCha20-Poly1305 with a new random 192-bit nonce for every save.
- Large Markdown notes are gzip-compressed before authenticated encryption.
- Object headers are authenticated as associated data.
- Note filenames are opaque random IDs; titles live inside encrypted payloads.
- Writes use a mode-`0600` temporary file, flush, atomic rename, and a refreshed
  encrypted `.bak` recovery copy.
- The OS temporary directory keeps only the last vault path so the unlock prompt
  can be restored after restart. Vault secrets and note data are never written
  to that session file.
- Plaintext exists in application memory while the vault is unlocked. This MVP
  does not claim protection from malware, keyloggers, process-memory access, or
  OS swap.

The generated vault secret must be saved before creation can continue. Losing it
means losing access to the vault; there is intentionally no reset mechanism.

## Prerequisites

- Go 1.25 or newer
- Node.js and npm
- Wails v3.0.0-alpha2.112:

  ```sh
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.112
  ```

- The platform dependencies listed in the
  [Wails v3 installation guide](https://v3.wails.io/getting-started/installation/)

## Development

```sh
cd frontend
npm ci
cd ..
wails3 dev
```

Build the desktop binary:

```sh
wails3 build
```

Run tests:

```sh
go test ./internal/...
```

### GitHub SSH vault restore

> **Experimental:** GitHub multi-device synchronization is not yet a substitute
> for an independent backup.

From the locked welcome screen, **Clone from GitHub** can reconstruct a local
vault from a repository initialized by Cipherleaf. Select a local parent
folder, choose a local vault name, enter the GitHub SSH repository and private
key, and provide the original vault secret. The SSH key authorizes the
download; the separate vault secret authenticates and decrypts the vault
locally.

The repository must be private and use the encrypted Cipherleaf repository
layout. Restore rejects unknown files, wrong secrets, mismatched hashes, and
unauthenticated ciphertext without leaving a final local vault folder.
Deleted notes and folders sync as small encrypted tombstones keyed by opaque
object ID. Reusing a title or folder name creates a new object and does not
revive the deleted identity.

The MVP supports named vault creation inside a selected parent
folder, vault reopening, manual and 15-minute automatic locking, encrypted note
CRUD, autosave 10 seconds after typing stops, explicit save, editable Markdown
Live Preview and source modes, `---` horizontal dividers,
collapsible `>` sections, encrypted folders and note movement, note context
menus, titlebar vault/file actions, light and Nord-inspired dark themes,
bold/italic formatting, interactive task checkboxes, bullet lists,
title/content search, restart unlock prompts, and `[[wikilinks]]`.

Consecutive `>` lines form one collapsible section. A line without `>` ends
the section; use more `>` characters to indent nested rows:

```markdown
> Project
> [ ] First task
>> [x] Completed subtask
> [ ] Second task

> Another section
> Its second row
```

In Live Preview, use `Tab` and `Shift+Tab` to indent or outdent toggle rows.
