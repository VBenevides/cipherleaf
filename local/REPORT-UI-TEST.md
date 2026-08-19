# Cipherleaf 0.5.0 audit

Date: 2026-08-19
Commit: `cfabbe4 bump version`
Implementation TODO: `local/TODO-UI-TEST.md`

## Implementation status

- Fixed marker rewriting, fenced-code arrow normalization, and rejected background-save handling.
- Added a visible note-level encrypted-file attachment action.
- Added Object Tree editing, type changes, child creation, checkbox updates, deletion, responsive text-first layout, and collapsible metadata.
- Browser smoke testing remains blocked because no supported browser runner is available; see `TODO-UI-TEST.md`.

## Build and test result

The current binary was rebuilt as `bin/cipherleaf`.

| Check | Result |
| --- | --- |
| `rm ./bin/cipherleaf` | Passed |
| `wails3 build` | Blocked by read-only `/home/wdtg/.cache/go-build` |
| `GOCACHE=/tmp/cipherleaf-gocache wails3 build` | Passed |
| `go test ./...` | Passed |
| `npm test` | Passed: 16 tests |
| `npm run build` | Passed |
| `go vet ./...` | Passed |
| `npm run bench` | Passed; 10,000-line editor parse took about 44–145 ms/op |
| `go test -race ./internal/...` | Blocked: `runtime/race: package testmain cannot find package` |

Wails emitted existing GTK X11 deprecation warnings. The binary could not open the
provided desktop display. `xvfb-run` also failed because the X11 socket directory
could not bind. I could not perform visual screenshots or manual clicks in this
environment.

## Current features

- Create, open, unlock, clone, lock, and switch encrypted vaults.
- Create and organize folders and notes.
- Open multiple note tabs.
- Live Preview, Object Tree, and split Markdown views.
- Markdown toolbar, outline sections, lists, checklists, code fences, links, and snippets.
- Drag objects, notes, and folders.
- Encrypted image and file attachments.
- Backlinks, graph view, global search, replace, quick switcher, and command palette.
- GitHub sync, conflict review, recovery, backups, appearance settings, and time tracking.

## Bugs

### High: toolbar type changes duplicate or retain old markers — fixed

Evidence: `frontend/src/LiveMarkdownEditor.tsx:2042-2068` calls
`replaceExclusiveObjectPrefix` for Heading, Checklist, Bullet, and Numbered buttons.
`frontend/src/objectDocument.ts:108-163` removes only one `>`, `<`, bullet, or
numbered prefix. It does not remove Markdown headings or an existing checkbox token.

Focused probe results:

```text
FAIL "# Heading" + "* " => "* # Heading"; expected "* Heading"
FAIL "* [ ] Task" + "* [ ] " => "* [ ] [ ] Task"; expected "* [ ] Task"
FAIL "> * Task" + "* " => "* * Task"; expected "* Task"
```

Impact: changing an element type can save malformed content or show duplicate
markers. Add one shared marker-rewrite path and test every source type to every
toolbar type.

### High: Live Preview changes code content without user input — fixed

Evidence: `frontend/src/LiveMarkdownEditor.tsx:2568`, `2778`, and `2973` apply
`normalizeArrowText` to the complete document. The component calls `onChange` at
`2957-2959` when the normalized value differs.

Example:

~~~text
```js
const next = value -> other;
```
~~~

becomes `const next = value → other;` when Live Preview opens. This also affects
code typed or pasted in a fenced block. Raw Markdown is the current workaround.
Apply arrow conversion only to prose, never to fenced code or link targets.

### Medium: failed background saves create unhandled rejected promises — fixed

Evidence: `persistCurrent` rethrows after setting the visible error at
`frontend/src/App.tsx:1368-1371`. Autosave, blur-save, keyboard save, and command
palette save call it with `void` at `1408`, `1568`, `1380`, and `3491`.
`removeFileAttachment` also awaits it without a local catch at `2836-2842`.

Impact: the user sees an error, but the runtime also reports an unhandled rejection.
Keep the error handling in one save wrapper or catch every fire-and-forget save.

## UI and usability improvements

### Medium: Object Tree is an inspector, not an editor — fixed

The baseline Object Tree supported drag-and-drop only. It now has an inline text
editor, type selector, checkbox updates, delete, and add-child actions. Include is
shown as unavailable because the document model has no include operation.

This makes the Object Tree unsuitable for the requested element workflow. Either
label it as an inspector or add the smallest direct actions: edit text, change
type, add child, and delete.

### Medium: Object Tree uses valuable width for internal metadata — fixed

The baseline grid allocated columns for tags, text, line, depth, parent UUID, and
section UUID. The current grid gives the text column the available width and puts
metadata in a collapsible Details control with a narrow-window one-column layout.

Show line and hierarchy metadata on hover or in a details panel. Give the text
column the available width.

### Low: attachment insertion is hidden in the File menu — fixed

The only visible control is `frontend/src/App.tsx:3952-3956`, “Attach encrypted
file…”. There is no editor toolbar button or note-level attachment affordance.
Users can paste images, but the file workflow is difficult to discover.

### Low: no browser-level UI test exists — blocked

The 16 frontend tests cover pure functions, source patterns, and benchmarks. They
still do not mount `App`, `LiveMarkdownEditor`, or `ObjectTreeView` in a browser
engine. A smoke suite requires a supported browser runner, a Wails/in-memory
backend seam, and a file-picker injection seam. Firefox headless hung before
opening a debugging port in this environment.

## Security and maintainability

The static unsafe-pattern scan found no production `unwrap`, `expect`, `panic`,
`todo`, or unsafe-block matches. The existing encryption and secret confirmation
flows remain in scope for later manual testing.

The checked-out `App.tsx` is 5,956 lines and owns most workspace state and modal
rendering. This is not an immediate user bug, but it makes UI regressions easy to
introduce. Fix the two content-mutation bugs before splitting components.

## Remaining priority order

1. Add the browser smoke harness when a supported browser runner and test seams are available.
2. Define an include operation in the document model before enabling the Object Tree Include control.
3. Repeat the manual UI pass on a real display.
