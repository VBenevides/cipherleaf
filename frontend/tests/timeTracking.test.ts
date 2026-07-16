import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatLocalDate,
  formatLocalDateTime,
  dashboardPresetRange,
  formatRunningDuration,
  initialTimeTrackingTab,
  inclusiveLocalDateRange,
  localMonthRange,
  localMonthGrid,
  localDateTimeToUTC,
  localDateTimeValue,
  localDateKey,
  localWeekDates,
  localWeekRange,
  runningElapsedSeconds,
  TIME_TRACKING_TABS,
} from "../src/timeTracking.ts";

process.env.TZ = "America/New_York";

test("time tracking opens on week and exposes the ordered workspace tabs", () => {
  assert.equal(initialTimeTrackingTab(), "week");
  assert.deepEqual(TIME_TRACKING_TABS, ["week", "month", "dashboard", "clients", "projects", "tags"]);
});

test("dashboard presets produce complete local periods", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.deepEqual(dashboardPresetRange("last-week", now), localWeekRange(new Date(2026, 6, 9)));
  assert.deepEqual(dashboardPresetRange("last-month", now), localMonthRange(new Date(2026, 5, 1)));
});

test("local weeks run Monday through Sunday across DST", () => {
  assert.deepEqual(localWeekRange(new Date("2026-03-08T16:00:00Z")), {
    startUTC: "2026-03-02T05:00:00.000Z",
    endUTC: "2026-03-09T04:00:00.000Z",
  });
});

test("weekly calendar always contains Monday through Sunday", () => {
  const days = localWeekDates(new Date("2026-07-16T12:00:00Z"));
  assert.deepEqual(days.map(localDateKey), ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"]);
});

test("time entries use a local YYYY/MM/DD date prefix", () => {
  const date = new Date("2026-07-16T12:00:00Z");
  assert.equal(formatLocalDate(date), "2026/07/16");
  assert.equal(formatLocalDateTime(date), "2026/07/16, 8:00:00 AM");
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

test("month grids include complete Sunday-based leading and trailing weeks", () => {
  const days = localMonthGrid(new Date("2026-02-15T12:00:00Z"));
  assert.equal(days.length, 28);
  assert.equal(localDateKey(days[0]), "2026-02-01");
  assert.equal(localDateKey(days.at(-1)!), "2026-02-28");
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

test("entry corrections convert local date-time fields to and from UTC", () => {
  assert.equal(localDateTimeValue("2026-07-16T14:30:00Z"), "2026-07-16T10:30");
  assert.equal(localDateTimeToUTC("2026-07-16T10:30"), "2026-07-16T14:30:00.000Z");
  assert.throws(() => localDateTimeToUTC(""));
});
