# Cipherleaf

## A private workspace for notes, ideas, and working context

Cipherleaf is a local-first Markdown notebook for people who want the
convenience of a modern knowledge workspace without putting their vault in a
hosted database. Your notes stay encrypted on your device, while the app
still gives you the tools to write, connect, search, organize, and review your
work.

## Why it is useful

- Keep research, meeting notes, plans, and personal writing in one encrypted
  workspace.
- Organize notes in nested folders while keeping Markdown portable.
- Connect ideas with wikilinks, backlinks, tags, unresolved-link views, and
  relationship graphs.
- Find information quickly with note search, vault-wide search and replace,
  and filters for titles, content, tags, folders, properties, and dates.
- Turn recurring work into daily notes with calendar access, templates, and
  date variables.
- Track focused work with encrypted time entries, projects, tags, calendars,
  and dashboard reports.
- Preserve context with encrypted attachments, note history, and trash
  recovery.

## Sync without handing over the vault

Cipherleaf can synchronize an encrypted vault with a private GitHub repository
over SSH. GitHub receives encrypted repository data, not plaintext note
content or the vault master key. A second device can clone and restore the
encrypted repository only when it also has the original vault secret.

Sync includes conflict resolution, retry handling, encrypted tombstones, and
recovery checks for unknown files, mismatched vault IDs, wrong secrets, and
unauthenticated ciphertext.

## Security guarantees and limits

- Each vault has a random 256-bit master key.
- Vault creation displays a one-time, CSPRNG-generated 256-bit vault secret.
- Argon2id derives the wrapping key from that secret using 64 MiB of memory
  and three iterations.
- XChaCha20-Poly1305 encrypts notes and metadata with a fresh random nonce
  for every write.
- Note filenames are opaque random IDs; titles remain inside the encrypted
  manifest.
- Writes use restricted temporary files, flushing, atomic replacement, and an
  encrypted recovery copy.
- Optional secret remembering uses the native credential store on macOS,
  Windows, or Linux.

Plaintext exists in application memory while a vault is unlocked. Cipherleaf
does not protect against malware, keyloggers, process-memory access, a
compromised operating system, or OS swap. Save the generated vault secret
before creating the vault: there is intentionally no reset or recovery path
for a lost secret.

## Start here

- [User guide](USER-GUIDE.md) — concepts, setup, safety, and feature details.
- [Examples](examples/README.md) — task-focused walkthroughs with screenshots.

Cipherleaf is open-source software licensed under the [MIT License](../LICENSE).
