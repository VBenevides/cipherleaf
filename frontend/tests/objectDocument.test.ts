import assert from "node:assert/strict";
import test from "node:test";
import { insertLogicalObjectAfterCaret } from "../src/objectDocument.ts";

test("logical object paste inserts the complete object after its target", () => {
  const source = "- Parent\n  - Child\n- Next";
  const copied = "- Copy\n  - Nested";
  assert.equal(
    insertLogicalObjectAfterCaret(source, copied, source.indexOf("Child")),
    "- Parent\n  - Child\n  - Copy\n    - Nested\n- Next",
  );
});

test("plain text paste keeps the normal editor path", () => {
  assert.equal(insertLogicalObjectAfterCaret("Plain", "text", 2), "Plain");
});
