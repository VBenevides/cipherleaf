import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  attachmentMarkdown,
  isHorizontalRule,
  isTableDivider,
  embeddedClipboardImage,
  insertAttachmentMarkdown,
  markdownCitation,
  markdownCitations,
  normalizeArrowText,
  parseAttachmentMarkdown,
  parseAttachmentReferenceMarkdown,
  tableCells,
} from "../src/markdown.ts";

const editor = readFileSync(new URL("../src/LiveMarkdownEditor.tsx", import.meta.url), "utf8");

test("section disclosures use shared chevrons", () => {
  assert.match(editor, /cm-live-toggle-button[\s\S]*disclosure-chevron/);
  assert.match(editor, /toolbar-toggle disclosure-chevron is-expanded/);
  assert.doesNotMatch(editor, /[▸▾]/);
});

test("renders safe Markdown citations without treating images as links", () => {
  assert.deepEqual(markdownCitations("See [Cipherleaf](https://cipherleaf.test/docs)."), [{
    label: "Cipherleaf",
    url: "https://cipherleaf.test/docs",
    index: 4,
    length: 42,
  }]);
  assert.deepEqual(markdownCitations("[bad](javascript:alert(1)) ![image](https://example.com/a.png)"), []);
  assert.deepEqual(markdownCitations("[card](note:card-1)"), []);
  assert.equal(markdownCitation(" Updated name ", " https://example.com/new "), "[Updated name](https://example.com/new)");
  assert.deepEqual(
    markdownCitations("[HTTP](http://example.com) [relative](./docs/readme.md) [absolute](/tmp/readme.md)"),
    [
      { label: "HTTP", url: "http://example.com", index: 0, length: 26 },
      { label: "relative", url: "./docs/readme.md", index: 27, length: 28 },
      { label: "absolute", url: "/tmp/readme.md", index: 56, length: 26 },
    ],
  );
  assert.equal(markdownCitation("Local", "docs\\readme.md"), "[Local](docs\\readme.md)");
  assert.equal(markdownCitation("Bad]name", "javascript:alert(1)"), null);
  assert.equal(markdownCitation("Bad", "data:text/plain,hello"), null);
});

test("edits a citation in one themed dialog", () => {
  assert.match(editor, /document\.createElement\("dialog"\)/);
  assert.match(editor, /nameLabel\.append\("Name"\)[\s\S]*urlLabel\.append\("Link"\)/);
  assert.doesNotMatch(editor, /window\.prompt/);
});

test("normalizes ASCII arrows in prose", () => {
  assert.equal(normalizeArrowText("first -> second -> third"), "first → second → third");
  assert.equal(normalizeArrowText("already → converted"), "already → converted");
});

test("normalizes ASCII left arrows in prose", () => {
  assert.equal(normalizeArrowText("left <- center -> right"), "left ← center → right");
});

test("preserves HTML comment terminators", () => {
  const marker = "<!-- cipherleaf-board:board-1: -->";
  assert.equal(normalizeArrowText(marker), marker);
});

test("leaves arrows inside fenced code unchanged", () => {
  const markdown = "```ts\nconst result = first -> second <- third;\n```\n\nafter -> code <- here";
  assert.equal(
    normalizeArrowText(markdown),
    "```ts\nconst result = first -> second <- third;\n```\n\nafter → code ← here",
  );
});

test("normalizes link labels without changing destinations", () => {
  assert.equal(
    normalizeArrowText("[first -> second <- third](https://example.test/a->b<-c)"),
    "[first → second ← third](https://example.test/a->b<-c)",
  );
});

test("limits underscore emphasis to standalone words", () => {
  assert.match(editor, /const italic = \/\(\?<\!\[\\p\{L\}\\p\{N\}_\]\)_\(\?=\\S\)\(\[\^\\s_\]\+\)_\(\?!\[\\p\{L\}\\p\{N\}_\]\)\/gu/);
});

test("uses asterisk emphasis for multi-word toolbar italics", () => {
  assert.match(editor, /aria-label="Make text italic"[\s\S]*wrapSelection\(editor, "\*"\)/);
  assert.match(editor, /const asteriskItalic = \/[\s\S]*\.\+\?\\S/);
});

test("keeps toolbar bold and italic markers composable", () => {
  assert.match(editor, /aria-label="Make text bold"[\s\S]*wrapSelection\(editor, "__"\)/);
  assert.match(editor, /const bold = \/\(\\\*\\\*\|__\)/);
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
  assert.deepEqual(parseAttachmentMarkdown(`![Right](attachment:${id}#width=99&align=right)`), { alt: "Right", id, width: 120, align: "right" });
  assert.deepEqual(parseAttachmentMarkdown(`![Right](attachment:${id}#width=2401&align=right)`), { alt: "Right", id, width: 2400, align: "right" });
  assert.deepEqual(parseAttachmentReferenceMarkdown(`![Image](attachment:${id})`), { id, kind: "image" });
  assert.deepEqual(parseAttachmentReferenceMarkdown(`[File](attachment:${id}#download)`), { id, kind: "file" });
  assert.equal(parseAttachmentReferenceMarkdown("[remote](https://example.com/file)"), null);
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

test("inserts pasted images without blank lines", () => {
  const image = attachmentMarkdown("b".repeat(32));
  assert.deepEqual(insertAttachmentMarkdown("before", 6, image), {
    from: 6,
    to: 6,
    insert: `\n${image}`,
  });
  assert.deepEqual(insertAttachmentMarkdown("before\n\nafter", 8, image), {
    from: 6,
    to: 8,
    insert: `\n${image}\n`,
  });
});

test("keeps pasted images at the supplied object indentation", () => {
  const image = attachmentMarkdown("b".repeat(32));
  assert.equal(
    insertAttachmentMarkdown("* parent", 8, image, "  ").insert,
    `\n  ${image}`,
  );
});

test("handles malformed markdown and insertion boundaries", () => {
  assert.equal(normalizeArrowText("first -> second\r\n~~~js\nkeep -> arrow\n~~~\nafter <- here"), "first → second\r\n~~~js\nkeep -> arrow\n~~~\nafter ← here");
  assert.deepEqual(markdownCitations("[missing]( [bad](https://example.com/a\n/b) [ok](file:///tmp/a)"), [
    { label: "ok", url: "file:///tmp/a", index: 43, length: 19 },
  ]);
  assert.equal(markdownCitation("", "https://example.com"), null);
  assert.equal(markdownCitation("line\nname", "https://example.com"), null);
  assert.equal(markdownCitation("Windows", "C:\\notes\\readme.md"), "[Windows](C:\\notes\\readme.md)");
  assert.equal(isTableDivider(""), false);
  const id = "c".repeat(32);
  assert.deepEqual(parseAttachmentMarkdown(`![Default](attachment:${id})`), { alt: "Default", id, width: 640, align: "left" });
  assert.equal(parseAttachmentMarkdown(`![Invalid](attachment:${id}#width=640&align=bad)`), null);
  assert.equal(parseAttachmentReferenceMarkdown(`![bad](attachment:${id.slice(1)}#width=)`), null);
  assert.equal(embeddedClipboardImage("data:image/jpeg;base64, YWJj ZA=="), "data:image/jpeg;base64,YWJjZA==");
  const image = attachmentMarkdown(id);
  assert.equal(insertAttachmentMarkdown(`\n${image}\n`, 0, image).from, 0);
  assert.equal(insertAttachmentMarkdown(`\n${image}\n`, 999, image).to, `\n${image}\n`.length);
});
