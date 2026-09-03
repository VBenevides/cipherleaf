import test from "node:test";
import assert from "node:assert/strict";
import { graphModeIsEmpty, relationshipLinks, relationshipTargetID } from "../src/graphRelationships.ts";

const notes = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
] as never;

test("relationship links resolve titles without case sensitivity", () => {
  assert.equal(relationshipTargetID(notes, "alpha"), "a");
});

test("relationship links prefer stable explicit IDs", () => {
  assert.equal(relationshipTargetID(notes, "Old title|note:b"), "b");
});

test("unresolved relationship links remain unresolved", () => {
  assert.equal(relationshipTargetID(notes, "Missing"), null);
});

test("relationship edges include resolved and unresolved wikilinks", () => {
  const links = relationshipLinks([
    { id: "a", title: "Alpha", outgoingLinks: ["Beta", "Missing"] },
    { id: "b", title: "Beta" },
  ]);
  assert.deepEqual(links, [
    { from: "a", to: "b", label: "Beta" },
    { from: "a", to: null, label: "Missing" },
  ]);
});

test("empty folder mode does not make link mode empty", () => {
  assert.equal(graphModeIsEmpty("folders", 2, 0), true);
  assert.equal(graphModeIsEmpty("links", 2, 0), false);
  assert.equal(graphModeIsEmpty("links", 0, 0), true);
  assert.equal(graphModeIsEmpty("folders", 1, 1), false);
  assert.equal(relationshipTargetID(notes, "Alpha|note:missing"), "a");
  assert.deepEqual(relationshipLinks([{ id: "a", title: "Alpha", outgoingLinks: null }]), []);
});
