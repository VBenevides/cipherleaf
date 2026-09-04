# Changelog

All notable changes to Cipherleaf are documented here.

## [1.0.5] - 2026-09-04

### Features

- Display card lifecycle dates as `YYYY-MM-DD` in card panels and embedded boards.
- Replace board tag text search with a normalized tag dropdown filter.

### Bugfixes

- Fixed card journals to record only changed elements, merge same-day updates, and preserve older dated history.
- Fixed checked journal points to update existing current-date entries without duplicates while retaining nested and unrelated content.
- Aligned card-journal checkboxes with their labels.

### Other

- Added deterministic card-operation benchmarks covering writing, serialization, board grouping, and main-editor updates from 1 to 10,000 cards.
- Expanded frontend and card-journal regression coverage for dates, filters, synchronization, and repeated saves.

## [1.0.4] - 2026-09-03

### Features

- Added a configurable default for the **Write changes to editor** option on new cards; existing cards retain their saved choice.
- Added automatic card-content journals to the main editor, grouped by date and tag while preserving nested elements and card links.

### Bugfixes

- Fixed the **Write changes to editor** option resetting when a card is closed and reopened.
- Fixed card references so stable note IDs render as cards instead of ordinary hyperlinks.
- Aligned card task checkboxes with their text.

### Other

- Reduced inline Markdown decoration complexity by separating wikilink, card-reference, and citation handling.
- Documented card editor preference behavior and added regression coverage.
- Improved editor and board performance by reusing preview state, grouped card data, board DOM, and card text measurements.
- Replaced quadratic journal diffing and deferred unnecessary vault manifest snapshots during unchanged saves.
- Updated the security workflow to use npm 12 for dependency audits and expanded frontend regression coverage.

## [1.0.3] - 2026-09-03

### Features

- Added card tags and Backlog, In Progress, and Blocked counts to minimized embedded boards.
- Added minimized board summaries with a fixed minimize/maximize control.

### Bugfixes

- Made board card titles and dates fit their available space and reduced board outer spacing.
- Aligned journal rules with the usable editor area.

### Other

- Expanded frontend coverage for board interactions and layout behavior.

## [1.0.2] - 2026-09-03

### Features

- Added structured cards with encrypted metadata, lifecycle history, normalized tags, references, templates, and an accessible side-panel editor.
- Added embedded boards with card creation, filtering, sorting, drag and keyboard status movement, editable titles, and safe persistence.
- Added logical-object copy and paste, card deletion, unsaved-change feedback, and Ctrl+S save support.

### Bugfixes

- Preserved card and board metadata through Markdown normalization, duplicate and paste actions, and board operations while preventing duplicate citations and orphaned records.
- Hardened configuration paths, platform command handling, UUID generation, AppImage downloads, and parser behavior.
- Removed the unused debug and production pprof support entirely.

### Other

- Updated the Go toolchain to 1.27 and added CI Go and frontend coverage gates at 85% with SonarQube reports.
- Improved accessibility semantics across editors, boards, dialogs, date pickers, and time-tracking controls.
- Expanded Go and frontend regression coverage across card, vault, synchronization, editor, and workflow behavior.

## [1.0.1] - 2026-08-25

### Features

- Added `/arrow_left`, `/arrow_right`, `/arrow_up`, and `/arrow_down` snippets.
- Added one-shot return navigation from global search results to the previous note and caret position.
- Updated the Bold toolbar button to use `__bold__` and the Italic button to use `*italic phrase*`, allowing `__*bold italic*__` combinations.

### Bugfixes

- Added `->` and `<-` prose normalization to right and left arrow characters.
- Added Backspace restoration from automatic arrow substitutions to their typed source.
- Limited underscore italics to standalone words while supporting multi-word asterisk italics.
- Prevented leading `*italic phrases*` from being classified as bullet points.
- Preserved `>` markers for childless sections during save and canonical round trips.
- Canonicalized `[]` checkbox shorthand to `[ ]` without repeated markers.

### Other

- Expanded the user guide with arrow, reversible substitution, and toolbar formatting behavior.
- Added frontend and Go regression/conformance coverage for editor and object-document persistence fixes.
