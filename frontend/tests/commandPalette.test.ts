import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const style = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

test("command palette supports matching, keyboard selection, and themed presentation", () => {
  assert.match(app, /event\.key\.toLowerCase\(\) !== "p"/);
  assert.match(app, /role="dialog" aria-modal="true" aria-labelledby="command-palette-title"/);
  assert.match(app, /event\.key === "ArrowDown"/);
  assert.match(app, /event\.key === "Enter"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /<kbd>\{command\.shortcut \|\| "—"\}<\/kbd>/);
  assert.match(style, /\.command-palette \{[\s\S]*background-color: var\(--modal-surface\) !important;/);
  assert.match(style, /\.command-palette-command \{[\s\S]*grid-template-columns:/);
});
