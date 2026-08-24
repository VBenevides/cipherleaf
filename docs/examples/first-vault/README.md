# First vault

Create and protect a new Cipherleaf vault, then lock and unlock it. Use a new
disposable vault for this walkthrough. Do not open, edit, or overwrite an
existing vault.

## Screenshots

- [01 — Welcome](screenshots/01-welcome.png) — choose **Create a new vault**.
- [02 — New demo vault](screenshots/02-new-demo-vault.png) — the fresh vault is
  available from the locked welcome window.
- [03 — Unlock vault](screenshots/03-unlock-vault.png) — enter the vault secret.
- [04 — Empty encrypted vault](screenshots/04-empty-encrypted-vault.png) — the
  unlocked workspace is ready for the first note.

The secret value and the native folder-picker contents are intentionally not
captured. Never publish a vault secret in documentation or screenshots.

## Steps

1. Start Cipherleaf and choose **Create a new vault**.
2. Choose a new parent folder. Select the parent directory, not an existing
   Cipherleaf vault.
3. Enter a fake vault name, such as `Cipherleaf Documentation Demo`.
4. Copy the generated **256-bit vault secret** to a password manager or other
   secure location. Confirm that you saved it.
5. Choose **Create encrypted vault**.
6. When finished, choose **Lock vault**.
7. Choose **Open Last Vault**, enter the saved secret, and choose **Unlock
   vault**.

The final state should show an empty encrypted workspace. Continue with the
[note workflow](../note-workflow/README.md) to create the first fake note.
