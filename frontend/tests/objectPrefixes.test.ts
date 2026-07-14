import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeStackedExclusiveObjectPrefix,
  replaceExclusiveObjectPrefix,
} from "../src/objectDocument.ts";

test("replaces exclusive object markers without changing indentation", () => {
  assert.equal(replaceExclusiveObjectPrefix("  > Section", "* "), "  * Section");
  assert.equal(replaceExclusiveObjectPrefix(">> Section", "* "), "  * Section");
  assert.equal(replaceExclusiveObjectPrefix("  Text", "> "), "  > Text");
  assert.equal(normalizeStackedExclusiveObjectPrefix("  > * Item"), "  * Item");
});

test("continues numbering from the previous numbered object", () => {
  assert.equal(replaceExclusiveObjectPrefix("> Second", "1. ", "1. First"), "2. Second");
  assert.equal(normalizeStackedExclusiveObjectPrefix("> 1. Second", "4. First"), "5. Second");
  assert.equal(replaceExclusiveObjectPrefix("> Second", "1. ", "* First"), "1. Second");
});
