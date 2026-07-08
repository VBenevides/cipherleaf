import assert from "node:assert/strict";
import test from "node:test";
import { markdownObjectTree, moveObjectInMarkdown } from "../src/objectTree.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("builds typed objects with indentation and parents", () => {
  const tree = markdownObjectTree([
    "> Project",
    "  > [ ] Task",
    "    - detail",
    "    * star",
    "plain text",
  ].join("\n"));

  assert.equal(tree.length, 2);
  assert.equal(tree[0].tag, "section");
  assert.match(tree[0].uuid, uuidPattern);
  assert.deepEqual(tree[0].tags, ["section", "text"]);
  assert.equal(tree[0].children[0].tag, "checkbox");
  assert.deepEqual(tree[0].children[0].tags, ["section", "checkbox"]);
  assert.equal(tree[0].children[0].parentId, tree[0].uuid);
  assert.equal(tree[0].children[0].parentSectionId, tree[0].uuid);
  assert.equal(tree[0].children[0].children[0].tag, "bulletpoint");
  assert.equal(tree[0].children[0].children[1].text, "star");
  assert.equal(tree[1].tag, "text");
});

test("recognizes image objects", () => {
  const tree = markdownObjectTree(`![Diagram](attachment:${"a".repeat(32)}#width=640)`);

  assert.equal(tree[0].tag, "image");
});

test("merges indented continuation lines into object text", () => {
  const tree = markdownObjectTree([
    "> Quote",
    "  continued quote",
    "  ",
    "  continued after blank",
    "- Bullet",
    "  continued bullet",
    "[ ] Task",
    "    continued task",
  ].join("\n"));

  assert.equal(tree.length, 3);
  assert.equal(tree[0].text, "Quote\ncontinued quote\n\ncontinued after blank");
  assert.equal(tree[1].text, "Bullet\ncontinued bullet");
  assert.equal(tree[2].text, "Task\ncontinued task");
});

test("assigns sibling sections to the nested section parent", () => {
  const tree = markdownObjectTree([
    "> Parent",
    ">> Nested",
    "   multiline",
    "",
    "   text",
    ">>> Sibling one",
    ">>> Sibling two",
    ">>> Sibling three",
  ].join("\n"));

  const nested = tree[0].children[0];
  assert.equal(nested.text, "Nested\nmultiline\n\ntext");
  assert.equal(nested.children.length, 3);
  assert.deepEqual(nested.children.map((child) => child.parentId), [
    nested.uuid,
    nested.uuid,
    nested.uuid,
  ]);
});

test("moves objects after multiline object text", () => {
  const markdown = [
    "> Target",
    "  first",
    "  ",
    "  second",
    "> Moving",
  ].join("\n");

  assert.equal(moveObjectInMarkdown(markdown, 5, 1, "after"), [
    "> Target",
    "  first",
    "  ",
    "  second",
    "> Moving",
  ].join("\n"));

  assert.equal(moveObjectInMarkdown(markdown, 1, 5, "after"), [
    "> Moving",
    "> Target",
    "  first",
    "  ",
    "  second",
  ].join("\n"));
});
