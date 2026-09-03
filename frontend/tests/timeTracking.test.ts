import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatDurationWithPercentage,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  dashboardPresetRange,
  formatRunningDuration,
  inclusiveLocalDateRange,
  localMonthRange,
  localMonthGrid,
  localDateTimeToUTC,
  localDateTimeValue,
  localDateKey,
  localWeekDates,
  localWeekRange,
  millisecondsUntilNextDurationMinute,
  runningElapsedSeconds,
  TIME_TRACKING_TABS,
} from "../src/timeTracking.ts";

process.env.TZ = "America/New_York";

test("time tracking exposes the ordered workspace tabs", () => {
  assert.deepEqual(TIME_TRACKING_TABS, ["week", "month", "dashboard", "clients", "projects", "tags"]);
});

test("dashboard presets produce complete local periods", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.deepEqual(dashboardPresetRange("current-week", now), localWeekRange(now));
  assert.deepEqual(dashboardPresetRange("last-week", now), localWeekRange(new Date(2026, 6, 9)));
  assert.deepEqual(dashboardPresetRange("current-month", now), localMonthRange(now));
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
  assert.equal(formatLocalTime(date), "08:00");
  assert.equal(formatLocalDateTime(date), "2026/07/16, 08:00");
  assert.equal(formatLocalTime(new Date("2026-07-16T04:00:00Z")), "00:00");
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
	assert.equal(formatDurationWithPercentage(4000, 6000), "1h 06m (67%)");
	assert.equal(formatDurationWithPercentage(2000, 6000), "33m (33%)");
	assert.equal(formatDurationWithPercentage(1, 0), "0m (0%)");
  const now = new Date("2026-07-16T11:05:30Z");
  assert.equal(runningElapsedSeconds("2026-07-16T10:00:00Z", now), 3930);
  assert.equal(formatRunningDuration("2026-07-16T10:00:00Z", now), "1h 05m");
  assert.equal(runningElapsedSeconds("2026-07-16T12:00:00Z", now), 0);
  assert.equal(runningElapsedSeconds("invalid", now), 0);
  assert.equal(millisecondsUntilNextDurationMinute("2026-07-16T11:00:00Z", now), 30_000);
  assert.equal(millisecondsUntilNextDurationMinute("invalid", now), 60_000);
});

test("entry corrections convert local date-time fields to and from UTC", () => {
  assert.equal(localDateTimeValue("2026-07-16T14:30:00Z"), "2026-07-16T10:30");
  assert.equal(localDateTimeToUTC("2026-07-16T10:30"), "2026-07-16T14:30:00.000Z");
  assert.throws(() => localDateTimeToUTC(""));
  assert.equal(localDateTimeValue("invalid"), "");
  assert.throws(() => inclusiveLocalDateRange("not-a-date", "2026-03-01"), /YYYY-MM-DD/);
  assert.throws(() => inclusiveLocalDateRange("2026-02-29", "2026-03-01"), /invalid/);
});

test("covers calendar edges and invalid clock inputs", () => {
  const sunday = new Date("2026-07-19T12:00:00Z");
  assert.equal(localDateKey(localWeekDates(sunday)[0]), "2026-07-13");
  assert.equal(localMonthGrid(new Date("2026-08-15T12:00:00Z")).length, 42);
  assert.equal(formatDuration(-1), "0m");
  assert.equal(formatDuration(3600), "1h 00m");
  assert.equal(runningElapsedSeconds("2026-07-16T10:00:00Z", new Date("invalid")), 0);
  assert.equal(millisecondsUntilNextDurationMinute("2026-07-16T12:00:00Z", new Date("2026-07-16T11:05:30Z")), 60_000);
  assert.equal(millisecondsUntilNextDurationMinute("2026-07-16T11:00:00Z", new Date("invalid")), 60_000);
});
