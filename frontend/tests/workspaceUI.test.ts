import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const style = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

test("note tabs expose navigation, close, new-tab, and idle unloading", () => {
  assert.match(app, /Open in a New Tab/);
  assert.match(app, /event\.altKey && \/\^\\d\$\//);
  assert.match(app, /event\.ctrlKey && event\.key\.toLowerCase\(\) === "t"/);
  assert.match(app, /event\.ctrlKey && event\.key\.toLowerCase\(\) === "w"/);
  assert.match(app, /Date\.now\(\) - 60_000/);
  assert.match(app, /tabNoteCacheRef\.current\.delete\(tab\.id\)/);
});

test("compact sidebar controls share rows", () => {
  assert.match(style, /\.sidebar-view-buttons \{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(style, /\.sidebar-vault-buttons \{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(style, /\.vault-selector-button \{[\s\S]*height: 34px/);
});

test("window switching does not trigger a caret-moving save", () => {
  assert.match(app, /if \(!event\.relatedTarget && !document\.hasFocus\(\)\) return;/);
});

test("vault settings reload synced file-history preferences", () => {
  assert.match(app, /VaultService\.GetVaultSettings\(\)/);
  assert.match(app, /applyVaultSettings\(vaultSettings\)/);
  assert.match(app, /\[fileHistoryLimit, setFileHistoryLimit\] = useState\(10\)/);
  assert.match(app, /setFileHistoryLimitDraft\(settings\.fileHistoryLimit\)/);
  assert.match(app, /fileHistoryLimit: fileHistoryLimitDraft/);
  assert.match(app, /VaultService\.CleanHistory\(\)/);
});

test("editor font selection supports installed fonts and .ttf files", () => {
  assert.match(app, /VaultService\.ListInstalledFonts\(\)/);
  assert.match(app, /queryLocalFonts/);
  assert.match(app, /className="tag-multi-select appearance-font-select"/);
  assert.match(app, /style=\{\{ fontFamily: font \}\}/);
  assert.doesNotMatch(app, /<select aria-label="Installed editor font"/);
  assert.match(app, /<dt>Name:<\/dt>/);
  assert.match(app, /<dt>Sample:<\/dt>/);
  assert.match(app, /fontFamily: "var\(--selected-editor-font, var\(--editor-font\)\)"/);
  assert.match(app, /The quick brown fox jumps over the lazy dog 1234567890/);
  assert.doesNotMatch(app, /appearance-help/);
  assert.match(app, /"Installed fonts…"/);
  assert.match(app, /installedFontsLoading \? "Loading fonts…"/);
  assert.match(app, /setTimeout\(\(\) => setInstalledFonts\(\[\]\), 10 \* 60_000\)/);
  assert.match(app, />Select \.ttf…</);
  assert.match(style, /font-family: var\(--selected-editor-font\), monospace !important/);
  assert.match(style, /font-size: clamp\(9px, 3cqi, 14px\)/);
  assert.match(style, /white-space: normal !important/);
});
