import assert from "node:assert/strict";
import test from "node:test";
import { markdownObjectTree } from "../src/objectTree.ts";

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
  assert.deepEqual(tree[0].tags, ["section", "text"]);
  assert.equal(tree[0].children[0].tag, "checkbox");
  assert.deepEqual(tree[0].children[0].tags, ["section", "checkbox"]);
  assert.equal(tree[0].children[0].parentId, "line-1");
  assert.equal(tree[0].children[0].parentSectionId, "line-1");
  assert.equal(tree[0].children[0].children[0].tag, "bulletpoint");
  assert.equal(tree[0].children[0].children[1].text, "star");
  assert.equal(tree[1].tag, "text");
});

test("recognizes image objects", () => {
  const tree = markdownObjectTree(`![Diagram](attachment:${"a".repeat(32)}#width=640)`);

  assert.equal(tree[0].tag, "image");
});
