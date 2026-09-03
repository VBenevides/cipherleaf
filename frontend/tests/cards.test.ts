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
  replaceBoardMarker,
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
    id: "board-1", title: "Kanban Board", cardIDs: ["card-1", "card-2"],
  });
  assert.equal(parseBoardMarker(boardMarker("board-1", [], "Roadmap"))?.title, "Roadmap");
  assert.deepEqual(parseBoardMarker("<!-- cipherleaf-board:board-1:card-1,card-2 -->"), {
    id: "board-1", title: "Kanban Board", cardIDs: ["card-1", "card-2"],
  });
  assert.deepEqual(parseBoardMarker("<!-- cipherleaf-board:board-1: -->"), {
    id: "board-1", title: "Kanban Board", cardIDs: [],
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
  assert.deepEqual(boardCardsForColumn(cards, ["a", "b", "missing"], "in-progress"), []);
  assert.deepEqual(boardCardsForColumn(cards, ["a", "b"], "not-started", "", ["missing"]), []);
});

test("board ordering uses latest column entry outside backlog", () => {
  const older = { ...newCardMetadata("a"), status: "in-progress" as const, columnEnteredAt: "2026-01-01T00:00:00Z" };
  const newer = { ...newCardMetadata("b"), status: "in-progress" as const, columnEnteredAt: "2026-01-02T00:00:00Z" };
  const cards = new Map([[older.id, older], [newer.id, newer]]);
  assert.deepEqual(boardCardsForColumn(cards, [older.id, newer.id], "in-progress").map((card) => card.id), ["b", "a"]);
  assert.deepEqual(boardCardsForColumn(cards, ["missing"], "in-progress"), []);
});

test("parses legacy, invalid, and optional card metadata", () => {
  const metadata = {
    ...newCardMetadata("card-1", new Date("2026-01-01T00:00:00Z")),
    title: "Optional",
    startedAt: "2026-01-02",
    blockedOn: "2026-01-03",
    finishedAt: "2026-01-04",
    boardID: "board",
    columnEnteredAt: "2026-01-05",
  };
  const optional = serializeCardDocument(metadata, "Body");
  assert.equal(parseCardDocument("plain", "card-1", "Card"), null);
  assert.equal(parseCardDocument("---\ncipherleaf-card: false\n---", "card-1", "Card"), null);
  assert.equal(parseCardDocument("---\ncipherleaf-card: true\ncipherleaf-card-status: invalid\ncipherleaf-card-created-at: now\n---", "card-1", "Card"), null);
  assert.deepEqual(parseCardDocument(optional, "card-1", " ")?.metadata, {
    id: "card-1", title: "Untitled", status: "not-started", tags: [], createdAt: metadata.createdAt,
    startedAt: "2026-01-02", blockedOn: "2026-01-03", finishedAt: "2026-01-04", boardID: "board", columnEnteredAt: "2026-01-05",
  });
  assert.deepEqual(parseCardDocument(`---\ncipherleaf-card: true\ncipherleaf-card-status: blocked\ncipherleaf-card-tags: [Work, Bug]\ncipherleaf-card-created-at: now\n---\nBody`, "card-1", "Card")?.metadata.tags, ["Work", "Bug"]);
  assert.equal(parseTemplateDocument("plain", "template"), null);
  assert.equal(parseTemplateDocument("---\ncipherleaf-card-template: true\ncipherleaf-card-template-name: \"\"\ncipherleaf-card-template-status: blocked\n---", "template"), null);
  assert.equal(parseTemplateDocument("---\ncipherleaf-card-template: true\ncipherleaf-card-template-name: Name\ncipherleaf-card-template-status: invalid\n---", "template"), null);
  assert.equal(parseCardDocument(`---\ncipherleaf-card: true\ncipherleaf-card-status: blocked\ncipherleaf-card-tags: not-json\ncipherleaf-card-created-at: now\n---`, "card-1", "Card")?.metadata.tags.length, 1);
});

test("rejects malformed board markers and replaces escaped IDs", () => {
  assert.equal(parseBoardMarker("plain"), null);
  assert.equal(parseBoardMarker("<!-- other:board -->"), null);
  assert.equal(parseBoardMarker("<!-- cipherleaf-board::cards -->"), null);
  assert.equal(parseBoardMarker("<!-- cipherleaf-board:board > cards -->"), null);
  assert.equal(parseBoardMarker("<!-- cipherleaf-board:board:%E0%A4%A: -->")?.title, "%E0%A4%A");
  const source = boardMarker("board.*", ["one"], "Old");
  assert.equal(replaceBoardMarker(source, "missing", () => ({ id: "x", title: "x", cardIDs: [] })), source);
  assert.equal(replaceBoardMarker(source, "board.*", () => ({ id: "board.*", title: "New", cardIDs: ["two"] })), boardMarker("board.*", ["two"], "New"));
});
