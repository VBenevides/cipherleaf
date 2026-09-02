import assert from "node:assert/strict";
import test from "node:test";
import {
  boardMarker,
  cardReference,
  newCardMetadata,
  normalizeCardTags,
  parseBoardMarker,
  parseCardDocument,
  parseCardReference,
  parseTemplateDocument,
  serializeCardDocument,
  serializeTemplateDocument,
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
