import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalObjectDocumentFromMarkdown,
  continuationPrefix,
  markdownFromCanonicalObjectDocument,
  markdownObjectTree,
  moveObject,
  moveObjectInMarkdown,
  objectDepthByLine,
  parseCanonicalObjectDocument,
  parseObjectDocument,
  prepareNoteContent,
} from "../src/objectTree.ts";

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
  assert.equal(tree[0].children[0].tag, "section");
  assert.deepEqual(tree[0].children[0].tags, ["section", "text"]);
  assert.equal(tree[0].children[0].checked, false);
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

test("keeps unindented text lines as separate objects", () => {
  const tree = markdownObjectTree([
    "first",
    "second",
    "- bullet",
    "- next bullet",
    "  bullet continuation",
  ].join("\n"));

  assert.equal(tree.length, 4);
  assert.equal(tree[0].tag, "text");
  assert.equal(tree[0].text, "first");
  assert.equal(tree[1].tag, "text");
  assert.equal(tree[1].text, "second");
  assert.equal(tree[2].tag, "bulletpoint");
  assert.equal(tree[2].text, "bullet");
  assert.equal(tree[3].tag, "bulletpoint");
  assert.equal(tree[3].text, "next bullet\nbullet continuation");
});

test("assigns sibling sections to the nested section parent", () => {
  const tree = markdownObjectTree([
    "> Parent",
    ">> Nested",
    "   multiline",
    "   ",
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

test("moves objects by id", () => {
  const markdown = [
    "> A",
    "> B",
    "> C",
  ].join("\n");
  const tree = markdownObjectTree(markdown);

  assert.equal(moveObject(markdown, tree[0].id, tree[2].id, "after"), [
    "> B",
    "> C",
    "> A",
  ].join("\n"));
});

test("serializes markdown to canonical object json", () => {
  const canonical = canonicalObjectDocumentFromMarkdown([
    "> Project",
    ">> [x] Done",
    ">> [ ] Next",
  ].join("\n"));

  assert.equal(canonical.format, "cipherleaf.object-document");
  assert.equal(canonical.version, 1);
  assert.equal(canonical.objects.length, 3);
  assert.equal(canonical.objects[0].tag, "section");
  assert.deepEqual(canonical.objects[0].childrenIds, [
    canonical.objects[1].id,
    canonical.objects[2].id,
  ]);
  assert.equal(canonical.objects[1].checked, true);
});

test("renders canonical objects back to editable markdown", () => {
  const markdown = [
    "> Project",
    "  > [ ] Task",
    "    detail",
    "- Loose",
  ].join("\n");
  const canonical = canonicalObjectDocumentFromMarkdown(markdown);

  assert.equal(markdownFromCanonicalObjectDocument(canonical), markdown);
});

test("renders nested section markers as structure and checkbox token as text", () => {
  const canonical = canonicalObjectDocumentFromMarkdown(">> [x] VM: Cobrar acesso");

  assert.equal(canonical.objects[0].tag, "section");
  assert.deepEqual(canonical.objects[0].tags, ["section", "text"]);
  assert.equal(canonical.objects[0].checked, true);
  assert.equal(markdownFromCanonicalObjectDocument(canonical), ">> [x] VM: Cobrar acesso");
  assert.equal(prepareNoteContent(JSON.stringify(canonical)).markdown, ">> [x] VM: Cobrar acesso");
});

test("soft object breaks use object content indentation", () => {
  assert.equal(continuationPrefix(">> [x] VM: cobrar acesso"), "       ");
  assert.equal(continuationPrefix("  > [ ] Task"), "        ");
  assert.equal(continuationPrefix("- Bullet"), "  ");
});

test("prepares old markdown notes for json migration on save", () => {
  const prepared = prepareNoteContent("> Legacy\n>> [ ] Task");

  assert.equal(prepared.markdown, "> Legacy\n>> [ ] Task");
  assert.equal(prepared.migrated, true);
  assert.match(prepared.canonicalText, /"format": "cipherleaf\.object-document"/);
});

test("prepares canonical json notes without migration", () => {
  const canonical = canonicalObjectDocumentFromMarkdown("> Stored");
  const prepared = prepareNoteContent(JSON.stringify(canonical));

  assert.equal(prepared.markdown, "> Stored");
  assert.equal(prepared.migrated, false);
});

test("populates object tree from canonical json", () => {
  const canonical = canonicalObjectDocumentFromMarkdown([
    "> Project",
    "  > Task",
    "    detail",
  ].join("\n"));
  const document = parseCanonicalObjectDocument(JSON.stringify(canonical));
  const depths = objectDepthByLine(document);

  assert.equal(document.roots[0].text, "Project");
  assert.equal(document.roots[0].children[0].text, "Task\ndetail");
  assert.equal(depths.get(document.roots[0].lineNumber), 0);
  assert.equal(depths.get(document.roots[0].children[0].lineNumber), 1);
});

test("allows empty text and bullet objects", () => {
  const tree = markdownObjectTree(["", "-", "*"].join("\n"));

  assert.equal(tree.length, 3);
  assert.equal(tree[0].tag, "text");
  assert.equal(tree[0].text, "");
  assert.equal(tree[1].tag, "bulletpoint");
  assert.equal(tree[1].text, "");
  assert.equal(tree[2].tag, "bulletpoint");
  assert.equal(tree[2].text, "");
});

test("keeps plain blank lines as empty objects", () => {
  const tree = markdownObjectTree(["a", "", "b"].join("\n"));

  assert.equal(tree.length, 3);
  assert.equal(tree[0].text, "a");
  assert.equal(tree[1].tag, "text");
  assert.equal(tree[1].text, "");
  assert.equal(tree[2].text, "b");
});

test("tracks blank object lines by line number", () => {
  const document = parseObjectDocument(["a", "", "b"].join("\n"));

  assert.equal(document.byLine.get(2)?.tag, "text");
  assert.equal(document.byLine.get(2)?.text, "");
  assert.equal(document.byLine.get(2)?.lineNumber, 2);
});
