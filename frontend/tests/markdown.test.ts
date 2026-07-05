import assert from "node:assert/strict";
import test from "node:test";
import { isHorizontalRule } from "../src/markdown.ts";

test("recognizes a three-dash horizontal rule line", () => {
  assert.equal(isHorizontalRule("---"), true);
  assert.equal(isHorizontalRule("  ---  "), true);
  assert.equal(isHorizontalRule("----"), false);
  assert.equal(isHorizontalRule("--- text"), false);
});
