import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCardContentJournal,
  appendCardJournalToMainEditor,
  CARD_JOURNAL_END,
  CARD_JOURNAL_START,
} from "../src/cardJournal.ts";
import { boardMarker, newCardMetadata, type CardMetadata } from "../src/cards.ts";

const date = new Date(2026, 8, 3, 12);

function metadata(status: CardMetadata["status"] = "not-started"): CardMetadata {
  return { ...newCardMetadata("card-1"), title: "Launch", status, tags: [" Work ", "Ops"] };
}

test("puts the card journal under each tag", () => {
  const result = appendCardContentJournal("> Root\n>> Existing", "> Root\n>> Updated", metadata(), date);

  assert.ok(result);
  assert.match(result, new RegExp(`> 2026-09-03\\n  > Work\\n    \\[ \\] \\[card\\]\\(note:card-1\\)`));
  assert.match(result, /  > Work[\s\S]*      > Root[\s\S]*  > Ops\n    \[ \] \[card\]\(note:card-1\)/);
  assert.equal((result.match(/    \[ \] \[card\]\(note:card-1\)/g) ?? []).length, 2);
  assert.equal((result.match(/      > Updated/g) ?? []).length, 2);
  assert.doesNotMatch(result, new RegExp(`${CARD_JOURNAL_START}|${CARD_JOURNAL_END}`));
});

test("adds the journal below the board and merges into today's section", () => {
  const board = boardMarker("board-1", ["card-1"], "Main");
  const main = [board, "> 2026-09-03: daily", "  > Existing", "> Next"].join("\n");
  const result = appendCardJournalToMainEditor(
    main,
    "> Root\n>> Existing",
    "> Root\n>> Updated",
    { ...metadata(), boardID: "board-1" },
    date,
  );

  assert.ok(result);
  assert.ok(result.includes("> 2026-09-03: daily\n  > Existing\n  > Work"));
  assert.ok(result.includes("  > Work\n    [ ] [card](note:card-1)"));
  assert.ok(result.indexOf(CARD_JOURNAL_START) < 0);
});

test("appends card content to an existing tag section", () => {
  const board = boardMarker("board-1", ["card-1"], "Main");
  const main = [
    board,
    "> 2026-09-03:",
    "  > Tag 1",
    "    [ ] [card](note:old-card)",
    "      > Existing content",
    "  - Untagged content",
    "  > Tag 2",
    "    [ ] [card](note:other-card)",
  ].join("\n");
  const result = appendCardJournalToMainEditor(
    main,
    "> Root\n>> Existing",
    "> Root\n>> Updated",
    { ...metadata(), tags: ["Tag 1"], boardID: "board-1" },
    date,
  );

  assert.ok(result);
  assert.equal((result.match(/^  > Tag 1$/gm) ?? []).length, 1);
  assert.ok(result.includes("      > Existing content\n    [ ] [card](note:card-1)"));
  assert.ok(result.indexOf("note:card-1") < result.indexOf("  - Untagged content"));
  assert.ok(result.indexOf("  - Untagged content") < result.indexOf("  > Tag 2"));
});

test("inserts new tag sections before untagged points", () => {
  const main = [
    "> 2026-09-03:",
    "  > Tag 1",
    "    [ ] Existing content",
    "  - Untagged content",
  ].join("\n");
  const result = appendCardJournalToMainEditor(
    main,
    "> Root\n>> Existing",
    "> Root\n>> Updated",
    { ...metadata(), tags: ["Tag 1", "Tag 2"] },
    date,
  );

  assert.ok(result);
  assert.ok(result.indexOf("  > Tag 1") < result.indexOf("  > Tag 2"));
  assert.ok(result.indexOf("  > Tag 2") < result.indexOf("  - Untagged content"));
});

test("merges an existing tag without a board marker", () => {
  const main = [
    "> 2026-09-03:",
    "  > Tag 1",
    "    • Existing content",
  ].join("\n");
  const result = appendCardJournalToMainEditor(
    main,
    "> Root\n>> Existing",
    "> Root\n>> Updated",
    { ...metadata(), tags: ["Tag 1"] },
    date,
  );

  assert.ok(result);
  assert.equal((result.match(/^  > Tag 1$/gm) ?? []).length, 1);
  assert.ok(result.includes("    • Existing content\n    [ ] [card](note:card-1)"));
});

test("rolls the first dated section before journaling a new date", () => {
  const main = [
    "> 2026-09-02",
    "  > Tag 1",
    "    [ ] Existing content",
    "  > Tag 2",
    "    [x] Done",
  ].join("\n");
  const result = appendCardJournalToMainEditor(
    main,
    "> Root\n>> Existing",
    "> Root\n>> Updated",
    { ...metadata(), tags: ["Tag 1"] },
    date,
  );

  assert.ok(result);
  const previousDate = result.indexOf("> 2026-09-02");
  assert.ok(result.indexOf("> 2026-09-03") < previousDate);
  const currentDate = result.slice(0, previousDate);
  assert.equal((currentDate.match(/^  > Tag 1$/gm) ?? []).length, 1);
  assert.ok(currentDate.includes("    [ ] Existing content\n    [ ] [card](note:card-1)"));
  assert.equal(currentDate.includes("Done"), false);
});

test("inserts a new journal immediately below the matching board", () => {
  const board = boardMarker("board-1", ["card-1"], "Main");
  const main = ["> Header", board, "> 2026-09-02"].join("\n");
  const result = appendCardJournalToMainEditor(
    main,
    "Before",
    "After",
    { ...metadata(), boardID: "board-1" },
    date,
  );

  assert.ok(result);
  assert.ok(result.includes(board + "\n> 2026-09-03"));
});

test("removes legacy journal wrappers from the main editor", () => {
  const legacy = `${CARD_JOURNAL_START}\n> 2026-09-02\n  > Work\n${CARD_JOURNAL_END}`;
  const result = appendCardJournalToMainEditor(legacy, "Before", "After", metadata(), date);

  assert.ok(result);
  assert.ok(result.includes("> 2026-09-02\n  > Work"));
  assert.doesNotMatch(result, new RegExp(`${CARD_JOURNAL_START}|${CARD_JOURNAL_END}`));
});

test("omits checked checkbox elements and their children", () => {
  const board = boardMarker("board-1", ["card-1"], "Main");
  const result = appendCardJournalToMainEditor(
    board,
    "> Root\n  > [ ] Keep\n  > [ ] Done\n    > Child",
    "> Root\n  > [ ] Keep\n  > [x] Done\n    > Child",
    { ...metadata(), boardID: "board-1" },
    date,
  );

  assert.ok(result);
  assert.ok(result.includes("  > [ ] Keep"));
  assert.equal(result.includes("Done"), false);
  assert.equal(result.includes("Child"), false);
  assert.equal(
    appendCardJournalToMainEditor(
      board,
      "> [ ] Done",
      "> [x] Done\n  > Child",
      { ...metadata(), boardID: "board-1" },
      date,
    ),
    null,
  );
});

test("splits comma-separated tags into separate journal sections", () => {
  const result = appendCardContentJournal("Before", "After", { ...metadata(), tags: ["Tag 1, Tag 2"] }, date);

  assert.ok(result);
  assert.equal((result.match(/  > Tag [12]/g) ?? []).length, 2);
  assert.equal((result.match(/    \[ \] \[card\]\(note:card-1\)/g) ?? []).length, 2);
  assert.doesNotMatch(result, /Tag 1, Tag 2/);
});

test("maps only concluded cards to a checked journal title", () => {
  for (const status of ["not-started", "in-progress", "blocked", "finished"] as const) {
    const result = appendCardContentJournal("Before", "After", metadata(status), date);
    assert.ok(result);
    assert.match(result, new RegExp(`    \\[${status === "finished" ? "x" : " "}\\]`));
  }
});

test("does not journal unchanged or deletion-only bodies", () => {
  assert.equal(appendCardContentJournal("> Root", "> Root", metadata(), date), null);
  assert.equal(
    appendCardContentJournal("> Root\n>> Deleted", "> Root", metadata(), date),
    null,
  );
});

test("journals additions and preserves nested element structure", () => {
  const result = appendCardContentJournal("> Root", "> Root\n>> Added\n>>> Child", metadata(), date);

  assert.ok(result);
  assert.match(result, /      > Root/);
  assert.match(result, /        > Added/);
  assert.match(result, /          > Child/);
});

test("journals reordering and code content changes", () => {
  const reordered = appendCardContentJournal("> A\n> B", "> B\n> A", metadata(), date);
  assert.ok(reordered);
  assert.match(reordered, /      > B/);
  assert.match(reordered, /      > A/);

  const code = appendCardContentJournal("```ts\nconst a = 1\n```", "```js\nconst a = 2\n```", metadata(), date);
  assert.ok(code);
  assert.match(code, /      ```js/);
  assert.match(code, /      const a = 2/);
});

test("journals large cards without quadratic diff allocation", () => {
  const previous = Array.from({ length: 1000 }, (_, index) => `> Item ${index}`).join("\n");
  const result = appendCardContentJournal(previous, `${previous}\n> Added`, metadata(), date);

  assert.ok(result);
  assert.match(result, /      > Added/);
  assert.equal((result.match(/      > Item /g) ?? []).length, 0);
});

test("does not emit journal wrapper markers", () => {
  const first = appendCardContentJournal("Before", "After", metadata(), date);
  assert.ok(first);
  assert.doesNotMatch(first, new RegExp(`${CARD_JOURNAL_START}|${CARD_JOURNAL_END}`));
});
