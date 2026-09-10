import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const style = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

test("command palette supports matching, keyboard selection, and themed presentation", () => {
  assert.match(app, /event\.key\.toLowerCase\(\) !== "p"/);
  assert.match(app, /<dialog open className="global-search-panel command-palette" aria-modal="true" aria-labelledby="command-palette-title"/);
  assert.match(app, /event\.key === "ArrowDown"/);
  assert.match(app, /event\.key === "Enter"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /<kbd>\{command\.shortcut \|\| "—"\}<\/kbd>/);
  assert.match(style, /\.command-palette \{[\s\S]*background-color: var\(--modal-surface\) !important;/);
  assert.match(style, /\.command-palette-command \{[\s\S]*grid-template-columns:/);
});

test("command palette opens the scratchpad", () => {
  const source = app.match(/\{\n      id: "scratchpad",[\s\S]*?\n    \},/);
  assert.ok(source);
  assert.match(source[0], /shortcut: scratchpadShortcut/);
  assert.match(source[0], /name: "Open Scratchpad"/);
  assert.match(source[0], /description: "Open the session scratchpad"/);
  let calls = 0;
  const command = new Function("activateScratchpad", "scratchpadShortcut", `return (${source[0].slice(0, -1)})`)(
    () => { calls += 1; },
    "Super+`",
  ) as { run: () => void };
  command.run();
  assert.equal(calls, 1);
});

test("command palette exposes shortcut settings", () => {
  assert.match(app, /id: "scratchpad-shortcuts"/);
  assert.match(app, /openAppearanceSettings\("settings-shortcuts"\)/);
  assert.match(app, /Command palette <kbd>Ctrl\/Cmd \+ Shift \+ P<\/kbd>/);
});
