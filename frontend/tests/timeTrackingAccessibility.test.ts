import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../src/TimeTrackingView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const style = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const tagSelect = readFileSync(new URL("../src/TagMultiSelect.tsx", import.meta.url), "utf8");

test("time tracking navigation and dialogs expose keyboard semantics", () => {
  assert.match(view, /role="tablist"/);
  assert.match(view, /aria-selected=\{tab === item\}/);
  assert.match(view, /type="datetime-local"/);
  assert.match(view, /aria-modal="true"/);
  assert.match(view, /tabIndex=\{0\}/);
});

test("dashboard chart and global timer have accessible descriptions", () => {
  assert.match(view, /role="img" aria-label="Tracked time by local calendar day"/);
  assert.match(app, /className="global-timer-indicator"[^>]+aria-label=/);
  assert.match(app, /closest\("\[role=dialog\]"\)/);
});

test("tracking conflicts require an explicit accessible dialog choice", () => {
  assert.match(app, /aria-labelledby="tracking-conflict-title"/);
  assert.match(app, />Keep local</);
  assert.match(app, />Use remote</);
});

test("timer shortcuts open opaque modals without changing workspace views", () => {
  assert.match(app, /event\.preventDefault\(\); openStartTimerDialog\(\); return;/);
  assert.match(app, /setTimerDialog\("finish"\); return;/);
  assert.match(app, /className="vault-modal timer-modal" role="dialog" aria-modal="true"/);
  assert.match(style, /\.timer-modal \{ background: var\(--modal-surface\); \}/);
});

test("all modal surfaces and controls use opaque theme colors", () => {
  assert.match(style, /\.vault-modal,[\s\S]*\.global-search-panel \{ background-color: var\(--modal-surface\) !important; background-image: none !important; opacity: 1; \}/);
  assert.match(style, /\.time-tracking-dialog textarea \{ background-color: var\(--modal-control-surface\) !important; opacity: 1; \}/);
});

test("week days are keyboard-selectable and filter the activity list", () => {
  assert.match(view, /role="button" tabIndex=\{0\} aria-pressed=\{selectedWeekDay === key\}/);
  assert.match(view, /selectedWeekEntries\.map/);
});

test("task tag choices use a reusable multi-select dropdown", () => {
  assert.match(tagSelect, /<details className=/);
  assert.match(tagSelect, /role="group" aria-label=\{label\}/);
  assert.doesNotMatch(view, /<legend>Tags<\/legend>/);
  assert.match(app, /<TagMultiSelect tags=/);
});

test("tracking project choices use the same themed custom dropdown", () => {
  assert.match(tagSelect, /export function ProjectSelect/);
  assert.match(tagSelect, /role="listbox" aria-label=\{label\}/);
  assert.match(app, /<ProjectSelect projects=/);
  assert.doesNotMatch(app, /<label>Project<select/);
});

test("dashboard tag guidance is subdued and expanded task rows are indented", () => {
  assert.match(style, /section:nth-child\(2\) > small[^}]+color: var\(--muted\); font-size: 8px/);
  assert.match(style, /section:nth-child\(3\) > div > p \{ padding-left: 18px/);
});
