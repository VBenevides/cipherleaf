import assert from "node:assert/strict";
import test from "node:test";
import { expandSnippetWithContext, rollLastDatedSection } from "../src/snippets.ts";

test("rolls the last dated outline section with today's date", () => {
  const markdown = [
    "> 2026-07-06",
    "  > old",
    "> 2026-07-07",
    "  > [ ] open",
    "  > plain",
  ].join("\n");

  assert.equal(
    rollLastDatedSection(markdown, new Date(2026, 6, 8)),
    [
      "> 2026-07-08",
      "  > [ ] open",
      "  > plain",
    ].join("\n"),
  );
});

test("roll omits completed checkbox lines and completed child sections", () => {
  const markdown = [
    "> 2026-07-07",
    "  > [x] finished task",
    "  > [ ] open task",
    "  > [X] Inner Section",
    "    > keep out",
    "    > [ ] keep out too",
    "  > keep this",
  ].join("\n");

  assert.equal(
    rollLastDatedSection(markdown, new Date(2026, 6, 8)),
    [
      "> 2026-07-08",
      "  > [ ] open task",
      "  > keep this",
    ].join("\n"),
  );
});

test("rollb snippet uses markdown before the trigger", () => {
  const markdown = [
    "> 2026-07-07",
    "  > [ ] open",
    "",
  ].join("\n");

  assert.equal(
    expandSnippetWithContext("rollb", markdown, "", new Date(2026, 6, 8)),
    [
      "> 2026-07-08",
      "  > [ ] open",
    ].join("\n"),
  );
});

test("roll stops at blank and root text boundaries", () => {
  assert.equal(
    rollLastDatedSection(
      [
        "> 2026-07-07",
        "  > [ ] open",
        "",
        "root text",
        "  > outside",
      ].join("\n"),
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  > [ ] open",
    ].join("\n"),
  );
});

test("rollb uses the previous dated root section", () => {
  assert.equal(
    expandSnippetWithContext(
      "rollb",
      [
        "> 2026-07-06",
        "  > stale",
        "> 2026-07-07",
        "  > [ ] open",
      ].join("\n"),
      "",
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  > [ ] open",
    ].join("\n"),
  );
});

test("roll accepts dated section headings with trailing text", () => {
  assert.equal(
    rollLastDatedSection(
      [
        "> 2026-07-07: plan",
        "  > [ ] open",
      ].join("\n"),
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  > [ ] open",
    ].join("\n"),
  );
});

test("roll accepts spaces between outline marker and date", () => {
  assert.equal(
    expandSnippetWithContext(
      "rollb",
      [
        ">     2026-07-07",
        "  > [ ] open",
      ].join("\n"),
      "",
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  > [ ] open",
    ].join("\n"),
  );
  assert.equal(
    expandSnippetWithContext(
      "rollf",
      "",
      [
        ">     2026-07-07",
        "  > [ ] open",
      ].join("\n"),
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  > [ ] open",
    ].join("\n"),
  );
});

test("rollf uses the next dated root section", () => {
  assert.equal(
    expandSnippetWithContext(
      "rollf",
      "# Header\n",
      [
        "",
        "> 2026-07-07",
        "  > [x] done",
        "  > [ ] open",
        "> 2026-07-09",
        "  > later",
      ].join("\n"),
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  > [ ] open",
    ].join("\n"),
  );
});

test("roll preserves a fenced code child and every child after it", () => {
  assert.equal(
    rollLastDatedSection(
      [
        "> 2026-07-07",
        "  > before",
        "  ```typescript",
        "const nested = {",
        "  kept: true,",
        "};",
        "  ```",
        "  > after",
        "    > [ ] nested after",
      ].join("\n"),
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  > before",
      "  ```typescript",
      "const nested = {",
      "  kept: true,",
      "};",
      "  ```",
      "  > after",
      "    > [ ] nested after",
    ].join("\n"),
  );
});

test("roll preserves fenced code without a language", () => {
  assert.equal(
    rollLastDatedSection(
      [
        "> 2026-07-07",
        "  ```",
        "unindented code",
        "  ```",
        "  > after",
      ].join("\n"),
      new Date(2026, 6, 8),
    ),
    [
      "> 2026-07-08",
      "  ```",
      "unindented code",
      "  ```",
      "  > after",
    ].join("\n"),
  );
});
