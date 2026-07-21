import test from "node:test";
import assert from "node:assert/strict";
import { formatDailyTitle, renderNoteTemplate } from "../src/dailyNotes.ts";

const date = new Date(2026, 6, 13, 9, 5);

test("daily note titles use configured date tokens", () => {
  assert.equal(formatDailyTitle(date, "DD.MM.YYYY"), "13.07.2026");
});

test("daily templates expand title and date variables", () => {
  assert.equal(renderNoteTemplate("# {{title}}\n{{date}} {{time}}", "Journal", date), "# Journal\n2026-07-13 09:05");
});
