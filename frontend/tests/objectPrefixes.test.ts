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

test("rewrites every supported object type without retaining old markers", () => {
  const sources = [
    ["plain", "  Task", "  ", "Task"],
    ["heading", "# Heading", "", "Heading"],
    ["blockquote", "> Quote", "", "Quote"],
    ["bullet", "* Bullet", "", "Bullet"],
    ["numbered", "3. Numbered", "", "Numbered"],
    ["checklist", "* [ ] Task", "", "Task"],
    ["nested blockquote and bullet", "> * Task", "", "Task"],
  ] as const;
  const targets = [
    ["heading", "# "],
    ["checklist", "* [ ] "],
    ["bullet", "* "],
    ["numbered", "1. "],
    ["blockquote", "> "],
  ] as const;

  for (const [sourceName, source, indentation, text] of sources) {
    for (const [targetName, target] of targets) {
      const expected = `${indentation}${target}${text}`;
      assert.equal(
        replaceExclusiveObjectPrefix(source, target),
        expected,
        `${sourceName} to ${targetName}`,
      );
    }
  }

  assert.equal(replaceExclusiveObjectPrefix(">> Task", "* "), "  * Task");
  assert.equal(replaceExclusiveObjectPrefix("  # Heading", "* "), "  * Heading");
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
