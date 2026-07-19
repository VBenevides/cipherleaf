import assert from "node:assert/strict";
import test from "node:test";
import { createSerialTaskRunner } from "../src/serialTask.ts";

test("serial task runner never starts a newer task before the older task settles", async () => {
  const run = createSerialTaskRunner();
  const events: string[] = [];
  let releaseFirst = () => {};
  const first = run(async () => {
    events.push("first:start");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    events.push("first:end");
  });
  const second = run(async () => { events.push("second"); });
  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});
