import assert from "node:assert/strict";
import test from "node:test";
import { appendCardContentJournal, CARD_JOURNAL_END, CARD_JOURNAL_START } from "../src/cardJournal.ts";
import { newCardMetadata, type CardMetadata } from "../src/cards.ts";

const date = new Date(2026, 8, 3, 12);

function metadata(status: CardMetadata["status"] = "not-started"): CardMetadata {
  return { ...newCardMetadata("card-1"), title: "Launch", status, tags: [" Work ", "Ops"] };
}

test("appends a dated journal with raw tags, card link, and changed elements", () => {
  const result = appendCardContentJournal("> Root\n>> Existing", "> Root\n>> Updated", metadata(), date);

  assert.ok(result);
  assert.match(result, new RegExp(`${CARD_JOURNAL_START}\\n> 2026-09-03\\n> > Work, Ops\\n> > > \\[ \\] \\[card\\]\\(card-1\\) Launch`));
  assert.match(result, /> > > > > Root/);
  assert.match(result, /> > > >   > Updated/);
  assert.match(result, new RegExp(`${CARD_JOURNAL_END}$`));
});

test("maps only concluded cards to a checked journal title", () => {
  for (const status of ["not-started", "in-progress", "blocked", "finished"] as const) {
    const result = appendCardContentJournal("Before", "After", metadata(status), date);
    assert.ok(result);
    assert.match(result, new RegExp(`> > > \\[${status === "finished" ? "x" : " "}\\]`));
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
  assert.match(result, /> > > > > Root/);
  assert.match(result, /> > > >   > Added/);
  assert.match(result, /> > > >     > Child/);
});

test("journals reordering and code content changes", () => {
  const reordered = appendCardContentJournal("> A\n> B", "> B\n> A", metadata(), date);
  assert.ok(reordered);
  assert.match(reordered, /> > > > > B/);
  assert.match(reordered, /> > > > > A/);

  const code = appendCardContentJournal("```ts\nconst a = 1\n```", "```js\nconst a = 2\n```", metadata(), date);
  assert.ok(code);
  assert.match(code, /> > > > ```js/);
  assert.match(code, /> > > > const a = 2/);
});

test("ignores existing generated journals to prevent recursion", () => {
  const first = appendCardContentJournal("Before", "After", metadata(), date);
  assert.ok(first);
  assert.equal(appendCardContentJournal(first, first, metadata(), date), null);
});
