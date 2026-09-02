import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const liveEditor = readFileSync(new URL("../src/LiveMarkdownEditor.tsx", import.meta.url), "utf8");
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

test("global search offers one-shot return navigation", () => {
  assert.match(app, /type GlobalSearchOrigin = \{/);
  assert.match(app, /const \[globalSearchOrigin, setGlobalSearchOrigin\]/);
  assert.match(app, /caretOffset: noteCaretOffsetsRef\.current\.get\(origin\.id\) \?\? 0/);
  assert.match(app, /const returnToGlobalSearchOrigin = async \(\) =>/);
  assert.match(app, /setGlobalSearchOrigin\(null\)/);
  assert.match(app, /setCaretRestoreVersion\(\(current\) => current \+ 1\)/);
  assert.match(app, /Back to previous location/);
});

test("background saves consume rejected promises and preserve retry state", () => {
  assert.match(app, /const persistCurrentInBackground = \(snapshot = noteRef\.current\) => \{[\s\S]*persistCurrent\(snapshot\)\.catch/);
  assert.match(app, /const removeFileAttachment = async[\s\S]*try \{[\s\S]*await persistCurrent\(\);[\s\S]*\} catch/);
  assert.match(app, /run: \(\) => persistCurrentInBackground\(\)/);
  assert.doesNotMatch(app, /void persistCurrent\(\);/);
});

test("note-level attachment insertion is visible beside the view tabs", () => {
  assert.match(app, /className="document-heading-toolbar"[\s\S]*className="view-tabs"[\s\S]*className="document-heading-actions"[\s\S]*Attach encrypted file…/);
  assert.match(app, /onClick=\{\(\) => void attachFile\(\)\}/);
  assert.match(style, /\.document-heading-toolbar \{[\s\S]*display: flex/);
  assert.match(style, /\.document-heading-actions \{[\s\S]*padding: 0 0 7px 8px/);
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
  assert.match(app, /titleCollapsed && <span className="collapsed-note-title">\{note\.title \|\| "Untitled"\}<\/span>/);
  assert.match(app, /document-heading-main[\s\S]*?view-tabs/);
  assert.match(app, /!titleCollapsed && \([\s\S]*?className="view-tabs"/);
  assert.match(style, /\.document-heading\.is-collapsed/);
  assert.match(app, /document-title-toggle disclosure-chevron/);
  assert.match(style, /\.disclosure-chevron::before,[\s\S]*transform: rotate\(-45deg\)/);
  assert.match(style, /\.disclosure-chevron\[aria-expanded="true"\]::before,[\s\S]*transform: rotate\(45deg\)/);
  assert.match(style, /\.document-heading\.is-collapsed \.document-heading-main \{[\s\S]*align-items: center/);
  assert.match(style, /\.collapsed-note-title \{[\s\S]*font-size: 14px[\s\S]*line-height: 32px/);
  assert.match(style, /\.document-heading:not\(\.is-collapsed\)/);
  assert.match(style, /\.document-heading-toolbar > \.view-tabs/);
  assert.match(style, /\.document-heading-toolbar \{[\s\S]*margin-top: 8px/);
  assert.match(style, /:root\[data-theme="archivist"\] \.document-heading-toolbar > \.view-tabs/);
  assert.match(style, /\.disclosure-chevron::before,[\s\S]*width: \.45em[\s\S]*height: \.45em[\s\S]*vertical-align: middle/);
});

test("editor chrome stays compact", () => {
  assert.match(style, /\.workspace \{[\s\S]*grid-template-rows: 28px minmax\(0, 1fr\)/);
  assert.match(style, /\.editor-topbar \{[\s\S]*min-height: 33px/);
  assert.match(style, /\.sidebar \{[\s\S]*inset: 28px auto 0 0/);
});

test("card panel keeps metadata compact and notes in the themed editor", () => {
  assert.match(app, /className="card-sidebar-title"/);
  assert.match(app, /Created At: \{new Date\(cardPanel\.metadata\.createdAt\)/);
  assert.match(app, /className="card-sidebar-properties"/);
  assert.match(app, /className="tag-multi-select card-status-picker"/);
  assert.match(app, /className="card-tags-editor"/);
  assert.match(app, /Add tag/);
  assert.match(app, /Remove tag \$\{tag\}/);
  assert.match(app, /className="card-sidebar-divider"/);
  assert.match(app, /className="card-sidebar-notes"[\s\S]*<LiveMarkdownEditor/);
  assert.match(style, /\.card-sidebar \{[\s\S]*background: var\(--editor-bg\)/);
  assert.match(style, /\.card-sidebar-notes \.live-markdown-editor \.cm-content/);
  assert.match(style, /\.card-tag-picker \.tag-multi-select-options input \{[\s\S]*width: 100% !important[\s\S]*height: 30px !important/);
});

test("embedded boards fill the usable editor line with equal columns", () => {
  assert.match(liveEditor, /cm-live-board-line/);
  assert.match(liveEditor, /:not\(\.cm-live-board-line\)/);
  assert.doesNotMatch(liveEditor, /rule\.style\.left/);
  assert.match(liveEditor, /cm-live-board-title[\s\S]*value = this\.title \|\| DEFAULT_BOARD_TITLE/);
  assert.match(liveEditor, /onChangeBoardTitle/);
  assert.match(liveEditor, /setData\(boardCardMime, card\.id\)/);
  assert.match(liveEditor, /drop\(event\)[\s\S]*includes\(boardCardMime\)/);
  assert.match(style, /--editor-content-left: 5%;[\s\S]*--editor-content-right: 15%;/);
  assert.match(style, /\.document-body \.live-markdown-editor:not\(.source-markdown-editor\) \.cm-line \{[\s\S]*width: 100%[\s\S]*max-width: none/);
  assert.match(style, /\.cm-live-board \{[\s\S]*width: 100%[\s\S]*margin: 18px 0/);
  assert.match(style, /\.cm-live-board-columns \{[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(style, /\.cm-journal-rule \{[\s\S]*left: var\(--editor-content-left\)[\s\S]*right: var\(--editor-content-right\)/);
  assert.match(style, /\.cm-line\.cm-live-board-line \{[\s\S]*position: relative[\s\S]*width: 100% !important[\s\S]*max-width: none[\s\S]*padding: 0 !important/);
  assert.match(style, /\.cm-selectionLayer \{[\s\S]*clip-path: inset\(0 var\(--editor-content-right\) 0 var\(--editor-content-left\)\)/);
});

test("board handles expose delete-only menus and block keyboard deletion", () => {
  assert.match(liveEditor, /if \(board\) \{[\s\S]*new DragHandleWidget\(lineNumber\)/);
  assert.match(liveEditor, /showObjectHandleMenu\([\s\S]*parseBoardMarker\(contextView\.state\.doc\.line\(sourceLine\)\.text\)/);
  assert.match(liveEditor, /if \(!board\) \{[\s\S]*textContent = "Duplicate"/);
  assert.match(liveEditor, /boardMarkerAtDeletionBoundary\(view\)/);
  assert.match(liveEditor, /key: "Delete"[\s\S]*run: handleBoardDelete/);
  assert.match(style, /cm-live-board-line:hover \.cm-live-object-handle/);
});
