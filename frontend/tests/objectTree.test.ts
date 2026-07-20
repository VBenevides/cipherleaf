import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalObjectDocumentFromMarkdown,
  continuationPrefix,
  markdownFromCanonicalObjectDocument,
  markdownObjectTree,
  moveObject,
  moveObjectInMarkdown,
  objectDepthByLine,
  portableMarkdown,
  parseCanonicalObjectDocument,
  parseObjectDocument,
  prepareNoteContent,
  remapObjectKeysByLine,
  removeAttachmentReferences,
} from "../src/objectDocument.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("matches shared object-document conformance fixtures", () => {
  const fixtures = JSON.parse(readFileSync(
    new URL("../../testdata/object_document_conformance.json", import.meta.url),
    "utf8",
  )) as Array<{ name: string; markdown: string; objects: Array<Record<string, unknown>> }>;

  for (const fixture of fixtures) {
    const document = canonicalObjectDocumentFromMarkdown(fixture.markdown);
    assert.equal(document.objects.length, fixture.objects.length, fixture.name);
    fixture.objects.forEach((expected, index) => {
      for (const [field, value] of Object.entries(expected)) {
        assert.deepEqual(document.objects[index][field as keyof typeof document.objects[number]], value, `${fixture.name}: object ${index} ${field}`);
      }
    });
    assert.equal(markdownFromCanonicalObjectDocument(document), fixture.markdown, fixture.name);
  }
});

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

test("represents and removes image and file attachment objects", () => {
  const imageID = "a".repeat(32);
  const fileID = "b".repeat(32);
  const markdown = [
    `![Diagram](attachment:${imageID}#width=640)`,
    "keep",
    `[report.pdf](attachment:${fileID})`,
  ].join("\n");
  const document = parseObjectDocument(markdown);

  assert.deepEqual(
    document.objects.map(({ attachmentId, attachmentKind }) => ({ attachmentId, attachmentKind })),
    [
      { attachmentId: imageID, attachmentKind: "image" },
      { attachmentId: undefined, attachmentKind: undefined },
      { attachmentId: fileID, attachmentKind: "file" },
    ],
  );
  assert.equal(removeAttachmentReferences(markdown, fileID), [
    `![Diagram](attachment:${imageID}#width=640)`,
    "keep",
  ].join("\n"));
});

test("keeps fenced code as one typed object", () => {
  const tree = markdownObjectTree([
    "```typescript",
    "const value = {",
    "    nested: true,",
    "};",
    "",
    "```",
    "after",
  ].join("\n"));

  assert.equal(tree.length, 2);
  assert.equal(tree[0].tag, "code");
  assert.deepEqual(tree[0].tags, ["code"]);
  assert.equal(tree[0].language, "typescript");
  assert.equal(tree[0].text, "const value = {\n    nested: true,\n};\n");
  assert.equal(tree[0].lineEnd, 6);
  assert.equal(tree[1].text, "after");
});

test("moves a complete code block without changing its contents", () => {
  const markdown = [
    "> Parent",
    "```js",
    "    console.log('kept');",
    "```",
  ].join("\n");

  assert.equal(moveObjectInMarkdown(markdown, 2, 1, "child"), [
    "> Parent",
    "  ```js",
    "    console.log('kept');",
    "  ```",
  ].join("\n"));
});

test("preserves nested code indentation when moving its parent", () => {
  const markdown = [
    "> Target",
    "> Moving",
    "  ```python",
    "    print('kept')",
    "  ```",
  ].join("\n");

  assert.equal(moveObjectInMarkdown(markdown, 2, 1, "child"), [
    "> Target",
    "  > Moving",
    "    ```python",
    "    print('kept')",
    "    ```",
  ].join("\n"));
});

test("round trips code language and content through canonical objects", () => {
  const markdown = ["  ```rust", "fn main() {}", "  ```"].join("\n");
  const canonical = canonicalObjectDocumentFromMarkdown(markdown);

  assert.equal(canonical.objects[0].tag, "code");
  assert.equal(canonical.objects[0].language, "rust");
  assert.equal(canonical.objects[0].closed, true);
  assert.equal(markdownFromCanonicalObjectDocument(canonical), markdown);
});

test("round trips fenced code without a language through canonical objects", () => {
  const markdown = ["  ```", "plain code", "  ```"].join("\n");
  const canonical = canonicalObjectDocumentFromMarkdown(markdown);

  assert.equal(canonical.objects[0].tag, "code");
  assert.equal(canonical.objects[0].language, undefined);
  assert.equal(markdownFromCanonicalObjectDocument(canonical), markdown);
});

test("does not add a closing fence while an indented code block is being typed", () => {
  const markdown = [
    "> arsars",
    "  ```python",
    "def main():",
  ].join("\n");
  const canonical = canonicalObjectDocumentFromMarkdown(markdown);

  assert.equal(canonical.objects[1].tag, "code");
  assert.equal(canonical.objects[1].closed, false);
  assert.equal(markdownFromCanonicalObjectDocument(canonical), markdown);
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

test("keeps marked bare text as an independent object", () => {
  const markdown = [
    "- Parent",
    "  continuation",
    "  < Bare child",
  ].join("\n");
  const tree = markdownObjectTree(markdown);

  assert.equal(tree[0].text, "Parent\ncontinuation");
  assert.equal(tree[0].children[0].tag, "text");
  assert.equal(tree[0].children[0].text, "Bare child");
  assert.equal(markdownFromCanonicalObjectDocument(canonicalObjectDocumentFromMarkdown(markdown)), markdown);
});

test("exports Cipherleaf objects as portable markdown", () => {
  assert.equal(portableMarkdown([
    "> Section",
    "  < Bare text",
    "  * Item",
    "    - Nested item",
    "  > Child section",
  ].join("\n")), [
    "# Section",
    "  Bare text",
    "  - Item",
    "    - Nested item",
    "  > Child section",
  ].join("\n"));
});

test("preserves bare text depth in portable markdown", () => {
  assert.equal(portableMarkdown([
    "> Section",
    "  < First level",
    "    < Second level",
    "      < Third level",
    "  < First level again",
  ].join("\n")), [
    "# Section",
    "  First level",
    "    Second level",
    "      Third level",
    "  First level again",
  ].join("\n"));
});

test("does not indent fenced code contents", () => {
  assert.equal(portableMarkdown("  ```ts\nconst answer = 42;\n  ```"), "  ```ts\nconst answer = 42;\n  ```");
  const style = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(style, /\.cm-line\.cm-live-object-line:not\(\.cm-live-code-block\)/);
  assert.doesNotMatch(style, /\.cm-live-code-content span/);
});

test("keeps every section after the first as an indented quote", () => {
  assert.equal(portableMarkdown([
    "> Project",
    "  > [ ] Pending",
    "  > [x] Complete",
    "> Another root",
  ].join("\n")), [
    "# Project",
    "  > [ ] Pending",
    "  > [x] Complete",
    "> Another root",
  ].join("\n"));
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

test("preserves collapsed sections shifted by an inserted nested item", () => {
  const previous = parseObjectDocument(["> Sec 1", "  > Item 1", "> Sec 2", "> Sec 3"].join("\n"));
  const next = parseObjectDocument(["> Sec 1", "  > Item 1", "  > Item 2", "> Sec 2", "> Sec 3"].join("\n"));
  const collapsed = new Set(previous.roots.map((section) => `object:${section.id}`));
  const remapped = remapObjectKeysByLine(collapsed, previous, next, (line) => line >= 3 ? line + 1 : line);

  assert.deepEqual(remapped, new Set(next.roots.map((section) => `object:${section.id}`)));
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

test("moves an object after a section containing fenced code", () => {
  const markdown = [
    "> Section",
    "  ```python",
    "print('inside')",
    "  ```",
    "> Moving",
  ].join("\n");

  assert.equal(moveObjectInMarkdown(markdown, 5, 1, "after"), markdown);
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

test("uses canonical defaults when a source prefix is omitted", () => {
  const canonical = {
    format: "cipherleaf.object-document" as const,
    version: 1 as const,
    objects: [{
      id: "section",
      tag: "section" as const,
      tags: ["section", "text"] as const,
      text: "Stored heading",
      indent: 0,
      contentIndent: 2,
      parentId: null,
      parentSectionId: null,
      childrenIds: [],
      sourcePrefix: "",
    }],
  };

  assert.equal(markdownFromCanonicalObjectDocument(canonical), "> Stored heading");
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

test("keeps trailing list whitespace out of the hidden prefix", () => {
  const document = parseObjectDocument(["- what ", "1. what "].join("\n"));

  assert.equal(document.objects[0].textFrom, 2);
  assert.equal(document.objects[1].textFrom, 11);
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
