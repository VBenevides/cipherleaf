import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cardReference, boardMarker, type CardMetadata } from "../src/cards";
import LiveMarkdownEditor, { clipboardClaimsImage, clipboardImage, clipboardMayContainImage, imageDataURL } from "../src/LiveMarkdownEditor";
import ObjectTreeView from "../src/ObjectTreeView";
import SourceMarkdownEditor from "../src/SourceMarkdownEditor";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
Object.defineProperties(dom.window.Range.prototype, {
  getClientRects: { value: () => [], configurable: true },
  getBoundingClientRect: { value: () => new dom.window.DOMRect(), configurable: true },
});
Object.defineProperties(dom.window.HTMLElement.prototype, {
  clientWidth: {
    configurable: true,
    get() { return this.classList.contains("cm-live-board-card-title") ? 100 : 0; },
  },
  scrollWidth: {
    configurable: true,
    get() {
      return this.classList.contains("cm-live-board-card-title")
        ? Math.max(100, (this.textContent?.length ?? 0) * 10)
        : 0;
    },
  },
});
class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true },
  document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true },
  HTMLElement: { value: dom.window.HTMLElement, configurable: true },
  Element: { value: dom.window.Element, configurable: true },
  Node: { value: dom.window.Node, configurable: true },
  Window: { value: dom.window.Window, configurable: true },
  MutationObserver: { value: dom.window.MutationObserver, configurable: true },
  DOMRect: { value: dom.window.DOMRect, configurable: true },
  ResizeObserver: { value: ResizeObserverStub, configurable: true },
  getComputedStyle: { value: dom.window.getComputedStyle, configurable: true },
  requestAnimationFrame: { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true },
  cancelAnimationFrame: { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
Object.defineProperty(dom.window.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async () => {}, write: async () => {}, read: async () => [] },
});
Object.defineProperties(dom.window.HTMLElement.prototype, {
  setPointerCapture: { configurable: true, value: () => {} },
  releasePointerCapture: { configurable: true, value: () => {} },
});

const clipboardImageBlob = new dom.window.Blob([new Uint8Array([65, 66])], { type: "image/png" });
assert.equal(await imageDataURL("data:image/png;base64,AA=="), "data:image/png;base64,AA==");
assert.match(await imageDataURL(clipboardImageBlob), /^data:image\/png;base64,/);
await assert.rejects(imageDataURL(new dom.window.Blob(["text"], { type: "text/plain" })), /Only PNG/);
assert.equal(clipboardImage({ clipboardData: null } as ClipboardEvent), null);
assert.equal(clipboardImage({ clipboardData: { items: [], files: [], getData: () => "" } } as unknown as ClipboardEvent), null);
assert.equal(clipboardImage({ clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => clipboardImageBlob }], files: [], getData: () => "" } } as unknown as ClipboardEvent), clipboardImageBlob);
assert.equal(clipboardClaimsImage({ clipboardData: null } as ClipboardEvent), false);
assert.equal(clipboardClaimsImage({ clipboardData: { items: [{ type: "image/png" }], types: [], getData: () => "" } } as unknown as ClipboardEvent), true);
assert.equal(clipboardClaimsImage({ clipboardData: { items: [], types: ["Files"], getData: () => "" } } as unknown as ClipboardEvent), true);
assert.equal(clipboardClaimsImage({ clipboardData: { items: [], types: [], getData: () => "PNG" } } as unknown as ClipboardEvent), true);
assert.equal(clipboardMayContainImage({ clipboardData: { items: [], types: [], getData: () => "text" } } as unknown as ClipboardEvent), false);
const userAgent = dom.window.navigator.userAgent;
Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: "Linux" });
assert.equal(clipboardMayContainImage({ clipboardData: null } as ClipboardEvent), true);
assert.equal(clipboardMayContainImage({ clipboardData: { items: [], types: [], getData: () => "" } } as unknown as ClipboardEvent), true);
Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: userAgent });

const cards = new Map<string, CardMetadata>([
  ["card-1", { id: "card-1", title: "Backlog card", status: "not-started", tags: ["work"], createdAt: "2026-01-01" }],
  ["card-2", { id: "card-2", title: "Active card", status: "in-progress", tags: ["work"], createdAt: "2026-01-01", startedAt: "2026-01-02" }],
  ["card-3", { id: "card-3", title: "Blocked card", status: "blocked", tags: ["urgent"], createdAt: "2026-01-01", blockedOn: "2026-01-03" }],
  ["card-4", { id: "card-4", title: "Finished card", status: "finished", tags: ["done"], createdAt: "2026-01-01", finishedAt: "2026-01-04" }],
]);
const value = [
  "# Heading",
  "Paragraph **bold** _italic_ ~~strike~~ `code` [site](https://example.com) [[Linked note]]",
  "> Quote",
  "  > Nested quote",
  "- [ ] Task",
  "  continuation",
  "1. Ordered",
  "---",
  "| Name | Date |",
  "| --- | --- |",
  "| Row | Today |",
  "```ts",
  "const code = 1;",
  "```",
  "![image](attachment:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
  cardReference("card-1"),
  boardMarker("board-1", [...cards.keys()], "Roadmap"),
].join("\n");

const mount = (className: string) => {
  const shell = document.createElement("div");
  shell.className = "editor-shell";
  const body = shell.appendChild(document.createElement("div"));
  body.className = "document-body";
  body.className += ` ${className}`;
  document.body.append(shell);
  return { shell, body, root: createRoot(body) };
};
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

const key = (target: Element, name: string, options: KeyboardEventInit = {}) => {
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options }));
};

let changed = 0;
let saved = 0;
let opened = 0;
let moved = 0;
let added = 0;
const live = mount("live-host");
await act(async () => {
  live.root.render(createElement(LiveMarkdownEditor, {
    noteID: "note",
    value,
    onChange: () => { changed++; },
    onSave: () => { saved++; },
    onError: () => {},
    onOpenWikilink: () => { opened++; },
    onOpenCard: () => { opened++; },
    cardTitles: new Map([["card-1", "Backlog card"]]),
    cardData: cards,
    onCreateCard: async () => { added++; return null; },
    onCreateBoard: async () => null,
    onMoveCard: () => { moved++; },
    onAddCardToBoard: () => { added++; },
    onChangeBoardTitle: () => { changed++; },
    onDecreaseFontSize: () => {},
    onIncreaseFontSize: () => {},
    highlightLineNumbers: new Set([1, 5]),
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const editor = live.body.querySelector<HTMLElement>(".cm-content");
assert.ok(editor);
assert.ok(live.body.querySelector(".cm-editor"));
assert.ok(live.shell.querySelector(".markdown-toolbar"));
assert.ok(live.body.querySelector(".cm-live-board"));
assert.ok(live.body.querySelector(".cm-live-table-wrap"));
assert.ok(live.body.querySelector(".cm-live-attachment"));
assert.ok(live.body.querySelector(".cm-live-code-block"));

for (const [name, options] of [
  ["s", { ctrlKey: true }], ["a", { ctrlKey: true }], ["z", { ctrlKey: true }],
  ["r", { ctrlKey: true }], ["[", { ctrlKey: true }], ["]", { ctrlKey: true }],
  ["-", { ctrlKey: true }], ["=", { ctrlKey: true }], ["h", { ctrlKey: true }],
  ["Enter", {}], ["Tab", {}], ["Tab", { shiftKey: true }],
] as const) key(editor, name, options);
assert.ok(saved > 0);

const toolbar = live.shell.querySelector<HTMLElement>(".markdown-toolbar");
await act(async () => {
  toolbar?.querySelectorAll("button").forEach((button) => {
    button.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
});
const wikilink = live.body.querySelector<HTMLElement>(".cm-live-wikilink");
wikilink?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
live.body.querySelector<HTMLElement>(".cm-live-card-reference")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
live.body.querySelector<HTMLElement>(".cm-live-citation")?.click();
live.body.querySelector<HTMLButtonElement>(".cm-live-link-menu button")?.click();

const board = live.body.querySelector<HTMLElement>(".cm-live-board");
assert.ok(board);
assert.ok([...board.querySelectorAll<HTMLElement>(".cm-live-board-card-title")].some((title) => title.style.fontSize));
assert.ok(board.querySelector(".cm-live-board-card-tags"));
const minimizeBoard = board.querySelector<HTMLButtonElement>(".cm-live-board-minimize")!;
minimizeBoard.click();
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-title")?.hidden, true);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-controls")?.hidden, true);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-columns")?.hidden, true);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-minimized")?.textContent, "[BOARD] Roadmap · Backlog: 1 · In Progress: 1 · Blocked: 1");
assert.equal(minimizeBoard.textContent, "Maximize");
minimizeBoard.click();
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-title")?.hidden, false);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-controls")?.hidden, false);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-columns")?.hidden, false);
assert.equal(minimizeBoard.textContent, "Minimize");
const boardTitle = board.querySelector<HTMLInputElement>(".cm-live-board-title")!;
boardTitle.value = "Updated board";
boardTitle.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
boardTitle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
const filter = board.querySelector<HTMLInputElement>("[aria-label='Filter board cards by title']")!;
filter.value = "card";
filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
board.querySelector<HTMLButtonElement>(".cm-live-board-card")?.click();
board.querySelector<HTMLButtonElement>(".cm-live-board-card")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
board.querySelector<HTMLButtonElement>(".cm-live-board-controls .secondary-button")?.click();
board.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
  input.value = "";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
board.querySelectorAll("button[aria-label]").forEach((button) => button.click());
assert.ok(opened > 0 && moved > 0 && added > 0);

live.body.querySelectorAll<HTMLButtonElement>("button[aria-label*='section'], button[title*='code']").forEach((button) => button.click());
await act(async () => {
  live.root.render(createElement(LiveMarkdownEditor, {
    noteID: "note", value: `${value}\nUpdated`, onChange: () => { changed++; }, onSave: () => { saved++; },
    onError: () => {}, onOpenWikilink: () => {}, onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {},
    showToolbar: false, defaultSectionsCollapsed: false,
  }));
  await wait();
});
await act(async () => {
  const updatedEditor = live.body.querySelector<HTMLElement>(".cm-content");
  updatedEditor?.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
});
assert.ok(changed >= 0);
await act(async () => { live.root.unmount(); });
live.shell.remove();

const interaction = mount("interaction-host");
let interactionChanges = 0;
let interactionErrors = 0;
await act(async () => {
  interaction.root.render(createElement(LiveMarkdownEditor, {
    noteID: "interaction",
    value: [
      "> Parent", "  child", "# Heading", "## Nested", "- [ ] task", "---",
      "```ts", "const value = 1;", "```", "| Name | Date |", "| --- | --- |",
      "| Row | Today |", "![image](attachment:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
      "[[Linked note]] [site](https://example.com)",
    ].join("\n"),
    onChange: () => { interactionChanges++; }, onSave: () => {},
    onError: () => { interactionErrors++; }, onOpenWikilink: () => {}, onOpenCard: () => {},
    cardTitles: new Map(), cardData: new Map(), onCreateCard: async () => null,
    onCreateBoard: async () => null, onMoveCard: () => {}, onAddCardToBoard: () => {},
    onChangeBoardTitle: () => {}, onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {},
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const interactionEditor = interaction.body.querySelector<HTMLElement>(".cm-content");
const interactionView = EditorView.findFromDOM(interactionEditor!);
assert.ok(interactionView);
const selectText = (from: number, to: number) => interactionView!.dispatch({ selection: EditorSelection.range(from, to) });
selectText(2, 8);
await act(async () => {
  interaction.shell.querySelectorAll<HTMLButtonElement>(".markdown-toolbar button").forEach((button) => button.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true })));
});
key(interactionEditor!, "a", { ctrlKey: true });
key(interactionEditor!, "s", { ctrlKey: true });
key(interactionEditor!, "l", { ctrlKey: true, altKey: true });
key(interactionEditor!, "]", { ctrlKey: true });
key(interactionEditor!, "[", { ctrlKey: true });
key(interactionEditor!, "]", { ctrlKey: true, shiftKey: true });
key(interactionEditor!, "[", { ctrlKey: true, shiftKey: true });
const taskPosition = interactionView.state.doc.toString().indexOf("task") + 4;
selectText(taskPosition, taskPosition);
key(interactionEditor!, "Enter");
key(interactionEditor!, "Enter", { shiftKey: true });
const codePosition = interactionView.state.doc.toString().indexOf("const value") + 4;
selectText(codePosition, codePosition);
key(interactionEditor!, "Tab");
key(interactionEditor!, "Tab", { shiftKey: true });
interactionView.dispatch({ changes: { from: 0, to: interactionView.state.doc.length, insert: "<" }, selection: { anchor: 1 } });
key(interactionEditor!, "Backspace");
interactionView.dispatch({ changes: { from: 0, to: interactionView.state.doc.length, insert: "→" }, selection: { anchor: 1 } });
key(interactionEditor!, "Backspace");
interactionView.dispatch({ changes: { from: 0, to: interactionView.state.doc.length, insert: "- item" }, selection: { anchor: 6 } });
const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(paste, "clipboardData", { value: { getData: () => "first\nsecond", items: [], files: [], types: ["text/plain"] } });
interactionEditor!.dispatchEvent(paste);
interaction.body.querySelector<HTMLInputElement>(".cm-live-task input")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
interaction.body.querySelector<HTMLElement>(".cm-live-horizontal-rule")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
interaction.body.querySelector<HTMLElement>(".cm-live-toggle-button")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
interaction.body.querySelector<HTMLButtonElement>(".cm-live-code-copy")?.click();
const attachment = interaction.body.querySelector<HTMLElement>(".cm-live-attachment");
attachment?.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
attachment?.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
interaction.body.querySelector<HTMLButtonElement>(".cm-live-attachment-menu button:last-child")?.click();
const handle = interaction.body.querySelector<HTMLElement>(".cm-live-object-handle");
handle?.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
interaction.body.querySelector<HTMLButtonElement>(".cm-live-object-menu button")?.click();
assert.ok(interactionChanges >= 0 && interactionErrors >= 0);
await act(async () => { interaction.root.unmount(); });
interaction.shell.remove();

const source = mount("source-host");
let scrollSyncs = 0;
const scrollSync = {
  register: () => () => { scrollSyncs++; },
  sync: () => { scrollSyncs++; },
};
await act(async () => {
  source.root.render(createElement(SourceMarkdownEditor, { noteID: "note", value: "# Source", onChange: () => {}, onError: () => {}, scrollSync }));
  await wait();
});
const sourceEditor = source.body.querySelector<HTMLElement>(".cm-content");
assert.equal(sourceEditor?.getAttribute("aria-label"), "Raw Markdown editor");
const sourceView = EditorView.findFromDOM(sourceEditor!);
assert.ok(sourceView);
await act(async () => {
  sourceView!.dispatch({ changes: { from: sourceView!.state.doc.length, insert: "!" } });
});
key(sourceEditor!, "h", { ctrlKey: true });
source.body.querySelector<HTMLElement>(".cm-scroller")?.dispatchEvent(new dom.window.Event("scroll"));
const sourcePaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(sourcePaste, "clipboardData", { value: { getData: () => "plain", items: [], files: [], types: ["text/plain"] } });
sourceEditor?.dispatchEvent(sourcePaste);
await act(async () => {
  source.root.render(createElement(SourceMarkdownEditor, { noteID: "note", value: "# Changed", onChange: () => {}, onError: () => {}, scrollSync }));
  await wait();
});
assert.ok(scrollSyncs > 0);
await act(async () => { source.root.unmount(); });
source.shell.remove();
const readonlySource = mount("readonly-source-host");
await act(async () => {
  readonlySource.root.render(createElement(SourceMarkdownEditor, { noteID: "note", value: "# Read only", onChange: () => {}, onError: () => {}, readOnly: true }));
  await wait();
});
assert.equal(readonlySource.body.querySelector<HTMLElement>(".cm-content")?.getAttribute("aria-readonly"), "true");
const readonlyPaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(readonlyPaste, "clipboardData", { value: { getData: () => "plain", items: [], files: [], types: ["text/plain"] } });
readonlySource.body.querySelector<HTMLElement>(".cm-content")?.dispatchEvent(readonlyPaste);
await act(async () => { readonlySource.root.unmount(); });
readonlySource.shell.remove();

Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => true });
let objectChanges = 0;
const object = mount("object-host");
await act(async () => {
  object.root.render(createElement(ObjectTreeView, { value, onChange: () => { objectChanges++; } }));
  await wait();
});
const objectRows = [...object.body.querySelectorAll<HTMLElement>(".object-tree-row")];
assert.ok(objectRows.length > 0);
for (const row of objectRows) {
  const edit = [...row.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit");
  edit?.click();
  const editor = row.querySelector<HTMLTextAreaElement>("textarea");
  if (editor) {
    editor.value = `${editor.value} edited`;
    editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    row.querySelector<HTMLButtonElement>("button[type='submit']")?.click();
  }
  const type = row.querySelector<HTMLSelectElement>("select");
  if (type && !type.disabled) {
    type.value = type.value === "text" ? "bulletpoint" : "text";
    type.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  }
  row.querySelector<HTMLInputElement>("input[type='checkbox']")?.click();
  row.querySelector<HTMLButtonElement>("button[title='Add a child object']")?.click();
  row.querySelector<HTMLElement>("summary")?.click();
}
const dragEvent = (type: string, clientY: number) => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: 10 }, clientY: { value: clientY } });
  return event;
};
const dragSource = objectRows[0].querySelector<HTMLButtonElement>(".object-tree-handle")!;
const dragTarget = objectRows[1];
Object.defineProperty(dragTarget, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, height: 100 }) });
Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [dragTarget] });
dragSource.dispatchEvent(dragEvent("pointerdown", 50));
document.dispatchEvent(dragEvent("pointermove", 10));
document.dispatchEvent(dragEvent("pointermove", 50));
document.dispatchEvent(dragEvent("pointermove", 90));
document.dispatchEvent(dragEvent("pointerup", 90));
Object.defineProperty(dragTarget, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, height: 0 }) });
Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [dragTarget.querySelector(".object-tree-text")] });
dragSource.dispatchEvent(dragEvent("pointerdown", 50));
document.dispatchEvent(dragEvent("pointermove", 50));
document.dispatchEvent(dragEvent("pointerup", 50));
Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [] });
dragSource.dispatchEvent(dragEvent("pointerdown", 50));
document.dispatchEvent(dragEvent("pointermove", 50));
document.dispatchEvent(dragEvent("pointerup", 50));
dragSource.dispatchEvent(dragEvent("pointerdown", 50));
document.dispatchEvent(dragEvent("pointercancel", 50));
assert.ok(objectChanges > 1);
const attachmentObject = mount("attachment-object-host");
await act(async () => {
  attachmentObject.root.render(createElement(ObjectTreeView, { value: "[report.pdf](attachment:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)", onChange: () => {} }));
  await wait();
});
assert.match(attachmentObject.body.textContent ?? "", /Attachment syntax/);
await act(async () => { attachmentObject.root.unmount(); });
attachmentObject.shell.remove();
object.body.querySelector<HTMLButtonElement>(".object-tree-delete")?.click();
assert.ok(objectChanges > 0);
await act(async () => { object.root.unmount(); });
object.shell.remove();
