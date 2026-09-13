import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const nativeMain = readFileSync(new URL("../../main.go", import.meta.url), "utf8");
const nativeService = readFileSync(new URL("../../internal/app/scratchpad_shortcut.go", import.meta.url), "utf8");
const scratchpad = readFileSync(new URL("../src/Scratchpad.tsx", import.meta.url), "utf8");
const liveEditor = readFileSync(new URL("../src/LiveMarkdownEditor.tsx", import.meta.url), "utf8");
const style = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

test("scratchpad is a fixed rightmost tab with normal-tab-only shortcuts", () => {
  assert.match(app, /import Scratchpad from "\.\/Scratchpad"/);
  assert.match(app, /const \[scratchpadActive, setScratchpadActive\] = useState\(false\)/);
  assert.match(app, /const scratchpadActiveRef = useRef\(scratchpadActive\)/);
  assert.match(app, /role="tab"[\s\S]*className=\{`note-tab scratchpad-tab/);
  assert.match(app, /className=\{`note-tab scratchpad-tab[\s\S]*<span>Scratchpad<\/span>/);
  assert.match(app, /className="new-note-tab"[\s\S]*className=\{`note-tab scratchpad-tab/);
  assert.match(app, /if \(session\?\.locked \|\| event\.shiftKey \|\| event\.metaKey\) return;/);
  assert.match(app, /title=\{`Open Scratchpad \(\$\{scratchpadShortcut\}\)`\}/);
  assert.doesNotMatch(app, /window\.addEventListener\("keydown", handleScratchpadShortcut, true\)/);
  assert.doesNotMatch(app, /scratchpad-tab[\s\S]*Close Scratchpad/);
  assert.match(app, /if \(scratchpadActiveRef\.current\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*return;/);
  assert.match(app, /const shortcut = formatShortcut\(shortcutFromEvent\(event\) \?\? ""\);/);
  assert.match(app, /scratchpadActiveRef\.current && shortcut === formatShortcut\(shortcutMap\["save-note"\]\)/);
});

test("scratchpad overlay and backend state are generation fenced", () => {
  assert.match(main, /new URLSearchParams\(window\.location\.search\)\.get\('window'\) === 'scratchpad'/);
  assert.match(main, /<Scratchpad overlay \/>/);
  assert.match(main, /dataset\.window = 'scratchpad'/);
  assert.match(scratchpad, /Events\.On\("cipherleaf:scratchpad-changed"/);
  assert.match(scratchpad, /Events\.On\("cipherleaf:scratchpad-cleared"/);
  assert.match(scratchpad, /VaultService\.GetScratchpad\(\)/);
  assert.match(scratchpad, /VaultService\.SaveScratchpad\(content, caretOffset, generation\)/);
  assert.match(scratchpad, /next\.generation < current\.generation/);
  assert.match(scratchpad, /next\.revision < current\.revision/);
  assert.match(scratchpad, /key=\{editorGeneration\}/);
  assert.match(scratchpad, /noteID=\{`scratchpad:\$\{editorGeneration\}`\}/);
  assert.match(scratchpad, /aria-label="Hide scratchpad"/);
  assert.match(scratchpad, /Window\.Hide\(\)/);
});

test("scratchpad Escape closes its host without stealing dialog Escape", () => {
  assert.match(scratchpad, /readonly onClose\?: \(\) => void;/);
  const escapeEffect = scratchpad.match(/  useEffect\(\(\) => \{\n    const handleEscape = \(event: KeyboardEvent\) => \{[\s\S]*?  \}, \[hideOverlay, onClose, overlay\]\);\n/);
  assert.ok(escapeEffect);
  assert.match(escapeEffect[0], /event\.key !== "Escape" \|\| event\.defaultPrevented \|\| event\.isComposing/);
  assert.match(escapeEffect[0], /event\.target instanceof Element && event\.target\.closest\("dialog, \[role=dialog\]"\)/);
  assert.match(escapeEffect[0], /event\.preventDefault\(\);/);
  assert.match(escapeEffect[0], /if \(overlay\) hideOverlay\(\);[\s\S]*else onClose\?\.\(\);/);
  assert.match(scratchpad, /VaultService\.HideScratchpad\(\)\.catch\(\(\) => Window\.Hide\(\)\)/);
  assert.match(escapeEffect[0], /window\.addEventListener\("keydown", handleEscape\);[\s\S]*window\.removeEventListener\("keydown", handleEscape\)/);
  const scratchpadRender = app.match(/  const renderScratchpadEditor = \(\) => \{[\s\S]*?\n  \};\n/);
  assert.ok(scratchpadRender);
  assert.match(scratchpadRender[0], /<Scratchpad[\s\S]*onClose=\{leaveScratchpad\}/);
});

test("scratchpad follows valid theme storage changes", () => {
  assert.match(main, /const SCRATCHPAD_THEME_KEY = 'cipherleaf-theme'/);
  assert.match(main, /function parseScratchpadTheme\(saved: string \| null\): 'light' \| 'dark' \| 'archivist' \| null/);
  assert.match(main, /saved === 'light' \|\| saved === 'dark' \|\| saved === 'archivist'/);
  assert.match(main, /const applyScratchpadTheme = \(saved: string \| null\) => \{[\s\S]*const theme = parseScratchpadTheme\(saved\)[\s\S]*if \(theme\) document\.documentElement\.dataset\.theme = theme/);
  assert.match(main, /const refreshScratchpadTheme = \(\) => applyScratchpadTheme\(window\.localStorage\.getItem\(SCRATCHPAD_THEME_KEY\)\)/);
  assert.match(main, /window\.addEventListener\('storage', \(event\) => \{[\s\S]*event\.key === SCRATCHPAD_THEME_KEY[\s\S]*applyScratchpadTheme\(event\.newValue\)/);
  assert.match(main, /window\.addEventListener\('focus', refreshScratchpadTheme\)[\s\S]*refreshScratchpadTheme\(\)/);
  assert.equal((main.match(/addEventListener\('storage'/g) ?? []).length, 1);
});

test("native shortcut routes through the focused window or guarded overlay", () => {
  assert.match(nativeMain, /Name:\s+"scratchpad"/);
  assert.match(nativeMain, /AlwaysOnTop:\s+true/);
  assert.match(nativeMain, /Frameless:\s+true/);
  assert.match(nativeMain, /BackgroundType:\s+application\.BackgroundTypeTranslucent/);
  assert.match(nativeMain, /Name:\s+"main"/);
  assert.match(nativeMain, /app\.Event\.OnApplicationEvent\(events\.Common\.ApplicationStarted, func\(\*application\.ApplicationEvent\) \{[\s\S]*vaultService\.InitializeScratchpadShortcut\(\)/);
  assert.doesNotMatch(nativeMain, /app\.GlobalShortcut\.Register/);
  assert.match(nativeMain, /if err := vaultService\.InitializeScratchpadShortcut\(\); err != nil \{[\s\S]*log\.Printf\("failed to register scratchpad global shortcut: %v", err\)/);
  const registrationIndex = nativeMain.indexOf("app.Event.OnApplicationEvent(events.Common.ApplicationStarted");
  const runIndex = nativeMain.indexOf("app.Run()");
  assert.ok(registrationIndex >= 0 && registrationIndex < runIndex);
  assert.match(nativeService, /mainWindow\.IsFocused\(\) && mainWindow\.IsVisible\(\)/);
  assert.match(nativeService, /if scratchpad\.IsVisible\(\)/);
  assert.match(nativeService, /s\.GetSession\(\)\.Locked/);
  assert.match(nativeService, /scratchpad\.Show\(\)/);
  assert.match(nativeService, /hideScratchpadWindow\(scratchpad\)/);
  assert.match(nativeService, /func positionScratchpad\(/);
  assert.match(nativeService, /screen\.Bounds\.X/);
  assert.match(nativeService, /screen\.Bounds\.Y/);
  assert.match(nativeService, /scratchpad\.SetPosition/);
  assert.match(nativeService, /mainWindow\.EmitEvent\("cipherleaf:scratchpad-focus"\)/);
  assert.doesNotMatch(nativeMain, /window\.RegisterKeyBinding/);
  assert.match(nativeMain, /log\.Printf\("failed to register scratchpad global shortcut/);
});

test("settings edits stay draft-only until Save and Exit", () => {
  assert.match(app, /const \[settingsDraft, setSettingsDraft\] = useState/);
  assert.match(app, /setSettingsDraft\(createSettingsDraft\(\)\)/);
  assert.match(app, /value=\{settingsValues\.dailyNoteFormat\}/);
  assert.match(app, /updateSettingsDraft\(\{ dailyNoteFormat: event\.target\.value \}\)/);
  assert.match(app, /await saveVaultSettings\(\{/);
  assert.match(app, /Save and Exit/);
  assert.match(app, /Exit without Saving/);
  assert.match(app, /onClick=\{closeAppearanceSettings\}/);
  assert.match(app, /close: closeAppearanceSettings/);
  assert.match(app, /setSettingsDraft\(null\)/);
});

test("Scratchpad shortcut capture persists from the command palette", () => {
  assert.match(app, /const DEFAULT_SCRATCHPAD_SHORTCUT = "Super\+`"/);
  assert.match(app, /VaultService\.GetScratchpadShortcut\(\)/);
  assert.match(app, /VaultService\.SetScratchpadShortcut\(shortcut\)/);
  assert.match(app, /event\.code/);
  assert.match(app, /event\.repeat/);
  assert.match(app, /event\.nativeEvent\?\.isComposing/);
  assert.match(app, /if \(event\.code === "NumpadAdd"\) return null;/);
  assert.match(app, /if \(event\.key === "\+"\) return "plus";/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /id: "scratchpad"/);
  assert.match(app, /handleCommandPaletteShortcutCapture/);
  assert.doesNotMatch(app, /id="settings-shortcuts"/);
  assert.doesNotMatch(app, /openSettingsSection\("appearance", "settings-shortcuts"\)/);
});

test("scratchpad size follows the active screen and keeps its height", () => {
  assert.match(nativeService, /width := screen\.Bounds\.Width \* 4 \/ 5/);
  assert.match(nativeService, /_, height := scratchpad\.Size\(\)[\s\S]*if height <= 0 \{[\s\S]*height = 600/);
  assert.match(nativeService, /scratchpad\.SetSize\(width, height\)/);
  assert.match(nativeService, /scratchpad\.SetPosition\(screen\.Bounds\.X\+\(screen\.Bounds\.Width-width\)\/2, screen\.Bounds\.Y\)/);
});

test("scratchpad focus effect handles native focus and cleanup", () => {
  const effectSource = app.match(/  useEffect\(\(\) => \{\n    const off = Events\.On\("cipherleaf:scratchpad-focus",[\s\S]*?  \}, \[\]\);\n/);
  assert.ok(effectSource);
  const effect = transpileModule(effectSource[0], {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 },
  }).outputText;
  let actionCalls = 0;
  let nativeFocus: (() => void) | null = null;
  let eventsOff = 0;
  let cleanup: (() => void) | undefined;
  const unlockedRef = { current: true };
  const activateScratchpadRef = { current: () => { actionCalls += 1; } };
  const useEffect = (callback: () => () => void) => { cleanup = callback(); };
  const Events = {
    On: (name: string, callback: () => void) => {
      assert.equal(name, "cipherleaf:scratchpad-focus");
      nativeFocus = callback;
      return () => {
        eventsOff += 1;
        nativeFocus = null;
      };
    },
  };
  new Function("useEffect", "Events", "unlockedRef", "activateScratchpadRef", effect)(
    useEffect,
    Events,
    unlockedRef,
    activateScratchpadRef,
  );
  nativeFocus?.();
  assert.equal(actionCalls, 1);
  unlockedRef.current = false;
  nativeFocus?.();
  assert.equal(actionCalls, 1);
  unlockedRef.current = true;
  nativeFocus?.();
  assert.equal(actionCalls, 2);
  cleanup?.();
  assert.equal(eventsOff, 1);
  assert.equal(nativeFocus, null);
});

test("scratchpad activation saves once and focuses an active editor", () => {
  const functionSource = app.match(/  const activateScratchpad = \(\) => \{[\s\S]*?\n  \};\n/);
  assert.ok(functionSource);
  const functionBody = transpileModule(functionSource[0], {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 },
  }).outputText;
  const dom = new JSDOM("<!doctype html><html><body><div class='scratchpad-editor'><div class='cm-content' contenteditable='true'></div></div></body></html>");
  const scratchpadActiveRef = { current: false };
  const unlockedRef = { current: true };
  let saves = 0;
  const activateScratchpad = new Function(
    "saveCurrentDraft",
    "setGraphOpen",
    "setTimeTrackingOpen",
    "setConflictResolution",
    "setSidebarOpen",
    "scratchpadActiveRef",
    "setScratchpadActive",
    "unlockedRef",
    "document",
    "HTMLElement",
    `${functionBody}\nreturn activateScratchpad;`,
  )(
    () => { saves += 1; },
    () => {},
    () => {},
    () => {},
    () => {},
    scratchpadActiveRef,
    (active: boolean) => { scratchpadActiveRef.current = active; },
    unlockedRef,
    dom.window.document,
    dom.window.HTMLElement,
  ) as () => void;
  activateScratchpad();
  assert.equal(saves, 1);
  activateScratchpad();
  assert.equal(saves, 1);
  assert.equal(dom.window.document.activeElement?.className, "cm-content");
  dom.window.close();
});

test("scratchpad editor saves content and caret from the same local update", () => {
  assert.match(liveEditor, /readonly onChangeWithCaret\?: \(value: string, caretOffset: number\) => void;/);
  assert.match(liveEditor, /const onChangeWithCaretRef = useRef\(onChangeWithCaret\)/);
  assert.match(liveEditor, /onChangeWithCaretRef\.current = onChangeWithCaret/);
  assert.match(liveEditor, /\[onChange, onChangeWithCaret, onSave,/);

  const listenerSource = liveEditor.match(/          EditorView\.updateListener\.of\(\(update\) => \{[\s\S]*?\n          \}\),/);
  assert.ok(listenerSource);
  const listener = listenerSource[0];
  assert.match(listener, /const externalUpdate = update\.transactions\.some\(\(transaction\) =>[\s\S]*transaction\.annotation\(externalDocumentUpdate\)/);
  assert.match(listener, /const suppressExternalCaret = externalUpdate && Boolean\(onChangeWithCaretRef\.current\)/);
  assert.match(listener, /if \(!externalUpdate && update\.docChanged\) \{[\s\S]*const content = update\.state\.doc\.toString\(\);[\s\S]*const caretOffset = update\.state\.selection\.main\.head;[\s\S]*onChangeWithCaretRef\.current\(content, caretOffset\);/);
  assert.match(listener, /else \{[\s\S]*onChangeRef\.current\(content\);[\s\S]*onCaretChangeRef\.current\?\.\(caretOffset\);/);
  assert.match(listener, /else if \(\(update\.selectionSet \|\| update\.docChanged\) && !suppressExternalCaret\) \{[\s\S]*onCaretChangeRef\.current\?\.\(update\.state\.selection\.main\.head\);/);

  const contentUpdateSource = scratchpad.match(/  const updateContent = \(content: string, generation: number, caretOffset = stateRef\.current\.caretOffset\) => \{[\s\S]*?\n  \};\n/);
  assert.ok(contentUpdateSource);
  assert.match(contentUpdateSource[0], /const normalizedCaretOffset = Math\.max\(0, Math\.min\(Math\.floor\(caretOffset\), content\.length\)\)/);
  assert.match(contentUpdateSource[0], /const next = \{ \.\.\.current, content, caretOffset: normalizedCaretOffset \}/);
  assert.match(contentUpdateSource[0], /saveScratchpad\(content, normalizedCaretOffset, generation, localChange\)/);
  assert.equal((contentUpdateSource[0].match(/saveScratchpad\(/g) ?? []).length, 1);
  assert.match(scratchpad, /onChangeWithCaret=\{\(content, caretOffset\) => updateContent\(content, editorGeneration, caretOffset\)\}/);
  assert.doesNotMatch(scratchpad, /caretRestoreVersion\s*=/);

  const caretUpdateSource = scratchpad.match(/  const updateCaret = \(caretOffset: number, generation: number\) => \{[\s\S]*?\n  \};\n/);
  assert.ok(caretUpdateSource);
  assert.match(caretUpdateSource[0], /const normalizedCaretOffset = Math\.max\(0, Math\.floor\(caretOffset\)\);[\s\S]*if \(normalizedCaretOffset === current\.caretOffset\) return;[\s\S]*const localChange/);
});

test("scratchpad styling stays accessible, responsive, translucent, and reduced-motion safe", () => {
  assert.match(style, /\.scratchpad-tab \{/);
  assert.match(style, /\.scratchpad-tab span \{[\s\S]*font-size: 1em/);
  assert.match(style, /\.scratchpad-tab\.active \{/);
  assert.match(style, /:root\[data-theme="dark"\] \.scratchpad-tab \{[\s\S]*color: var\(--ink\)[\s\S]*background: var\(--surface\)/);
  assert.match(style, /:root\[data-theme="dark"\] \.scratchpad-tab\.active \{[\s\S]*border-color: var\(--green-dark\)[\s\S]*background: var\(--surface-active\)/);
  assert.match(style, /\.scratchpad-tab:focus-visible \{/);
  assert.match(style, /:root\[data-window="scratchpad"\]/);
  assert.match(style, /--scratchpad-opacity: 0\.5/);
  assert.match(style, /:root\[data-window="scratchpad"\] #root \{[\s\S]*height: 100%[\s\S]*display: flex[\s\S]*flex-direction: column[\s\S]*overflow: hidden/);
  assert.match(style, /\.scratchpad-overlay-shell \{[\s\S]*background: color-mix\(in srgb, var\(--canvas\) calc\(var\(--scratchpad-opacity, 0\.5\) \* 100%\), transparent\)/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.editor-shell\.scratchpad-overlay-shell \{[\s\S]*background: color-mix\(in srgb, var\(--canvas\) calc\(var\(--scratchpad-opacity, 0\.5\) \* 100%\), transparent\)/);
  assert.match(style, /\.scratchpad-heading \{[\s\S]*flex: 0 0 auto/);
  assert.match(style, /\.scratchpad-editor-body \{[\s\S]*min-height: 0[\s\S]*overflow: hidden/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.document-body,[\s\S]*\.live-editor-frame \{[\s\S]*background: transparent/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.markdown-toolbar \{[\s\S]*background: transparent/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \{[\s\S]*--editor-bg: transparent[\s\S]*--toolbar-bg: transparent/);
  assert.doesNotMatch(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \{\s*--ink:/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \{[\s\S]*--scratchpad-outline: rgb\(255 255 255 \/ 88%\)[\s\S]*text-shadow:[\s\S]*1px 0 var\(--scratchpad-outline\)[\s\S]*-1px 0 var\(--scratchpad-outline\)[\s\S]*0 1px var\(--scratchpad-outline\)[\s\S]*0 -1px var\(--scratchpad-outline\)/);
  assert.match(style, /:root\[data-theme="dark"\]\[data-window="scratchpad"\] \.scratchpad-overlay-shell \{[\s\S]*--scratchpad-outline: rgb\(0 0 0 \/ 88%\)/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.scratchpad-heading h1,[\s\S]*\.live-markdown-editor \.cm-content \{[\s\S]*font-weight: 500/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.markdown-toolbar button,[\s\S]*\.scratchpad-close \{[\s\S]*color: var\(--ink\)[\s\S]*text-shadow: inherit/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.toolbar-checkbox,[\s\S]*\.toolbar-toggle \{[\s\S]*filter: drop-shadow\(0 0 1px var\(--scratchpad-outline\)\)/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.toolbar-toggle \{[\s\S]*color: var\(--ink\)/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.markdown-toolbar button:hover \{[\s\S]*color: var\(--green-dark\)/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.markdown-toolbar button:hover \.toolbar-toggle \{[\s\S]*color: var\(--green-dark\)/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell button:focus-visible \{[\s\S]*outline: 2px solid var\(--ink\)[\s\S]*box-shadow: 0 0 0 1px var\(--scratchpad-outline\)/);
  assert.match(style, /:root\[data-window="scratchpad"\] \.scratchpad-overlay-shell \.live-markdown-editor \.cm-cursor \{[\s\S]*border-left: 2px solid var\(--ink\)[\s\S]*filter: drop-shadow\(0 0 1px var\(--scratchpad-outline\)\)/);
  assert.match(style, /\.scratchpad-overlay-shell \* \{[\s\S]*--wails-draggable: no-drag/);
  assert.match(style, /@media \(max-width: 600px\)[\s\S]*\.scratchpad-overlay-shell/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.scratchpad-overlay-shell/);
});

test("scratchpad opacity is configurable and shared with the overlay window", () => {
  assert.match(app, /const SCRATCHPAD_OPACITY_KEY = "cipherleaf-scratchpad-opacity"/);
  assert.match(app, /const \[scratchpadOpacity, setScratchpadOpacity\] = useState\(\(\) => readScratchpadOpacity\(\)\)/);
  assert.match(app, /saved === null \|\| saved\.trim\(\) === ""/);
  assert.match(app, /Number\(saved\)/);
  assert.match(app, /Number\.isFinite\(opacity\) && opacity >= 0 && opacity <= 1/);
  assert.match(app, /setProperty\("--scratchpad-opacity", String\(scratchpadOpacity\)\)/);
  assert.match(app, /setItem\(SCRATCHPAD_OPACITY_KEY, String\(scratchpadOpacity\)\)/);
  assert.match(app, /openSettingsSection\("appearance", "settings-scratchpad-opacity"\)/);
  assert.match(app, /id="settings-scratchpad-opacity"/);
  assert.match(app, /type="range"[\s\S]*min="0"[\s\S]*max="1"[\s\S]*step="0\.05"[\s\S]*scratchpadOpacity/);
  assert.match(app, /Math\.min\(1, Math\.max\(0, value\)\)/);
  assert.match(app, /Math\.round\(settingsValues\.scratchpadOpacity \* 100\)\}%/);
  assert.match(main, /const SCRATCHPAD_OPACITY_KEY = 'cipherleaf-scratchpad-opacity'/);
  assert.match(main, /saved === null \|\| saved\.trim\(\) === ''/);
  assert.match(main, /Number\.isFinite\(opacity\) && opacity >= 0 && opacity <= 1/);
  assert.match(main, /setProperty\('--scratchpad-opacity', String\(parseScratchpadOpacity\(saved\)\)\)/);
  assert.match(main, /addEventListener\('storage'/);
  assert.match(main, /event\.key === SCRATCHPAD_OPACITY_KEY/);
  assert.match(main, /setScratchpadOpacity\(event\.newValue\)/);
  assert.match(nativeMain, /BackgroundColour: application\.NewRGBA\(0, 0, 0, 0\)/);
});

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

test("automatic sync runs on a fixed interval instead of activity reset", () => {
  const effect = app.match(/  useEffect\(\(\) => \{\n    if \(!session \|\| session\.locked \|\| !syncLinked\) return;[\s\S]*?\n  \}, \[autoSyncMinutes, session\?\.vaultId, session\?\.locked, syncLinked\]\);/);
  assert.ok(effect);
  assert.match(effect[0], /window\.setInterval\(\(\) => void autoSyncVaultRef\.current\(\), delay\)/);
  assert.match(effect[0], /window\.clearInterval\(interval\)/);
  assert.doesNotMatch(effect[0], /pointerdown|keydown|mousemove|touchstart/);
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
  assert.match(style, /\.disclosure-chevron::before,[\s\S]*width: \.45em[\s\S]*height: \.45em/);
});

test("editor chrome stays compact", () => {
  assert.match(style, /\.workspace \{[\s\S]*grid-template-rows: 28px minmax\(0, 1fr\)/);
  assert.match(style, /\.editor-topbar \{[\s\S]*min-height: 33px/);
  assert.match(style, /\.sidebar \{[\s\S]*inset: 28px auto 0 0/);
});

test("workspace UI keeps rendered code lines content-sized", () => {
  assert.match(style, /:root \.document-body \.live-markdown-editor:not\(.source-markdown-editor\) \.cm-line\.cm-live-code-block \{[\s\S]*width: auto;/);
});

test("live marker lines break unbroken content beside their marker", () => {
  assert.match(style, /\.live-markdown-editor \.cm-live-unbroken-line \{[\s\S]*word-break: break-all;/);
  assert.match(liveEditor, /const content = line\.slice\(offset\)\.trim\(\)/);
  assert.match(liveEditor, /hasUnbrokenObjectContent\(line\.text, toggle\.object\.sourcePrefix\.length\)/);
  assert.match(liveEditor, /hasUnbrokenObjectContent\(line\.text, object\.sourcePrefix\.length\)/);
  assert.match(liveEditor, /cm-live-unbroken-line/);
  assert.match(style, /\.cm-live-list-symbol \{[\s\S]*vertical-align: middle;/);
  assert.match(style, /\.cm-live-list-marker \{[\s\S]*vertical-align: middle;/);
  assert.match(liveEditor, /\.cm-live-toggle-button[\s\S]*verticalAlign: "middle"/);
});

test("card panel keeps metadata compact and notes in the themed editor", () => {
  assert.match(app, /className="card-sidebar-title"/);
  assert.match(app, /Created At: \{localDateKey\(new Date\(cardPanel\.metadata\.createdAt\)\)\}/);
  assert.match(app, /className="card-sidebar-properties"/);
  assert.match(app, /className="tag-multi-select card-status-picker"/);
  assert.match(app, /className="card-tags-editor"/);
  assert.match(app, /Add tag/);
  assert.match(app, /Remove tag \$\{tag\}/);
  assert.match(app, /className="card-sidebar-divider"/);
  assert.match(app, /className="card-sidebar-notes"[\s\S]*<LiveMarkdownEditor/);
  assert.match(app, /\}, \[cardPanel\?\.metadata, cardPanel\?\.note\.id, notes\]\);/);
  assert.match(app, /const deleteCard = async/);
  assert.match(app, /Delete card/);
  assert.match(app, /cardPanelDirty \? "primary-button is-dirty" : "secondary-button"/);
  assert.match(app, /const saveOnShortcut = \(event: KeyboardEvent\) => \{[\s\S]*event\.key\.toLowerCase\(\) !== "s"/);
  assert.match(app, /window\.addEventListener\("keydown", saveOnShortcut\)/);
  assert.doesNotMatch(app, /cardSignature/);
  assert.match(app, /key=\{`\$\{note\.id\}:\$\{sectionDefault\}`\}/);
  assert.match(liveEditor, /key: "Mod-s"[\s\S]*onSaveRef\.current\(\)/);
  assert.match(liveEditor, /cm-live-board-card-title/);
  assert.match(liveEditor, /cm-live-board-card-date/);
  assert.match(liveEditor, /cm-live-board-toggle/);
  assert.match(liveEditor, /\[BOARD\] \$\{boardTitle\}/);
  assert.match(liveEditor, /boardColumnsForMarker\(board, options\.cards\(\)\)/);
  assert.match(liveEditor, /allCards\.get\(column\.id\)/);
  assert.match(liveEditor, /cm-live-board-card-tags/);
  assert.match(liveEditor, /normalizeCardTags\(this\.columns\.flatMap/);
  assert.match(liveEditor, /document\.createElement\("select"\)/);
  assert.match(style, /\.card-sidebar \{[\s\S]*background: var\(--editor-bg\)/);
  assert.match(style, /\.card-sidebar-notes \.live-markdown-editor \.cm-content/);
  assert.match(liveEditor, /cm-live-empty-line/);
  assert.match(style, /\.live-markdown-editor \.cm-line\.cm-live-empty-line \{[\s\S]*height: 1lh;[\s\S]*max-height: 1lh/);
  assert.match(style, /\.cm-live-board-card \{[\s\S]*display: flex[\s\S]*justify-content: space-between/);
  assert.match(style, /\.cm-live-board-card-date \{[\s\S]*text-align: right/);
  assert.match(style, /\.cm-live-board-header \.cm-live-board-title \{[\s\S]*flex: 1 1 auto/);
  assert.match(style, /\.cm-live-board-controls select \{ min-width: 0; flex: 1; \}/);
  assert.match(style, /\.cm-live-board-minimized \{[\s\S]*flex: 1 1 auto/);
  assert.match(style, /\.cm-live-board \[hidden\] \{[\s\S]*display: none !important/);
  assert.match(style, /\.card-save-button\.is-dirty \{[\s\S]*background: #1e73b5/);
  assert.match(style, /\.card-tag-picker \.tag-multi-select-options input \{[\s\S]*width: 100% !important[\s\S]*height: 30px !important/);
});

test("card saving is opt-in for editor journaling and keeps the panel open", () => {
  assert.match(app, /const \[cardWriteChangesToEditorDefault, setCardWriteChangesToEditorDefault\] = useState\(false\)/);
  assert.match(app, /aria-label="Write changes to editor"/);
  assert.match(app, /checked=\{cardPanel\.metadata\.writeChangesToEditor\}/);
  assert.match(app, /const journaledMain = cardPanel\.metadata\.writeChangesToEditor && mainContent/);
  assert.match(app, /cipherleaf-card-write-changes-to-editor/);
  assert.match(app, /Write changes to editor by default/);
  assert.match(app, /cardWriteChangesToEditorDefault/);
  assert.match(app, /const closeCardPanel = async \(force = false, preserveTemplateRequest = false\) => \{[\s\S]*!force && cardPanelDirty && !\(await requestAppConfirm/);
  assert.match(app, /message: "This card has unsaved changes\. Close it without saving\?"/);
  assert.doesNotMatch(app, /boardTemplatePanel/);
  assert.match(app, /kind\?: "template"/);
  assert.match(app, /cardPanel\.kind === "template"/);
  assert.match(app, /cardPanelRef\.current !== panelAtStart/);
  assert.match(app, /const templateRequestRef = useRef\(0\)/);
  assert.match(app, /closeCardPanel\(false, true\)/);
  assert.match(app, /openTemplateCard/);
  assert.match(app, /openTemplateCard\(saved\.note, draft, true, request\)/);
  assert.match(app, /runSerializedSave\(\(\) => VaultService\.SaveNote\(cardPanel\.note\.id/);
  assert.match(app, /serializeTemplateDocument\(template\)/);
  assert.match(app, /options: \{ \.\.\.marker\.options!?[,}] templateID: undefined \}/);
  assert.match(app, /newCardMetadata\(created\.id, new Date\(created\.createdAt\), template\?\.writeChangesToEditor \?\? false\)/);
  assert.match(app, /setSelectedTemplateID\(template\?\.id \?\? \"\"\)/);
  assert.match(app, /writeChangesToEditor: parsed\.template\.writeChangesToEditor/);
  assert.match(app, /writeChangesToEditor: metadata\.writeChangesToEditor/);
  assert.match(app, /VaultService\.SaveNote\(template\.id, template\.title, serializeTemplateDocument\(draft\)\)/);
  assert.doesNotMatch(app, /const saveCardPanel = async \(\) => \{[\s\S]*?\n  \} catch[\s\S]*await closeCardPanel\(true\);/);
  assert.match(app, /onClick=\{\(\) => void closeCardPanel\(\)\}/);
  assert.match(app, /if \(event\.key === "Escape"\) \{[\s\S]*void closeCardPanel\(\);/);
  assert.match(app, /window\.addEventListener\("keydown", closeOnEscape\)/);
  assert.match(app, /target\.closest\("\.editor-shell"\)[\s\S]*void closeCardPanel\(\);/);
  assert.match(style, /\.card-sidebar \.card-editor-journal-toggle \{[^}]*width: fit-content;[^}]*max-width: 100%;[^}]*align-self: flex-start;[^}]*flex-direction: row;[^}]*align-items: center;[^}]*gap: \.4em/);
  assert.match(style, /\.card-sidebar \.card-editor-journal-toggle input\[type="checkbox"\] \{[^}]*width: 1em;[^}]*height: 1em;[^}]*min-height: 0;[^}]*flex: 0 0 1em;[^}]*margin: 0;[^}]*padding: 0;[^}]*accent-color: var\(--green-dark\)/);
});

test("card editor setting keeps its checkbox inline and compact", () => {
  const dom = new JSDOM(`<style>${style}</style><dialog class="vault-modal settings-modal"><fieldset id="settings-card-editor-default"><label><input type="checkbox">Write changes to editor by default</label></fieldset></dialog>`);
  const label = dom.window.getComputedStyle(dom.window.document.querySelector("label")!);
  const input = dom.window.getComputedStyle(dom.window.document.querySelector("input")!);
  assert.equal(label.display, "flex");
  assert.equal(label.alignItems, "center");
  assert.equal(input.width, "15px");
  assert.equal(input.height, "15px");
  assert.equal(input.padding, "0px");
});

test("cards keep folder access and stay out of folder note pages", () => {
  assert.match(app, /const targetFolder = noteRef\.current\?\.folderId \?\? \(selectedFolderID === "all" \? "" : selectedFolderID\);/);
  assert.match(app, /VaultService\.CreateNoteInFolder\("Untitled", targetFolder\)/);
  assert.match(app, /sortNotesForFolder\(\s*publicNotes\.filter\(\(item\) => item\.folderId === selectedFolderID\)/);
});

test("live preview updates only safe local edits", () => {
  assert.match(liveEditor, /function singleLineChange\(transaction: Transaction\)/);
  assert.match(liveEditor, /transaction\.changes\.iterChangedRanges/);
  assert.match(liveEditor, /function incrementalPreviewState\(/);
  assert.match(liveEditor, /set\s*\.map\(transaction\.changes\)/);
  assert.match(liveEditor, /cachedObjectDocument\(view\.state\)\.objects\.filter/);
  assert.match(liveEditor, /const incremental = incrementalPreviewState\(/);
});

test("board widget equality compares card IDs without serialization", () => {
  assert.match(liveEditor, /other\.cardIDs\.length !== this\.cardIDs\.length/);
  assert.match(liveEditor, /other\.cardIDs\[index\] !== this\.cardIDs\[index\]/);
  assert.match(liveEditor, /updateDOM\(dom: HTMLElement, _view: EditorView, from: BoardWidget\)/);
  assert.match(liveEditor, /boardCardPresentationChanged\(previous, card\)/);
  assert.doesNotMatch(liveEditor, /JSON\.stringify\(other\.cardIDs\)/);
});

test("embedded boards fill the usable editor line with equal columns", () => {
  assert.match(liveEditor, /cm-live-board-line/);
  assert.match(liveEditor, /:not\(\.cm-live-board-line\)/);
  assert.doesNotMatch(liveEditor, /rule\.style\.left/);
  assert.match(liveEditor, /cm-live-board-title[\s\S]*value = this\.title \|\| DEFAULT_BOARD_TITLE/);
  assert.match(liveEditor, /onChangeBoardTitle/);
  assert.match(liveEditor, /Add column/);
  assert.match(liveEditor, /Column name/);
  assert.match(liveEditor, /Column color/);
  assert.match(liveEditor, /Move column before/);
  assert.match(liveEditor, /Move column after/);
  assert.match(liveEditor, /Remove column/);
  assert.match(liveEditor, /item\.addEventListener\("pointerdown"/);
  assert.match(liveEditor, /document\.addEventListener\("pointermove", move\)/);
  assert.match(liveEditor, /targetColumn\?\.classList\.add\("is-drop-target"\)/);
  assert.match(liveEditor, /is-drag-preview/);
  assert.match(style, /--editor-content-left: 5%;[\s\S]*--editor-content-right: 5%;/);
  assert.match(style, /\.document-body \.live-markdown-editor:not\(.source-markdown-editor\) \.cm-line \{[\s\S]*width: 100%[\s\S]*max-width: none/);
  assert.match(style, /\.cm-live-board \{[\s\S]*width: 100%[\s\S]*margin: 6px 0/);
  assert.match(style, /\.cm-live-board-columns \{[\s\S]*repeat\(auto-fit, minmax\(180px, 1fr\)\)/);
  assert.match(style, /\.cm-live-board-column-header \{[\s\S]*cursor: grab/);
  assert.match(style, /\.cm-live-board-column \{[\s\S]*background: color-mix\(in srgb, var\(--board-column-color/);
  assert.doesNotMatch(style, /\.cm-live-board-column\.status-(?:in-progress|blocked|finished) \{ background:/);
  assert.match(style, /\.cm-live-board-column\.is-column-drop-before/);
  assert.match(style, /\.cm-live-board-column\.is-column-drop-after/);
  assert.match(style, /\.cm-live-board-card\.is-dragging \{[\s\S]*cursor: grabbing/);
  assert.match(style, /\.cm-live-board-card\.is-drag-preview \{[\s\S]*border-style: dashed/);
  assert.match(style, /\.cm-journal-rules \{[\s\S]*inset: 0 var\(--editor-content-right\) 0 var\(--editor-content-left\)/);
  assert.match(style, /\.cm-journal-rule \{[\s\S]*left: 0[\s\S]*right: 0/);
  assert.match(style, /\.card-sidebar-notes \.cm-journal-rules \{[\s\S]*inset: 0/);
  assert.match(style, /\.cm-line\.cm-live-board-line \{[\s\S]*position: relative[\s\S]*width: 100% !important[\s\S]*max-width: none[\s\S]*padding: 0 !important/);
  assert.match(style, /\.cm-selectionLayer \{[\s\S]*clip-path: inset\(0 var\(--editor-content-right\) 0 var\(--editor-content-left\)\)/);
});

test("board card creation keeps the selected source marker stable", () => {
  assert.match(app, /const sourceNoteID = current\.id/);
  assert.match(app, /const latestSource = noteRef\.current\?\.id === sourceNoteID \? markdownForEditing\(noteRef\.current\.content\) : null/);
  assert.match(app, /if \(!latestSource \|\| !latestBoard\) \{[\s\S]*VaultService\.DeleteNote\(created\.id\)/);
  assert.match(app, /replaceBoardMarker\(latestSource, boardID/);
  assert.match(app, /new Set\(\[\.\.\.column\.cardIDs, created\.id\]\)/);
  const addCardSource = app.slice(app.indexOf("const addCardToBoard"), app.indexOf("const changeBoardTitle"));
  assert.doesNotMatch(addCardSource, /replaceBoardMarker\(source, boardID/);
});

test("board handles expose delete-only menus and block keyboard deletion", () => {
  assert.match(liveEditor, /if \(board\) \{[\s\S]*new DragHandleWidget\(lineNumber\)/);
  assert.match(liveEditor, /showObjectHandleMenu\([\s\S]*parseBoardMarker\(contextView\.state\.doc\.line\(sourceLine\)\.text\)/);
  assert.match(liveEditor, /if \(!board\) \{[\s\S]*textContent = "Duplicate"/);
  assert.match(liveEditor, /view\.state\.selection\.ranges\.flatMap/);
  assert.match(liveEditor, /deletionChangesBoardMarkers\(view\.state, changes\)/);
  assert.match(liveEditor, /key: "Delete"[\s\S]*run: handleBoardDelete/);
  assert.match(style, /cm-live-board-line:hover \.cm-live-object-handle/);
});
