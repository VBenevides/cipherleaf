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
  assert.match(app, /event\.target !== event\.currentTarget \|\| \(event\.key !== "Enter" && event\.key !== " "\)/);
  assert.match(app, /onFocus=\{\(\) => setCommandPaletteIndex\(index\)\}/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /formatShortcut\(shortcutMap\["new-note"\]\)/);
  assert.match(app, /shortcutEditingID === command\.id/);
  assert.match(style, /\.command-palette \{[\s\S]*background-color: var\(--modal-surface\) !important;/);
  assert.match(style, /\.command-palette-command \{[\s\S]*grid-template-columns:/);
});

test("command palette opens the scratchpad", () => {
  const source = app.match(/\{\n      id: "scratchpad",[\s\S]*?\n    \},/);
  assert.ok(source);
  assert.match(source[0], /shortcut: formatShortcut\(scratchpadShortcut\)/);
  assert.match(source[0], /name: "Open scratchpad"/);
  assert.match(source[0], /description: "Open the selected scratchpad note"/);
  assert.match(source[0], /run: activateShortcutTarget/);
  let calls = 0;
  const command = new Function("activateShortcutTarget", "scratchpadShortcut", "formatShortcut", `return (${source[0].slice(0, -1)})`)(
    () => { calls += 1; },
    "Super+`",
    (shortcut: string) => shortcut,
  ) as { run: () => void };
  command.run();
  assert.equal(calls, 1);
});

test("command palette edits dynamic shortcuts without closing", () => {
  assert.match(app, /const SHORTCUTS_STORAGE_KEY = "cipherleaf-shortcuts"/);
  assert.match(app, /const \[shortcutMap, setShortcutMap\] = useState/);
  assert.match(app, /const handleCommandPaletteShortcutCapture/);
  assert.match(app, /RESERVED_SHORTCUTS\.has\(shortcut\)/);
  assert.match(app, /Object\.entries\(\{ \.\.\.shortcutMap, scratchpad: scratchpadShortcut \}\)/);
  assert.match(app, /That shortcut is already assigned to/);
  assert.match(app, /resetShortcut\(command\.id\)/);
  assert.match(app, /Reset all shortcuts/);
  assert.match(app, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(app, /id: "scratchpad-shortcuts"/);
  assert.doesNotMatch(app, /settings-shortcuts/);
  assert.match(app, /Command palette <kbd>Ctrl\/Cmd \+ Shift \+ P<\/kbd>/);
});
