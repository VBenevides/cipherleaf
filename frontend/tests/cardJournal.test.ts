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

test("creates a new date without rolling older content forward", () => {
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
  assert.ok(currentDate.includes("    [ ] [card](note:card-1)"));
  assert.equal(currentDate.includes("Existing content"), false);
  assert.equal(currentDate.includes("Done"), false);
  assert.ok(result.slice(previousDate).includes("Existing content"));
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

test("does not create today's section when the card body is unchanged", () => {
  const board = boardMarker("board-1", ["card-1"], "Main");
  const result = appendCardJournalToMainEditor(
    board,
    "> Existing",
    "> Existing",
    { ...metadata(), boardID: "board-1" },
    date,
  );

  assert.equal(result, null);
});

test("records an edited checked element today without changing its older entry", () => {
  const previous = "> Teste\n  > [x] Testascca";
  const next = "> Teste\n  > [x] Testasccaaa";
  const main = [
    "> 2026-09-03",
    "  > Untagged",
    "    [ ] [card](note:card-1)",
    "      > Teste",
    "        > [x] Testascca",
  ].join("\n");
  const result = appendCardJournalToMainEditor(main, previous, next, { ...metadata(), tags: [] }, new Date(2026, 8, 4, 12));

  assert.ok(result);
  const older = result.indexOf("> 2026-09-03");
  assert.ok(result.slice(0, older).includes("> 2026-09-04"));
  assert.ok(result.slice(0, older).includes("> [x] Testasccaaa"));
  assert.ok(result.slice(older).includes("> [x] Testascca"));
  assert.doesNotMatch(result.slice(older), /Testasccaaa/);
});

test("creates today's section when an older copy is unchecked", () => {
  const previous = "> Teste\n  > [ ] Testascca";
  const next = "> Teste\n  > [x] Testasccaaa";
  const main = [
    "> 2026-09-03",
    "  > Untagged",
    "    [ ] [card](note:card-1)",
    "      > Teste",
    "        > [ ] Testascca",
  ].join("\n");
  const result = appendCardJournalToMainEditor(main, previous, next, { ...metadata(), tags: [] }, new Date(2026, 8, 4, 12));

  assert.ok(result);
  const older = result.indexOf("> 2026-09-03");
  assert.ok(result.slice(0, older).includes("> 2026-09-04"));
  assert.ok(result.slice(0, older).includes("> [x] Testasccaaa"));
  assert.ok(result.slice(older).includes("> [ ] Testascca"));
});

test("creates today's section with only the changed sibling", () => {
  const previous = "> Teste\n  > [x] Done\n  > [ ] Keep";
  const next = "> Teste\n  > [x] Done\n  > [ ] Keep\n  > [ ] New";
  const main = [
    "> 2026-09-03",
    "  > Untagged",
    "    [ ] [card](note:card-1)",
    "      > Teste",
    "        > [x] Done",
    "        > [ ] Keep",
  ].join("\n");
  const result = appendCardJournalToMainEditor(main, previous, next, { ...metadata(), tags: [] }, new Date(2026, 8, 4, 12));

  assert.ok(result);
  const older = result.indexOf("> 2026-09-03");
  assert.ok(result.slice(0, older).includes("> 2026-09-04"));
  assert.ok(result.slice(0, older).includes("> [ ] New"));
  assert.doesNotMatch(result.slice(0, older), /> \[x\] Done/);
  assert.doesNotMatch(result.slice(0, older), /> \[ \] Keep/);
  assert.ok(result.slice(older).includes("> [x] Done"));
  assert.ok(result.slice(older).includes("> [ ] Keep"));
});

test("removes legacy journal wrappers from the main editor", () => {
  const legacy = `${CARD_JOURNAL_START}\n> 2026-09-02\n  > Work\n${CARD_JOURNAL_END}`;
  const result = appendCardJournalToMainEditor(legacy, "Before", "After", metadata(), date);

  assert.ok(result);
  assert.ok(result.includes("> 2026-09-02\n  > Work"));
  assert.doesNotMatch(result, new RegExp(`${CARD_JOURNAL_START}|${CARD_JOURNAL_END}`));
});

test("journals a newly saved checked point with its children", () => {
  for (const tags of [["Work"], []]) {
    const result = appendCardJournalToMainEditor(
      "",
      "",
      "> [x] Done\n  > Child",
      { ...metadata(), tags },
      date,
    );

    assert.ok(result);
    assert.ok(result.startsWith("> 2026-09-03"));
    assert.ok(result.includes("> [x] Done\n        > Child"));
    if (!tags.length) {
      assert.ok(result.includes("  > Untagged"));
      assert.doesNotMatch(result, /^  >\s*$/m);
    }
  }
});

test("checks an existing current-date point in place", () => {
  for (const tag of ["Work", ""]) {
    const previous = "> Root\n  > [ ] Done\n    > Child\n  > [ ] Keep";
    const next = "> Root\n  > [x] Done\n    > Child\n  > [ ] Keep";
    const main = [
      "> 2026-09-03",
      `  > ${tag || "Untagged"}`,
      "    [ ] [card](note:card-1)",
      "      > Root",
      "        > [ ] Done",
      "          > Child",
      "        > [ ] Keep",
      "    [ ] [card](note:other-card)",
      "      > [ ] Unrelated",
    ].join("\n");
    const result = appendCardJournalToMainEditor(main, previous, next, { ...metadata(), tags: tag ? [tag] : [] }, date);

    assert.ok(result);
    assert.equal((result.match(/> \[x\] Done/g) ?? []).length, 1);
    assert.equal((result.match(/note:card-1/g) ?? []).length, 1);
    assert.ok(result.includes("> [x] Done\n          > Child\n        > [ ] Keep"));
    assert.ok(result.includes("note:other-card)\n      > [ ] Unrelated"));
    assert.equal(
      appendCardJournalToMainEditor(result, previous, next, { ...metadata(), tags: tag ? [tag] : [] }, date),
      null,
    );
  }
});

test("keeps only the latest version of a repeated same-day change", () => {
  const previous = "> Test\n  > Testa\n> Keep";
  const firstBody = "> Test\n  > Testas\n> Keep";
  const latestBody = "> Test\n  > Testasc\n> Keep";
  const main = [
    "> 2026-09-03",
    "  > Untagged",
    "    [ ] [card](note:other-card)",
    "      > Other",
  ].join("\n");
  const first = appendCardJournalToMainEditor(main, previous, firstBody, { ...metadata(), tags: [] }, date);

  assert.ok(first);
  const result = appendCardJournalToMainEditor(first, firstBody, latestBody, { ...metadata(), tags: [] }, date);

  assert.ok(result);
  assert.equal((result.match(/note:card-1/g) ?? []).length, 1);
  assert.equal((result.match(/note:other-card/g) ?? []).length, 1);
  assert.ok(result.includes("        > Testasc"));
  assert.doesNotMatch(result, /^      > Keep$/m);
  assert.doesNotMatch(result, /^        > Testas$/m);
});

test("accumulates separate same-day changes without unchanged siblings", () => {
  const original = "> Root\n  > First\n  > Second\n  > Keep";
  const firstBody = "> Root\n  > First changed\n  > Second\n  > Keep";
  const latestBody = "> Root\n  > First changed\n  > Second changed\n  > Keep";
  const first = appendCardJournalToMainEditor("", original, firstBody, { ...metadata(), tags: [] }, date);

  assert.ok(first);
  const result = appendCardJournalToMainEditor(first, firstBody, latestBody, { ...metadata(), tags: [] }, date);

  assert.ok(result);
  assert.equal((result.match(/note:card-1/g) ?? []).length, 1);
  assert.ok(result.includes("> First changed"));
  assert.ok(result.includes("> Second changed"));
  assert.doesNotMatch(result, /^        > Keep$/m);
});

test("appends a checked point when its unchecked copy exists only on an older date", () => {
  const previous = "> Root\n  > [ ] Done\n    > Child\n  > [ ] Keep";
  const next = "> Root\n  > [x] Done\n    > Child\n  > [ ] Keep";
  const main = [
    "> 2026-09-03",
    "  > Work",
    "    [ ] [card](note:other-card)",
    "      > [ ] Unrelated",
    "> 2026-09-02",
    "  > Work",
    "    [ ] [card](note:card-1)",
    "      > Root",
    "        > [ ] Done",
    "          > Child",
    "        > [ ] Keep",
  ].join("\n");
  const result = appendCardJournalToMainEditor(main, previous, next, { ...metadata(), tags: ["Work"] }, date);

  assert.ok(result);
  const olderDate = result.indexOf("> 2026-09-02");
  assert.ok(olderDate > 0);
  assert.equal((result.slice(0, olderDate).match(/> \[x\] Done/g) ?? []).length, 1);
  assert.equal((result.slice(0, olderDate).match(/> \[ \] Done/g) ?? []).length, 0);
  assert.ok(result.slice(0, olderDate).includes("note:other-card)\n      > [ ] Unrelated"));
  assert.ok(result.slice(olderDate).includes("> [ ] Done"));
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
