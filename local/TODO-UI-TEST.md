# Cipherleaf UI test TODO

## Features

- [ ] Add browser-level UI smoke tests
  - Importance Level: Medium
  - Description: Mount the real application and cover vault/note creation, note writing, view switching, toolbar placement, attachment insertion, element inclusion, and narrow-window layout. Verify that the writing area remains usable and controls remain reachable.
  - Test Description: Run the browser suite at normal and narrow viewport sizes. Create a note, enter long text, switch Live Preview/Object Tree/split Markdown, include an element, attach a file, and confirm that the note content and controls remain visible and usable.
  - Test Result: Existing unit/source tests passed; browser UI smoke testing was not run because no usable browser display was available.
  - Commit Hash: Not committed

- [ ] Make Object Tree element actions discoverable
  - Importance Level: Medium
  - Description: Add the smallest direct workflow for editing element text, changing element type, adding a child, including an element, and deleting an element; or clearly label the panel as read-only if editing is intentionally out of scope.
  - Test Description: Select an element in Object Tree, edit its text, change its type, add a child, include it, and delete it. Confirm the Markdown and Live Preview views stay synchronized.
  - Test Result: Manual UI testing was blocked by the unavailable desktop display; implementation not started.
  - Commit Hash: Not committed

- [ ] Make encrypted file attachment insertion visible
  - Importance Level: Low
  - Description: Add a note-level or editor-toolbar affordance for encrypted file attachments instead of exposing the workflow only through the File menu.
  - Test Description: Start attachment insertion from the visible note/editor control, select a file, cancel once, then attach successfully and verify the rendered link and persisted file.
  - Test Result: Manual UI testing was blocked by the unavailable desktop display; implementation not started.
  - Commit Hash: Not committed

- [ ] Give Object Tree text the available width
  - Importance Level: Low
  - Description: Reduce or hide UUID, depth, line, and hierarchy metadata in the default view so element text does not require horizontal scrolling in a narrow editor.
  - Test Description: Open Object Tree at narrow, normal, and wide widths. Confirm text remains readable, the panel does not force unwanted horizontal scrolling, and metadata remains available on hover or in details.
  - Test Result: Manual UI testing was blocked by the unavailable desktop display; implementation not started.
  - Commit Hash: Not committed

## Security Patches

No security patch was identified by this UI-focused audit.

## Bug Fixes

- [ ] Rewrite all existing element markers when changing type
  - Importance Level: High
  - Description: Replace the complete leading marker set, including headings, blockquotes, bullets, numbered items, and checklist tokens. Do not retain or duplicate markers when the toolbar changes an element type.
  - Test Description: Convert every supported source type to every supported toolbar type. Include `# Heading`, `* [ ] Task`, and `> * Task`; assert that exactly one valid marker remains and the text is preserved.
  - Test Result: Existing focused probe reproduced three failures: `# Heading` became `* # Heading`, a checklist duplicated `[ ]`, and `> * Task` became `* * Task`. Regression test not run.
  - Commit Hash: Not committed

- [x] Do not normalize arrows inside fenced code
  - Importance Level: High
  - Description: Limit arrow normalization to prose. Preserve code fences, code content, and link targets exactly as entered.
  - Test Description: `npm test`; `npm run build`; regression tests for fenced code, prose, and link destinations.
  - Test Result: PASS — 16 frontend tests passed; production frontend build passed. Fenced code and link destinations remain unchanged while prose arrows normalize.
  - Commit Hash: `445056dfe59f898fae2e0cbd8737896f6ab94c73`

- [x] Handle rejected background saves
  - Importance Level: Medium
  - Description: Route autosave, blur-save, keyboard save, command-palette save, and attachment-removal saves through a wrapper that reports failures without creating unhandled rejected promises. Preserve the draft and allow retry.
  - Test Description: `npm test`; `npm run build`; source-contract coverage for every background save path and attachment removal.
  - Test Result: PASS — 16 frontend tests passed; production frontend build passed; `git diff --check` passed. Desktop failure injection was not available in this environment.
  - Commit Hash: `74327721278e47604a322f8cf90ab2a4f914b037`
