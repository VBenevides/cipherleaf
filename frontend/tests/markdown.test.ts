import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentMarkdown,
  isHorizontalRule,
  isTableDivider,
  embeddedClipboardImage,
  normalizeArrowText,
  parseAttachmentMarkdown,
  tableCells,
} from "../src/markdown.ts";

test("stores ASCII arrows as Unicode arrows", () => {
  assert.equal(normalizeArrowText("first -> second -> third"), "first → second → third");
  assert.equal(normalizeArrowText("already → converted"), "already → converted");
});

test("recognizes a three-dash horizontal rule line", () => {
  assert.equal(isHorizontalRule("---"), true);
  assert.equal(isHorizontalRule("  ---  "), true);
  assert.equal(isHorizontalRule("----"), false);
  assert.equal(isHorizontalRule("--- text"), false);
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
    { alt: "Diagram", id, width: 900, align: "left" },
  );
  assert.deepEqual(
    parseAttachmentMarkdown(`    ![Nested](attachment:${id}#width=480)`),
    { alt: "Nested", id, width: 480, align: "left" },
  );
  assert.deepEqual(
    parseAttachmentMarkdown(`![Centered](attachment:${id}#width=480&align=center)`),
    { alt: "Centered", id, width: 480, align: "center" },
  );
  assert.equal(parseAttachmentMarkdown("![remote](https://example.com/image.webp)"), null);
  assert.equal(parseAttachmentMarkdown("![bad](attachment:../secret)"), null);
});

test("writes pasted images as Markdown image references", () => {
  const id = "b".repeat(32);
  assert.equal(
    attachmentMarkdown(id, 640, "Pasted image", "center"),
    `![Pasted image](attachment:${id}#width=640&align=center)`,
  );
  assert.equal(
    attachmentMarkdown(id),
    `![Pasted image](attachment:${id}#width=640)`,
  );
});
