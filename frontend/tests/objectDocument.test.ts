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

test("logical text duplication inserts the complete object after its target", () => {
  assert.equal(insertLogicalObjectAfterCaret("Plain\nNext", "Plain", 2), "Plain\nPlain\nNext");
});
