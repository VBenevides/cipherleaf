# Search and links

Connect fake notes with wikilinks and tags, then find related content with
Cipherleaf search. Use the disposable documentation vault from the
[vault-creation flow](../vault-creation/README.md). Never open or edit an
existing vault for a documentation capture.

## Screenshots

### 1. Add a wikilink and tag

<img src="screenshots/01-markdown-links.png" alt="Markdown links" width="640">

The raw note contains a wikilink and tag.

### 2. Open the link in Live Preview

<img src="screenshots/02-live-links-tags.png" alt="Live links and tags" width="640">

The link is clickable and the tag is visible in the workspace.

### 3. Search by tag

<img src="screenshots/03-tag-search.png" alt="Tag search" width="640">

Search `tag:research`.

### 4. Search note text

<img src="screenshots/04-text-search.png" alt="Text search" width="640">

Search `research` and review the matching note snippet.

### 5. Review the link target

<img src="screenshots/05-link-target.png" alt="Link target" width="640">

The linked note opens with a backlink to `Project Atlas`.

## Steps

1. Open `Project Atlas` in the `Research Notes` folder and choose **Markdown**.
2. Add this fake content below the existing text:

   ```markdown
   Read [[Field Notes]] for the next experiment. #research
   ```

3. Save the note. Switch to **Live Preview** and select the `Field Notes`
   wikilink.
4. If the target note does not exist, create a note named `Field Notes` with
   `Ctrl+N` or the notes **+** button. Select the link again to open it.
5. Confirm the target note shows a **Backlinks** panel containing `Project
   Atlas`.
6. Open **Find in all notes** with `Ctrl+Shift+F`. Search `tag:research` to
   find tagged notes, then search `research` for a plain-text match.

The expected result is a navigable link between the two fake notes, a visible
backlink, and search results for both the tag and text query.
