# Cipherleaf UI test TODO

## Features

- [ ] Add browser-level UI smoke tests
  - Importance Level: Medium
  - Description: Mount the real application and cover vault/note creation, note writing, view switching, toolbar placement, attachment insertion, element inclusion, and narrow-window layout. Verify that the writing area remains usable and controls remain reachable.
  - Test Description: Run the browser suite at normal and narrow viewport sizes. Create a note, enter long text, switch Live Preview/Object Tree/split Markdown, include an element, attach a file, and confirm that the note content and controls remain visible and usable.
  - Test Result: Existing and current frontend tests passed: 16/16; production frontend build passed. Browser execution was not completed because the repository has no Playwright, Puppeteer, jsdom, Selenium, or geckodriver, and Firefox headless hangs before opening a debugging port.
  - Commit Hash: Not committed
  - Blocked: Requires a supported browser runner and a Wails/in-memory backend seam for mounting the real App. Native file-picker flows also need a test injection seam.

- [x] Make Object Tree element actions discoverable
  - Importance Level: Medium
  - Description: Add direct Object Tree actions for editing text, changing type, adding a child, checking items, and deleting an element. Keep unsupported include syntax explicitly disabled until the document model defines its behavior.
  - Test Description: `npm test`; `npm run build`; source-contract coverage for accessible edit/type/add/delete controls, checkbox updates, and the explicit include limitation.
  - Test Result: PASS — 16 frontend tests passed; production frontend build passed. Object Tree now exposes accessible edit, type, add-child, checkbox, delete, and metadata controls. Include is visible but disabled with an explanation because no include operation exists in the document model.
  - Commit Hash: `08e4258`

- [x] Make encrypted file attachment insertion visible
  - Importance Level: Low
  - Description: Add a note-level or editor-toolbar affordance for encrypted file attachments instead of exposing the workflow only through the File menu.
  - Test Description: `npm test`; `npm run build`; source-contract coverage for the visible note-level attachment control and responsive placement.
  - Test Result: PASS — 16 frontend tests passed; production frontend build passed; the control is rendered beside the view tabs and remains disabled while busy. End-to-end file selection was not available without the desktop display.
  - Commit Hash: `fcc19daeb53f862f555d9f8af26873cf5053b009`

- [x] Give Object Tree text the available width
  - Importance Level: Low
  - Description: Reduce or hide UUID, depth, line, and hierarchy metadata in the default view so element text does not require horizontal scrolling in a narrow editor.
  - Test Description: `npm test`; `npm run build`; source-contract coverage for text-first grid columns, collapsible metadata, and the narrow viewport media rule.
  - Test Result: PASS — Object Tree uses the available text column, moves UUID/depth/line metadata into Details, and switches to a one-column layout below 600px. Browser screenshots were not available in this environment.
  - Commit Hash: `08e4258`

## Security Patches

No security patch was identified by this UI-focused audit.

## Bug Fixes

- [x] Rewrite all existing element markers when changing type
  - Importance Level: High
  - Description: Replace the complete leading marker set, including headings, blockquotes, bullets, numbered items, and checklist tokens. Do not retain or duplicate markers when the toolbar changes an element type.
  - Test Description: `node --test --experimental-strip-types tests/objectPrefixes.test.ts`; `npm test`; regression matrix covering all supported source and toolbar marker types.
  - Test Result: PASS — focused marker tests and all 16 frontend tests passed. The matrix covers headings, checklists, bullets, numbered items, blockquotes, nested markers, and indentation preservation.
  - Commit Hash: `2efc704`

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
