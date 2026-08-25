# Changelog

All notable changes to Cipherleaf are documented here.

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
