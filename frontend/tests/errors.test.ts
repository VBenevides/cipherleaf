import assert from "node:assert/strict";
import test from "node:test";
import { errorText } from "../src/errors.ts";

test("presents actionable vault and file errors", () => {
  assert.match(errorText("no encrypted vault exists in this folder"), /couldn’t find an encrypted vault/i);
  assert.match(errorText(new Error("a vault already exists in this folder")), /already contains an encrypted vault/i);
  assert.match(errorText("an encrypted note file is missing"), /required encrypted file could not be found/i);
});

test("preserves useful validation errors and handles unknown values", () => {
  assert.equal(errorText("vault name is required"), "vault name is required");
  assert.equal(errorText('{"message":"time entry end must be later than its start"}'), "time entry end must be later than its start");
  assert.equal(errorText({}), "Something went wrong. Please try again.");
});
