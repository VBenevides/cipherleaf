import test from "node:test";
import assert from "node:assert/strict";
import { rankQuickSwitcher } from "../src/quickSwitcher.ts";

const notes = [
  { id: "1", title: "Project roadmap" },
  { id: "2", title: "Personal journal" },
  { id: "3", title: "Release plan" },
];

test("quick switcher prioritizes contiguous title matches", () => {
  assert.deepEqual(rankQuickSwitcher(notes, "plan").map((note) => note.id), ["3"]);
});

test("quick switcher supports fuzzy and case-insensitive matches", () => {
  assert.equal(rankQuickSwitcher(notes, "PSJ")[0]?.id, "2");
});

test("quick switcher limits empty results", () => {
  assert.equal(rankQuickSwitcher(Array.from({ length: 30 }, (_, id) => ({ id: String(id), title: String(id) })), "").length, 20);
  assert.deepEqual(rankQuickSwitcher(notes, "zzz"), []);
});
