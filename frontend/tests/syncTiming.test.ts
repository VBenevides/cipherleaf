import assert from "node:assert/strict";
import test from "node:test";

import { syncFinishedMessage, syncTimingMessages } from "../src/syncTiming.ts";

test("formats sync duration with two decimal places", () => {
  assert.equal(syncFinishedMessage(1234), "Cloud sync finished after: 1.23 seconds");
  assert.equal(syncFinishedMessage(5), "Cloud sync finished after: 0.01 seconds");
});

test("formats each sync step and wall time in milliseconds and seconds", () => {
  assert.deepEqual(syncTimingMessages({
    pullMilliseconds: 123,
    mergeMilliseconds: 4,
    pushMilliseconds: 567,
    transportMilliseconds: 600,
    localMilliseconds: 94,
    totalMilliseconds: 694,
  }, 701.25), [
    "Sync pull: 123.00 ms (0.123 s)",
    "Sync merge: 4.00 ms (0.004 s)",
    "Sync push: 567.00 ms (0.567 s)",
    "Sync transport total: 600.00 ms (0.600 s)",
    "Sync local total: 94.00 ms (0.094 s)",
    "Sync backend total: 694.00 ms (0.694 s)",
    "Sync elapsed (wall): 701.25 ms (0.701 s)",
  ]);
});

test("formats Git connection and repository diagnostics", () => {
  const messages = syncTimingMessages({
    pullMilliseconds: 1,
    mergeMilliseconds: 2,
    pushMilliseconds: 3,
    transportMilliseconds: 4,
    localMilliseconds: 2,
    totalMilliseconds: 6,
  }, 7, {
    sshConnectionReuse: true,
    sshConnectionPersistSeconds: 30,
    transportOperations: 2,
    gitBytes: 1048576,
    repositoryFilesBytes: 2097152,
    platform: "linux",
    architecture: "amd64",
    gitVersion: "git version 2.50.0",
    openSshVersion: "OpenSSH_10.0p2",
    usedPrefetch: true,
    repositoryPath: "/cache/vault",
  });

  assert.deepEqual(messages.slice(-10), [
    "Platform: linux/amd64",
    "Git version: git version 2.50.0",
    "OpenSSH version: OpenSSH_10.0p2",
    "Git SSH connection reuse: enabled (connections persist 30 s)",
    "Git prefetch used: yes",
    "Git transport operations: 2 (physical connection count is not exposed by OpenSSH)",
    "Git repository location: /cache/vault",
    "Git metadata (.git): 1048576 bytes (1.00 MiB)",
    "Git repository files: 2097152 bytes (2.00 MiB)",
    "Sync elapsed (wall): 7.00 ms (0.007 s)",
  ]);
});
