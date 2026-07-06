import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentMarkdown,
  isHorizontalRule,
  isTableDivider,
  embeddedClipboardImage,
  outlineSectionEnd,
  parseAttachmentMarkdown,
  tableCells,
} from "../src/markdown.ts";

test("recognizes a three-dash horizontal rule line", () => {
  assert.equal(isHorizontalRule("---"), true);
  assert.equal(isHorizontalRule("  ---  "), true);
  assert.equal(isHorizontalRule("----"), false);
  assert.equal(isHorizontalRule("--- text"), false);
});

test("groups consecutive outline lines until a separator", () => {
  const lines = ["> 2026-07-05", "> first", "> second", "", "> 2026-07-04", "> last"];
  const isOutline = (line: number) => /^(\s*)>/.test(lines[line - 1]);
  assert.equal(outlineSectionEnd(1, lines.length, isOutline), 3);
  assert.equal(outlineSectionEnd(5, lines.length, isOutline), 6);
});

test("extracts clipboard images represented as HTML data URLs", () => {
  assert.equal(
    embeddedClipboardImage('<img src="data:image/png;base64,YWJjZA==">'),
    "data:image/png;base64,YWJjZA==",
  );
  assert.equal(embeddedClipboardImage("<p>text only</p>"), null);
});

test("parses GFM table rows and dividers", () => {
  assert.deepEqual(tableCells("| Name | Value |"), ["Name", "Value"]);
  assert.equal(isTableDivider("| --- | :---: |"), true);
  assert.equal(isTableDivider("| one | two |"), false);
});

test("accepts only bounded Cipherleaf attachment references", () => {
  const id = "a".repeat(32);
  assert.deepEqual(
    parseAttachmentMarkdown(`![Diagram](attachment:${id}#width=900)`),
    { alt: "Diagram", id, width: 900 },
  );
  assert.deepEqual(
    parseAttachmentMarkdown(`    ![Nested](attachment:${id}#width=480)`),
    { alt: "Nested", id, width: 480 },
  );
  assert.equal(parseAttachmentMarkdown("![remote](https://example.com/image.webp)"), null);
  assert.equal(parseAttachmentMarkdown("![bad](attachment:../secret)"), null);
});

test("writes pasted images as Markdown image references", () => {
  const id = "b".repeat(32);
  assert.equal(
    attachmentMarkdown(id),
    `![Pasted image](attachment:${id}#width=640)`,
  );
});
