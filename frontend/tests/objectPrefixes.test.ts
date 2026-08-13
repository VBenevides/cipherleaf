import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeStackedExclusiveObjectPrefix,
  repeatedObjectPrefix,
  replaceExclusiveObjectPrefix,
} from "../src/objectDocument.ts";

test("replaces exclusive object markers without changing indentation", () => {
  assert.equal(replaceExclusiveObjectPrefix("  > Section", "* "), "  * Section");
  assert.equal(replaceExclusiveObjectPrefix(">> Section", "* "), "  * Section");
  assert.equal(replaceExclusiveObjectPrefix("  Text", "> "), "  > Text");
  assert.equal(normalizeStackedExclusiveObjectPrefix("  > * Item"), "  * Item");
  assert.equal(normalizeStackedExclusiveObjectPrefix("> *asdasd"), "* asdasd");
  assert.equal(normalizeStackedExclusiveObjectPrefix("> -asdasd"), "- asdasd");
  assert.equal(normalizeStackedExclusiveObjectPrefix("  > <"), "  <");
  assert.equal(replaceExclusiveObjectPrefix("  < Text", "> "), "  > Text");
  assert.equal(normalizeStackedExclusiveObjectPrefix("-[ ] Task"), "- [ ] Task");
  assert.equal(normalizeStackedExclusiveObjectPrefix("> 2.[ ] Task"), "2. [ ] Task");
  assert.equal(normalizeStackedExclusiveObjectPrefix("< *[ ] Task"), "* [ ] Task");
  assert.equal(normalizeStackedExclusiveObjectPrefix("- *[ ] Task"), "* [ ] Task");
  assert.equal(normalizeStackedExclusiveObjectPrefix("* 1.[ ] Task"), "1. [ ] Task");
  assert.equal(normalizeStackedExclusiveObjectPrefix("1. -[ ] Task"), "- [ ] Task");
});

test("bare checkbox prefixes have a removable caret boundary", () => {
  const editor = readFileSync(new URL("../src/LiveMarkdownEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /object\.barePrefixSize > 0[\s\S]*addHiddenRange\(syntaxFrom, bracketFrom/);
  assert.match(editor, /key: "Backspace",[\s\S]*run: removeBareTaskPrefix/);
});

test("continues numbering from the previous numbered object", () => {
  assert.equal(replaceExclusiveObjectPrefix("> Second", "1. ", "1. First"), "2. Second");
  assert.equal(normalizeStackedExclusiveObjectPrefix("> 1. Second", "4. First"), "5. Second");
  assert.equal(replaceExclusiveObjectPrefix("> Second", "1. ", "* First"), "1. Second");
});

test("continues bare text objects at the same indentation", () => {
  assert.equal(repeatedObjectPrefix("  < Text"), "  < ");
});

test("inserting before an object does not duplicate its marker", () => {
  const editor = readFileSync(new URL("../src/LiveMarkdownEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /const inserted = atObjectStart\s*\? "\\n"/);
});
