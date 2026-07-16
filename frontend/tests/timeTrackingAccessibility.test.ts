import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../src/TimeTrackingView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

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
  assert.match(app, /closest\("input, textarea, select, \[contenteditable=true\], \[role=dialog\]"\)/);
});

test("tracking conflicts require an explicit accessible dialog choice", () => {
  assert.match(app, /aria-labelledby="tracking-conflict-title"/);
  assert.match(app, />Keep local</);
  assert.match(app, />Use remote</);
});
