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

test("completed tasks can resume with the same labels", () => {
  assert.match(view, /StartTimeEntryForClient\(entry\.name, resumedClientID, entry\.projectId \?\? "", entry\.tagIds \?\? \[\]\)/);
  assert.match(view, />Resume<\/button>/);
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

test("client selection filters projects and project selection fills the client", () => {
  assert.match(tagSelect, /export function ClientSelect/);
  assert.match(view, /project\.clientId === clientID/);
  assert.match(view, /if \(!clientID\) setClientID/);
  assert.match(view, /label="Filter client"/);
  assert.match(app, /<ClientSelect clients=/);
});

test("dashboard tag guidance is subdued and expanded task rows are indented", () => {
	assert.match(style, /\.dashboard-groups header small \{ color: var\(--muted\); font-size: 8px/);
	assert.match(style, /\.dashboard-group-rows > div > p \{ padding-left: 18px/);
});

test("dashboard groups clients with percentage durations in a scrollable two-column grid", () => {
	assert.match(view, /<h3>Clients<\/h3>/);
	assert.match(view, /formatDurationWithPercentage\(item\.totalSeconds, clientsTotal\)/);
	assert.match(style, /\.dashboard-groups \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
	assert.match(style, /\.dashboard-groups section \{ height: 196px/);
	assert.match(style, /\.dashboard-group-rows \{ min-height: 0; overflow-y: auto; \}/);
});

test("dashboard period selection uses the themed custom dropdown", () => {
  assert.match(view, /<DashboardPeriodSelect value=\{dashboardCustom \? "custom" : dashboardPreset\}/);
  assert.match(tagSelect, /export function DashboardPeriodSelect/);
  assert.doesNotMatch(view, /<select aria-label="Period"/);
});
