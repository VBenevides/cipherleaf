# Cipherleaf user guide

Cipherleaf is a local-first, encrypted Markdown workspace. It keeps your
vault on your device and gives you one place to write, organize, connect,
search, synchronize, and review your work.

## Create and protect a vault

1. Choose **Create a new vault**.
2. Choose the parent folder where Cipherleaf should create the local vault
   folder.
3. Enter a vault name.
4. Copy the **256-bit vault secret** to a password manager or another secure
   location.
5. Confirm that you saved the secret, then choose **Create encrypted vault**.

The vault secret is shown once. Anyone with it can decrypt a copy of the
vault. There is no reset or recovery service for a lost secret.

Use **Lock vault** when you finish working. Cipherleaf also supports automatic
locking after inactivity. When locked, note content is removed from the
decrypted working state and the vault must be unlocked again with its secret.

## Security model

- Each vault has a random 256-bit master key.
- The vault secret is generated with a cryptographically secure random number
  generator.
- Argon2id derives the wrapping key from the secret using 64 MiB of memory and
  three iterations.
- XChaCha20-Poly1305 encrypts notes and metadata with a fresh random nonce for
  every write.
- Note filenames are opaque random IDs. Titles are stored in the encrypted
  manifest.
- Writes use restricted temporary files, flushing, atomic replacement, and an
  encrypted recovery copy.
- Optional secret remembering uses the native credential store on macOS,
  Windows, or Linux.

Plaintext exists in application memory while a vault is unlocked. Cipherleaf
does not protect against malware, keyloggers, process-memory access, a
compromised operating system, or OS swap.

## Write and organize notes

- Use the **+** control beside **Notes** or press `Ctrl+N` to create a note.
- Use the **+** control beside **Folders** to create nested folders.
- Write in **Live Preview**, inspect the **Object Tree**, or switch to source
  **Markdown** editing.
- Press `Ctrl+S` to save explicitly. Autosave runs 60 seconds after editing
  stops.
- Card notes include a **Write changes to editor** option. Save the card to
  persist its value; choose **Settings → Card editor** to set the default for
  new cards. Changing the default does not change existing cards.
- Use the folder list to organize notes and drag notes or folders to reorder
  them.
- Use `Ctrl+]` and `Ctrl+[` to expand or collapse the current outline section.
- Type `/arrow_left`, `/arrow_right`, `/arrow_up`, or `/arrow_down` and press
  Enter to insert an arrow. Typing `->` or `<-` also inserts an arrow; press
  Backspace immediately after the replacement to restore the typed characters.
- Select text and use the *Italic* toolbar button to wrap it in `*...*`, including
  phrases. `__...__` remains bold, while `_word_` supports single-word italics.

Markdown supports GFM tables, task lists, fenced code, headings, links,
dividers, and collapsible nested sections. Consecutive `>` lines form a
collapsible section; additional `>` characters create nesting.

## Connect and find ideas

Type `[[Note title]]` to create a wikilink. Cipherleaf provides backlinks,
outgoing links, unresolved links, unlinked title mentions, inline tags, and
note-relationship and folder graphs.

- **Graph view** shows relationships between notes and folders.
- `Ctrl/Cmd+K` opens quick title and content search.
- `Ctrl/Cmd+Shift+F` searches across notes.
- `Ctrl/Cmd+Shift+H` replaces text across notes.
- After opening a global-search result, use **Back to previous location** in
  the editor bar to return to the prior note and caret position.

Advanced search can filter by title, content, tag, folder, property, date,
case, or regular expression.

## Use daily notes

Open the calendar to create or open a note for a date. In **Settings → Daily
notes**, configure:

- the title format;
- the destination folder; and
- an optional template note.

Templates support `{{title}}`, `{{date}}`, and `{{time}}` variables. Keep the
format and folder stable if you want daily notes to remain easy to find.

## Attachments and portability

Pasted images and file attachments are encrypted with the vault. Use the note
attachment controls to export or open an attachment when needed.

**Import plaintext Markdown** brings a folder of Markdown files into a vault.
**Export plaintext Markdown** creates portable files for use outside
Cipherleaf. Export is intentionally plaintext; review the security warning and
store the exported folder as carefully as the original notes.

## Recover notes

Open **Vault → Trash and version history** to restore deleted notes or earlier
versions. Cipherleaf keeps encrypted trash and up to 20 retained versions by
default. Permanent deletion cannot be undone.

## Synchronize with GitHub

GitHub synchronization is designed for a private repository created for one
Cipherleaf vault.

1. Open **Vault → Vault Settings**.
2. Enter the repository SSH URL, branch, and local SSH private-key path.
3. Confirm that the repository is private.
4. Test the connection, then choose **Link vault**.
5. Use **Save and sync** or **Vault → Sync vault** for manual synchronization.

GitHub receives encrypted repository data, not plaintext note content or the
vault master key. The SSH key authorizes the download; the vault secret
separately authenticates and decrypts it locally.

To use another device, choose **Clone from GitHub** and provide the private
repository details plus the original vault secret. Restore rejects unknown
files, mismatched vault IDs or hashes, wrong secrets, and unauthenticated
ciphertext without leaving a partial destination vault.

Keep an independent backup. Git history can reveal commit timing, object
count, and ciphertext size even though note contents remain encrypted.

## Track time

Open **Time tracking** below **Graph view**.

- **Week** and **Month** use the operating system's local calendar.
- Persisted timestamps remain UTC.
- Start, finish, correct, or delete entries from the tracking views.
- Organize entries with projects and tags.
- Use the dashboard for preset or custom periods and project/tag filters.
- Archive projects and tags without changing historical entries.

The running duration is calculated in memory; it does not write an encrypted
object every second. Locking or closing the vault clears the decrypted tracking
cache.

## Appearance and settings

Cipherleaf includes **Light (Nord)**, **Dark (Nord)**, and **Archivist** themes.
Settings also control journal lines, editor font size from 10–32 px, installed
system fonts, custom TrueType editor fonts, autosave, automatic sync, and
automatic vault locking.

## Important shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | Create a note |
| `Ctrl+S` | Save the current note |
| `Ctrl+Shift+S` | Save and sync |
| `Ctrl+Shift+R` | Sync the vault |
| `Ctrl/Cmd+K` | Quick title/content search |
| `Ctrl/Cmd+Shift+F` | Search across notes |
| `Ctrl/Cmd+Shift+H` | Replace across notes |
| `Ctrl/Cmd+Shift+T` | Open the time-entry start form |
| `Ctrl/Cmd+Shift+E` | Finish the active timer |
