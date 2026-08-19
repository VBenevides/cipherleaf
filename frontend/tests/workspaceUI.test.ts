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
  assert.match(style, /\.note-tabs \{[\s\S]*min-height: 28px[\s\S]*padding: 2px 8px 0/);
  assert.match(style, /\.note-tab span \{[\s\S]*font-size: 0\.66em/);
});

test("compact sidebar controls share rows", () => {
  assert.match(style, /\.sidebar-view-buttons \{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(style, /\.sidebar-vault-buttons \{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(style, /\.vault-selector-button \{[\s\S]*height: 34px/);
});

test("recent vault entries can be removed", () => {
  assert.match(app, /RemoveRecentVaultPath/);
  assert.match(app, /className="vault-selector-remove"/);
  assert.match(style, /\.vault-selector-remove \{/);
});

test("window switching does not trigger a caret-moving save", () => {
  assert.match(app, /if \(!event\.relatedTarget && !document\.hasFocus\(\)\) return;/);
});

test("background saves consume rejected promises and preserve retry state", () => {
  assert.match(app, /const persistCurrentInBackground = \(snapshot = noteRef\.current\) => \{[\s\S]*persistCurrent\(snapshot\)\.catch/);
  assert.match(app, /const removeFileAttachment = async[\s\S]*try \{[\s\S]*await persistCurrent\(\);[\s\S]*\} catch/);
  assert.match(app, /run: \(\) => persistCurrentInBackground\(\)/);
  assert.doesNotMatch(app, /void persistCurrent\(\);/);
});

test("note-level attachment insertion is visible beside the view tabs", () => {
  assert.match(app, /className="document-heading-actions"[\s\S]*Attach encrypted file…/);
  assert.match(app, /onClick=\{\(\) => void attachFile\(\)\}/);
  assert.match(style, /\.document-heading-actions \{[\s\S]*justify-content: flex-end/);
});

test("vault settings reload synced file-history preferences", () => {
  assert.match(app, /VaultService\.GetVaultSettings\(\)/);
  assert.match(app, /applyVaultSettings\(vaultSettings\)/);
  assert.match(app, /\[fileHistoryLimit, setFileHistoryLimit\] = useState\(10\)/);
  assert.match(app, /setFileHistoryLimitDraft\(settings\.fileHistoryLimit\)/);
  assert.match(app, /fileHistoryLimit: fileHistoryLimitDraft/);
  assert.match(app, /VaultService\.CleanHistory\(\)/);
});

test("failed inactivity and system locks retry without discarding the draft", () => {
  assert.match(app, /if \(!await autoLock\(\)\) timer = window\.setTimeout/);
  assert.match(app, /Math\.min\(delay, 60_000\)/);
  assert.match(app, /cipherleaf:system-lock-requested/);
  assert.match(app, /if \(!await autoLockRef\.current\(\)\) retry = window\.setTimeout/);
});

test("vault settings configure scheduled encrypted backups", () => {
  assert.match(app, /VaultService\.CreateScheduledBackup\(backupDirectory, backupRetention\)/);
  assert.match(app, /cipherleaf-backup-\$\{field\}:\$\{vaultID\}/);
  assert.match(app, /Creates one encrypted snapshot per day/);
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

test("note titles can be collapsed and restored", () => {
  assert.match(app, /cipherleaf-title-collapsed/);
  assert.match(app, /aria-label=\{titleCollapsed \? "Expand title" : "Collapse title"\}/);
  assert.match(app, /titleCollapsed \? "▸" : "▾"/);
  assert.match(app, /document-heading-main[\s\S]*?view-tabs/);
  assert.match(app, /!titleCollapsed && \([\s\S]*?className="view-tabs"/);
  assert.match(style, /\.document-heading\.is-collapsed/);
  assert.match(style, /\.document-heading:not\(\.is-collapsed\)/);
  assert.match(style, /\.document-heading > \.view-tabs/);
  assert.match(style, /\.document-heading:not\(\.is-collapsed\) > \.view-tabs[\s\S]*margin-top: 8px/);
  assert.match(style, /:root\[data-theme="archivist"\] \.document-heading > \.view-tabs/);
});

test("editor chrome stays compact", () => {
  assert.match(style, /\.workspace \{[\s\S]*grid-template-rows: 28px minmax\(0, 1fr\)/);
  assert.match(style, /\.editor-topbar \{[\s\S]*min-height: 33px/);
  assert.match(style, /\.sidebar \{[\s\S]*inset: 28px auto 0 0/);
});
