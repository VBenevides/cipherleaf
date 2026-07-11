import assert from "node:assert/strict";
import test from "node:test";

import { syncFinishedMessage } from "../src/syncTiming.ts";

test("formats sync duration with two decimal places", () => {
  assert.equal(syncFinishedMessage(1234), "Cloud sync finished after: 1.23 seconds");
  assert.equal(syncFinishedMessage(5), "Cloud sync finished after: 0.01 seconds");
});
