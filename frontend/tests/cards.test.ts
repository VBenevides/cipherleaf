import assert from "node:assert/strict";
import test from "node:test";
import {
  boardMarker,
  boardCardsForColumn,
  cardReference,
  newCardMetadata,
  normalizeCardTags,
  parseBoardMarker,
  parseCardDocument,
  parseCardReference,
  parseTemplateDocument,
  serializeCardDocument,
  serializeTemplateDocument,
  transitionCard,
} from "../src/cards.ts";

test("card metadata round-trips through frontmatter", () => {
  const metadata = { ...newCardMetadata("card-1"), title: "Launch", tags: ["Work", "work", " Bug "] };
  const source = serializeCardDocument(metadata, "# Notes\n\nBody");
  assert.deepEqual(parseCardDocument(source, "card-1", "Launch"), {
    metadata: { ...metadata, tags: ["Work", "Bug"] },
    body: "# Notes\n\nBody",
  });
});

test("card references use stable IDs and do not treat titles as references", () => {
  assert.equal(cardReference("card-1"), "[card](card-1)");
  assert.equal(parseCardReference("[card](card-1)"), "card-1");
  assert.equal(parseCardReference("[card](Project%20Plan)"), "Project%20Plan");
  assert.equal(parseCardReference("[card](Project Plan)"), null);
});

test("template and board markers round-trip", () => {
  const template = serializeTemplateDocument({ id: "tpl-1", name: "Bug", status: "blocked", tags: ["Ops"], body: "Steps" });
  assert.deepEqual(parseTemplateDocument(template, "tpl-1")?.template, {
    id: "tpl-1", name: "Bug", status: "blocked", tags: ["Ops"], body: "Steps",
  });
  assert.deepEqual(parseBoardMarker(boardMarker("board-1", ["card-1", "card-2"])), {
    id: "board-1", cardIDs: ["card-1", "card-2"],
  });
});

test("tags trim and deduplicate without losing first display casing", () => {
  assert.deepEqual(normalizeCardTags([" Work ", "work", "", "Ops"]), ["Work", "Ops"]);
});

test("lifecycle transitions retain first start and record latest block/finish", () => {
  const initial = newCardMetadata("card-1", new Date("2026-01-01T00:00:00Z"));
  const started = transitionCard(initial, "in-progress", new Date("2026-01-02T00:00:00Z"));
  assert.equal(started.startedAt, "2026-01-02T00:00:00.000Z");
  const blocked = transitionCard(started, "blocked", new Date("2026-01-03T00:00:00Z"));
  assert.equal(blocked.startedAt, started.startedAt);
  assert.equal(blocked.blockedOn, "2026-01-03T00:00:00.000Z");
  const finished = transitionCard(blocked, "finished", new Date("2026-01-04T00:00:00Z"));
  assert.equal(finished.finishedAt, "2026-01-04T00:00:00.000Z");
  const reblocked = transitionCard(finished, "blocked", new Date("2026-01-05T00:00:00Z"));
  assert.equal(reblocked.blockedOn, "2026-01-05T00:00:00.000Z");
  assert.equal(transitionCard(reblocked, "blocked"), reblocked);
});

test("lifecycle rejects invalid runtime statuses", () => {
  assert.throws(() => transitionCard(newCardMetadata("card-1"), "unknown" as never), /Unsupported card status/);
});

test("board cards filter by all selected tags and sort newest first", () => {
  const cards = new Map([
    ["a", { ...newCardMetadata("a", new Date("2026-01-01T00:00:00Z")), title: "Alpha", tags: ["Work", "Urgent"] }],
    ["b", { ...newCardMetadata("b", new Date("2026-01-02T00:00:00Z")), title: "Beta", tags: ["Work"] }],
  ]);
  assert.deepEqual(boardCardsForColumn(cards, ["a", "b"], "not-started", "a", ["work", "urgent"]).map((card) => card.id), ["a"]);
});
