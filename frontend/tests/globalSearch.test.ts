import assert from "node:assert/strict";
import test from "node:test";
import { canReplaceSearch, isAdvancedSearchQuery, searchResultsKey } from "../src/globalSearch.ts";

test("global replacement requires current completed plain-text results", () => {
  const current = searchResultsKey("new", false, false);
  assert.equal(canReplaceSearch("new", searchResultsKey("old", false, false), false, false, false), false);
  assert.equal(canReplaceSearch("new", current, true, false, false), false);
  assert.equal(canReplaceSearch("new", current, false, false, false), true);
  assert.equal(canReplaceSearch("new", current, false, true, false), false);
});

test("advanced search syntax cannot be used as replacement text", () => {
  assert.equal(isAdvancedSearchQuery("tag:work"), true);
  assert.equal(isAdvancedSearchQuery("notes tag:work"), true);
  assert.equal(isAdvancedSearchQuery("https://example.com"), false);
  assert.equal(canReplaceSearch("re:secret", searchResultsKey("re:secret", false, false), false, false, false), false);
});
