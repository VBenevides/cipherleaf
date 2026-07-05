import assert from "node:assert/strict";
import test from "node:test";
import { classifyMarkdownURL } from "../src/markdownSecurity.ts";

test("allows only explicit web URLs and local anchors", () => {
  assert.deepEqual(classifyMarkdownURL("https://example.com/a"), {
    kind: "external",
    href: "https://example.com/a",
  });
  assert.deepEqual(classifyMarkdownURL("#heading"), {
    kind: "anchor",
    href: "#heading",
  });
  assert.equal(classifyMarkdownURL("javascript:alert(1)").kind, "blocked");
  assert.equal(classifyMarkdownURL("file:///tmp/private").kind, "blocked");
  assert.equal(classifyMarkdownURL("data:text/html,test").kind, "blocked");
  assert.equal(classifyMarkdownURL("/relative/path").kind, "blocked");
});

test("decodes valid wikilinks and blocks malformed encoding", () => {
  assert.deepEqual(classifyMarkdownURL("#wikilink-Project%20Plan"), {
    kind: "wikilink",
    title: "Project Plan",
  });
  assert.equal(classifyMarkdownURL("#wikilink-%E0%A4%A").kind, "blocked");
});
