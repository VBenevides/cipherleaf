import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatRunningDuration,
  inclusiveLocalDateRange,
  localMonthRange,
  localWeekRange,
  runningElapsedSeconds,
} from "../src/timeTracking.ts";

process.env.TZ = "America/New_York";

test("local weeks run Monday through Sunday across DST", () => {
  assert.deepEqual(localWeekRange(new Date("2026-03-08T16:00:00Z")), {
    startUTC: "2026-03-02T05:00:00.000Z",
    endUTC: "2026-03-09T04:00:00.000Z",
  });
});

test("local month ranges include complete leap and DST months", () => {
  assert.deepEqual(localMonthRange(new Date("2026-03-15T12:00:00Z")), {
    startUTC: "2026-03-01T05:00:00.000Z",
    endUTC: "2026-04-01T04:00:00.000Z",
  });
  assert.deepEqual(localMonthRange(new Date("2024-02-15T12:00:00Z")), {
    startUTC: "2024-02-01T05:00:00.000Z",
    endUTC: "2024-03-01T05:00:00.000Z",
  });
});

test("inclusive local dates become half-open UTC ranges", () => {
  assert.deepEqual(inclusiveLocalDateRange("2026-03-08", "2026-03-08"), {
    startUTC: "2026-03-08T05:00:00.000Z",
    endUTC: "2026-03-09T04:00:00.000Z",
  });
  assert.throws(() => inclusiveLocalDateRange("2026-02-30", "2026-03-01"));
  assert.throws(() => inclusiveLocalDateRange("2026-03-02", "2026-03-01"));
});

test("durations and running clocks are safe and deterministic", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(3900), "1h 05m");
  assert.equal(formatDuration(Number.NaN), "0m");
  const now = new Date("2026-07-16T11:05:30Z");
  assert.equal(runningElapsedSeconds("2026-07-16T10:00:00Z", now), 3930);
  assert.equal(formatRunningDuration("2026-07-16T10:00:00Z", now), "1h 05m");
  assert.equal(runningElapsedSeconds("2026-07-16T12:00:00Z", now), 0);
  assert.equal(runningElapsedSeconds("invalid", now), 0);
});
