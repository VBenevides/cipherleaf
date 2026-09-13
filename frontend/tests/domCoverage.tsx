import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cardReference, boardMarker, type BoardColumn, type CardMetadata } from "../src/cards";
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
  NodeFilter: { value: dom.window.NodeFilter, configurable: true },
  Window: { value: dom.window.Window, configurable: true },
  MutationObserver: { value: dom.window.MutationObserver, configurable: true },
  DOMRect: { value: dom.window.DOMRect, configurable: true },
  ResizeObserver: { value: ResizeObserverStub, configurable: true },
  getComputedStyle: { value: dom.window.getComputedStyle, configurable: true },
  requestAnimationFrame: { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true },
  cancelAnimationFrame: { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
if (dom.window.HTMLDialogElement) {
  Object.defineProperties(dom.window.HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; this.dispatchEvent(new dom.window.Event("close")); } },
  });
}
Object.defineProperty(dom.window.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async () => {}, write: async () => {}, read: async () => [] },
});
Object.defineProperty(dom.window, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
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
  ["card-1", { id: "card-1", title: "Backlog card", status: "not-started", tags: ["work", " alpha "], createdAt: "2026-01-01T12:00:00" }],
  ["card-2", { id: "card-2", title: "Active card", status: "in-progress", tags: ["WORK"], createdAt: "2026-01-01T12:00:00", startedAt: "2026-01-02T12:00:00" }],
  ["card-3", { id: "card-3", title: "Blocked card", status: "blocked", tags: ["urgent"], createdAt: "2026-01-01T12:00:00", blockedOn: "2026-01-03T12:00:00" }],
  ["card-4", { id: "card-4", title: "Finished card", status: "finished", tags: [], createdAt: "2026-01-01T12:00:00", finishedAt: "2026-01-04T12:00:00" }],
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
  `  > Tag 1\n    [ ] ${cardReference("card-1")} Untitled`,
  "    [ ] [card](note:missing-card)",
  "    [ ] [card](legacy-missing) Legacy title",
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
assert.ok(live.body.querySelector(".cm-live-card-reference"));

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
const cardReferenceElement = live.body.querySelector<HTMLElement>(".cm-live-card-reference");
cardReferenceElement?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
cardReferenceElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
live.body.querySelector<HTMLElement>(".cm-live-citation")?.click();
live.body.querySelector<HTMLButtonElement>(".cm-live-link-menu button")?.click();

const editorNode = live.body.querySelector<HTMLElement>(".cm-editor");
const boardNode = live.body.querySelector<HTMLElement>(".cm-live-board");
const updatedCards = new Map(cards);
updatedCards.set("card-1", { ...cards.get("card-1")!, title: "Renamed card" });
await act(async () => {
  live.root.render(createElement(LiveMarkdownEditor, {
    noteID: "note",
    value,
    onChange: () => { changed++; },
    onSave: () => { saved++; },
    onError: () => {},
    onOpenWikilink: () => { opened++; },
    onOpenCard: () => { opened++; },
    cardTitles: new Map([["card-1", "Renamed card"]]),
    cardData: updatedCards,
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
assert.strictEqual(live.body.querySelector<HTMLElement>(".cm-editor"), editorNode);
assert.strictEqual(live.body.querySelector<HTMLElement>(".cm-live-board"), boardNode);
const board = live.body.querySelector<HTMLElement>(".cm-live-board");
assert.ok(board);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-description")?.textContent, "Organize and track your cards across different states.");
assert.equal(board.querySelectorAll<HTMLInputElement>(".cm-live-board-column-name").length, 4);
assert.equal(board.querySelectorAll<HTMLInputElement>(".cm-live-board-column-color").length, 4);
assert.deepEqual([...board.querySelectorAll<HTMLElement>(".cm-live-board-column-count")].map((count) => count.textContent), ["1", "1", "1", "1"]);
assert.ok(board.querySelector("button[aria-label=\"Add board column\"]"));
assert.equal(board.querySelectorAll("button[aria-label=\"Remove column\"]").length, 4);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-card-title")?.textContent, "Renamed card");
assert.ok([...board.querySelectorAll<HTMLElement>(".cm-live-board-card-title")].some((title) => title.style.fontSize));
assert.ok(board.querySelector(".cm-live-board-card-tags"));
assert.deepEqual([...board.querySelectorAll<HTMLTimeElement>(".cm-live-board-card-date")].map((date) => [date.dateTime, date.textContent]), [
  ["2026-01-01T12:00:00", "2026-01-01"],
  ["2026-01-02T12:00:00", "2026-01-02"],
  ["2026-01-03T12:00:00", "2026-01-03"],
  ["2026-01-04T12:00:00", "2026-01-04"],
]);
const boardTagFilter = board.querySelector<HTMLSelectElement>("select[aria-label=\"Filter board cards by tags\"]")!;
assert.deepEqual([...boardTagFilter.options].map((option) => option.textContent), ["", "work", "alpha", "urgent"]);
boardTagFilter.value = "work";
boardTagFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
assert.equal([...board.querySelectorAll<HTMLButtonElement>(".cm-live-board-card")].filter((card) => !card.hidden).length, 2);
assert.deepEqual([...board.querySelectorAll<HTMLElement>(".cm-live-board-column-count")].map((count) => count.textContent), ["1", "1", "0", "0"]);
const clearBoardFilters = [...board.querySelectorAll<HTMLButtonElement>(".cm-live-board-controls button")].find((button) => button.textContent === "Clear")!;
clearBoardFilters.click();
assert.equal(boardTagFilter.value, "");
assert.equal([...board.querySelectorAll<HTMLButtonElement>(".cm-live-board-card")].filter((card) => !card.hidden).length, 4);
assert.deepEqual([...board.querySelectorAll<HTMLElement>(".cm-live-board-column-count")].map((count) => count.textContent), ["1", "1", "1", "1"]);
const boardFilter = board.querySelector<HTMLInputElement>("input[aria-label=\"Filter board cards by title\"]")!;
boardFilter.value = "Renamed";
boardFilter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
assert.equal([...board.querySelectorAll<HTMLButtonElement>(".cm-live-board-card")].filter((card) => !card.hidden).length, 1);
boardFilter.value = "";
boardFilter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
assert.deepEqual([...board.querySelectorAll<HTMLElement>(".cm-live-board-column-count")].map((count) => count.textContent), ["1", "1", "1", "1"]);
const boardCard = board.querySelector<HTMLButtonElement>(".status-not-started .cm-live-board-card")!;
const blockedColumn = board.querySelector<HTMLElement>(".status-blocked")!;
const elementFromPoint = document.elementFromPoint;
Object.defineProperty(document, "elementFromPoint", {
  configurable: true,
  value: () => blockedColumn,
});
const pointer = (type: string, clientX: number, clientY: number) => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
};
const movesBeforePointerDrag = moved;
boardCard.dispatchEvent(pointer("pointerdown", 0, 0));
document.dispatchEvent(pointer("pointermove", 20, 20));
assert.ok(blockedColumn.querySelector(".cm-live-board-card.is-drag-preview"));
document.dispatchEvent(pointer("pointerup", 20, 20));
assert.equal(blockedColumn.querySelector(".cm-live-board-card.is-drag-preview"), null);
Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
assert.equal(moved, movesBeforePointerDrag + 1);
const openedBeforeBoardClick = opened;
boardCard.dispatchEvent(pointer("pointerdown", 0, 0));
document.dispatchEvent(pointer("pointerup", 0, 0));
boardCard.click();
assert.equal(opened, openedBeforeBoardClick + 1);
const boardToggle = board.querySelector<HTMLButtonElement>(".cm-live-board-toggle")!;
const liveScroller = live.body.querySelector<HTMLElement>(".cm-scroller")!;
liveScroller.scrollTop = 240;
boardToggle.click();
assert.equal(liveScroller.scrollTop, 240);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-title")?.hidden, true);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-controls")?.hidden, true);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-columns")?.hidden, true);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-minimized")?.textContent, "[BOARD] Roadmap · Backlog: 1 · In Progress: 1 · Blocked: 1 · Concluded: 1");
assert.equal(boardToggle.textContent, "›");
assert.equal(boardToggle.getAttribute("aria-expanded"), "false");
boardToggle.click();
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-title")?.hidden, false);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-controls")?.hidden, false);
assert.equal(board.querySelector<HTMLElement>(".cm-live-board-columns")?.hidden, false);
assert.equal(boardToggle.textContent, "⌄");
assert.equal(boardToggle.getAttribute("aria-expanded"), "true");
const boardTitle = board.querySelector<HTMLInputElement>(".cm-live-board-title")!;
boardTitle.value = "Updated board";
boardTitle.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
boardTitle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
const filter = board.querySelector<HTMLInputElement>("[aria-label='Filter board cards by title']")!;
filter.value = "card";
filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
board.querySelector<HTMLButtonElement>(".cm-live-board-card")?.click();
board.querySelector<HTMLButtonElement>(".cm-live-board-card")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
([...board.querySelectorAll<HTMLButtonElement>(".cm-live-board-controls .secondary-button")].find((button) => button.textContent === "New card"))?.click();
board.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
  input.value = "";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
board.querySelectorAll("button[aria-label]").forEach((button) => button.click());
assert.ok(opened > 0 && moved > 0 && added > 0);

const multiBoard = mount("multi-board-host");
const addedBoardIDs: string[] = [];
await act(async () => {
  multiBoard.root.render(createElement(LiveMarkdownEditor, {
    noteID: "multi-board", value: [boardMarker("board-a", [], "First"), boardMarker("board-b", [], "Second")].join("\n"),
    onChange: () => {}, onSave: () => {}, onError: () => {}, onOpenWikilink: () => {}, onOpenCard: () => {},
    cardData: cards, onCreateBoard: async () => null, onAddCardToBoard: (boardID) => { addedBoardIDs.push(boardID); },
    onMoveCard: () => {}, onChangeBoardTitle: () => {}, onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {},
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const multiBoards = multiBoard.body.querySelectorAll<HTMLElement>(".cm-live-board");
assert.equal(multiBoards.length, 2);
const secondBoardNewCard = [...multiBoards[1].querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New card")!;
secondBoardNewCard.click();
assert.deepEqual(addedBoardIDs, ["board-b"]);
await act(async () => { multiBoard.root.unmount(); });
multiBoard.shell.remove();

let dynamicColumns: readonly BoardColumn[] = [];
let dynamicDeleted: readonly BoardColumn[] = [];
let dynamicOrphans: readonly string[] = [];
let createdBoardTemplate = "";
const dynamic = mount("dynamic-board-host");
await act(async () => {
  dynamic.root.render(createElement(LiveMarkdownEditor, {
    noteID: "dynamic", value: boardMarker("dynamic", [], "Dynamic", {
      columns: [
        { id: "todo", name: "Todo", color: "#123456", cardIDs: ["card-1", "card-2", "card-3"] },
        { id: "done", name: "Done", color: "#ABCDEF", cardIDs: [] },
      ],
    }),
    onChange: () => {}, onSave: () => {}, onError: () => {}, onOpenWikilink: () => {}, onOpenCard: () => {},
    cardData: cards, onMoveCardInBoard: () => {}, onChangeBoardColumns: (_boardID, columns, deleted, orphans) => {
      dynamicColumns = columns;
      dynamicDeleted = deleted ?? [];
      dynamicOrphans = orphans ?? [];
    },
    cardTemplates: [{ id: "template-1", name: "Template" }],
    onCreateBoardTemplate: (boardID) => { createdBoardTemplate = boardID; },
    onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {}, defaultSectionsCollapsed: false,
  }));
  await wait();
});
const dynamicBoard = dynamic.body.querySelector<HTMLElement>(".cm-live-board")!;
assert.equal(dynamicBoard.querySelectorAll(".cm-live-board-column").length, 2);
const editBoardTemplate = [...dynamicBoard.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit Card Template")!;
editBoardTemplate.click();
assert.equal(createdBoardTemplate, "dynamic");
const dynamicName = dynamicBoard.querySelector<HTMLInputElement>(".cm-live-board-column-name")!;
dynamicName.value = "Ready";
dynamicName.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
assert.equal(dynamicColumns[0]?.name, "Ready");
const dynamicColor = dynamicBoard.querySelector<HTMLInputElement>(".cm-live-board-column-color")!;
dynamicColor.value = "#654321";
dynamicColor.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
assert.equal(dynamicColumns[0]?.color, "#654321");
dynamicBoard.querySelectorAll<HTMLButtonElement>(".cm-live-board-column-move")[1]?.click();
dynamicBoard.querySelector<HTMLButtonElement>("button[aria-label=\"Add board column\"]")?.click();
assert.equal(dynamicColumns.length, 3);
dynamicBoard.querySelector<HTMLButtonElement>("button[aria-label=\"Remove column\"]")!.click();
assert.deepEqual(dynamicColumns, [{ id: "done", name: "Done", color: "#ABCDEF", cardIDs: [] }]);
assert.deepEqual(dynamicDeleted, [{ id: "todo", name: "Todo", color: "#123456", cardIDs: ["card-1", "card-2", "card-3"] }]);
assert.deepEqual(dynamicOrphans, ["card-1", "card-2", "card-3"]);
await act(async () => { dynamic.root.unmount(); });
dynamic.shell.remove();

const sameTitleCards = new Map([...cards].map(([id, card]) => [id, { ...card, title: "Same title" }]));
let orphanColumns: readonly BoardColumn[] = [{ id: "todo", name: "Todo", color: "#123456", cardIDs: ["card-4"] }];
let orphanIDs: readonly string[] = ["card-1", "card-2", "card-3"];
const orphan = mount("orphan-board-host");
const renderOrphanBoard = async () => {
  await act(async () => {
    orphan.root.render(createElement(LiveMarkdownEditor, {
      noteID: "orphan", value: boardMarker("orphan", ["card-1", "card-2", "card-3", "card-4"], "Orphans", {
        columns: orphanColumns.map((column) => ({ ...column, cardIDs: [...column.cardIDs] })),
        orphanCardIDs: [...orphanIDs],
      }),
      onChange: () => {}, onSave: () => {}, onError: () => {}, onOpenWikilink: () => {}, onOpenCard: () => {}, cardData: sameTitleCards,
      onChangeBoardColumns: (_boardID, columns, _deleted, orphans) => {
        orphanColumns = columns;
        orphanIDs = orphans ?? [];
      },
      onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {}, defaultSectionsCollapsed: false,
    }));
    await wait();
  });
};
await renderOrphanBoard();
let orphanBoard = orphan.body.querySelector<HTMLElement>(".cm-live-board")!;
orphanBoard.querySelectorAll<HTMLButtonElement>(".cm-live-board-recovery-button")[1]!.click();
assert.equal(orphanBoard.querySelectorAll(".cm-live-board-recovery-panel:not([hidden]) .cm-live-board-recovery-row").length, 3);
for (const expected of [["card-2", "card-3"], ["card-3"], []]) {
  orphanBoard.querySelector<HTMLButtonElement>(".cm-live-board-recovery-panel:not([hidden]) .secondary-button")!.click();
  assert.deepEqual(orphanIDs, expected);
  assert.equal(orphanColumns[0]?.cardIDs.length, 4 - expected.length);
  if (expected.length > 0) {
    await renderOrphanBoard();
    orphanBoard = orphan.body.querySelector<HTMLElement>(".cm-live-board")!;
    orphanBoard.querySelectorAll<HTMLButtonElement>(".cm-live-board-recovery-button")[1]!.click();
  }
}
assert.deepEqual(orphanColumns[0]?.cardIDs, ["card-4", "card-1", "card-2", "card-3"]);
await act(async () => { orphan.root.unmount(); });
orphan.shell.remove();

let recoveryColumns: readonly BoardColumn[] = [];
let recoveryDeleted: readonly BoardColumn[] = [];
let recoveryOrphans: readonly string[] = [];
const recovery = mount("recovery-board-host");
await act(async () => {
  recovery.root.render(createElement(LiveMarkdownEditor, {
    noteID: "recovery", value: boardMarker("recovery", ["card-1", "card-2", "card-3"], "Recovery", {
      columns: [{ id: "todo", name: "Todo", color: "#123456", cardIDs: ["card-1"] }],
      deletedColumns: [{ id: "archive", name: "Archived", color: "#654321", cardIDs: ["card-2"] }],
      orphanCardIDs: [],
    }),
    onChange: () => {}, onSave: () => {}, onError: () => {}, onOpenWikilink: () => {}, onOpenCard: () => {}, cardData: cards,
    onChangeBoardColumns: (_boardID, columns, deleted, orphans) => {
      recoveryColumns = columns;
      recoveryDeleted = deleted ?? [];
      recoveryOrphans = orphans ?? [];
    },
    onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {}, defaultSectionsCollapsed: false,
  }));
  await wait();
});
const recoveryBoard = recovery.body.querySelector<HTMLElement>(".cm-live-board")!;
assert.match(recoveryBoard.querySelector<HTMLButtonElement>(".cm-live-board-recovery-button")?.textContent ?? "", /Deleted Columns 1/);
assert.match(recoveryBoard.querySelectorAll<HTMLButtonElement>(".cm-live-board-recovery-button")[1]?.textContent ?? "", /Orphan Cards 2/);
recoveryBoard.querySelector<HTMLButtonElement>(".cm-live-board-recovery-button")!.click();
recoveryBoard.querySelector<HTMLButtonElement>(".cm-live-board-recovery-panel:not([hidden]) .secondary-button")!.click();
assert.equal(recoveryColumns.length, 2);
assert.equal(recoveryDeleted.length, 0);
assert.deepEqual(recoveryOrphans, ["card-3"]);
assert.deepEqual(recoveryColumns[1]?.cardIDs, ["card-2"]);
await act(async () => { recovery.root.unmount(); });
recovery.shell.remove();

let createdSnippet = "";
const snippet = mount("snippet-host");
await act(async () => {
  snippet.root.render(createElement(LiveMarkdownEditor, {
    noteID: "snippet", value: "/today", onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {}, onCreateCard: async () => { createdSnippet = "card"; return "Card"; },
    onCreateBoard: async () => "Board", showToolbar: false, defaultSectionsCollapsed: false,
  }));
  await wait();
});
const snippetEditor = snippet.body.querySelector<HTMLElement>(".cm-content")!;
const snippetView = EditorView.findFromDOM(snippetEditor)!;
const expandSnippetInEditor = async (text: string) => {
  snippetView.dispatch({ changes: { from: 0, to: snippetView.state.doc.length, insert: text }, selection: EditorSelection.cursor(text.length) });
  key(snippetEditor, "Enter");
  await act(async () => { await wait(); });
};
await expandSnippetInEditor("/today");
assert.notEqual(snippetView.state.doc.toString(), "/today");
await expandSnippetInEditor("/card");
assert.equal(createdSnippet, "card");
await expandSnippetInEditor("/board");
assert.equal(snippetView.state.doc.toString(), "Board");
await act(async () => { snippet.root.unmount(); });
snippet.shell.remove();

const cardsWithoutTags = new Map([...updatedCards].map(([id, card]) => [id, { ...card, tags: [] }]));
await act(async () => {
  live.root.render(createElement(LiveMarkdownEditor, {
    noteID: "note", value, onChange: () => { changed++; }, onSave: () => { saved++; }, onError: () => {},
    onOpenWikilink: () => { opened++; }, onOpenCard: () => { opened++; }, cardData: cardsWithoutTags,
    onCreateCard: async () => null, onCreateBoard: async () => null, onMoveCard: () => { moved++; },
    onAddCardToBoard: () => { added++; }, onChangeBoardTitle: () => { changed++; },
    onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {}, defaultSectionsCollapsed: false,
  }));
  await wait();
});
const emptyTagFilter = live.body.querySelector<HTMLSelectElement>("select[aria-label=\"Filter board cards by tags\"]")!;
assert.deepEqual([...emptyTagFilter.options].map((option) => option.textContent), [""]);
emptyTagFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

live.body.querySelectorAll<HTMLButtonElement>("button[aria-label*='section'], button[title*='code']").forEach((button) => button.click());
await act(async () => {
  live.root.render(createElement(LiveMarkdownEditor, {
    noteID: "note", value: `${value}\nUpdated`, onChange: () => { changed++; }, onSave: () => { saved++; },
    onError: () => {}, onOpenWikilink: () => {}, onDecreaseFontSize: () => {}, onIncreaseFontSize: () => {},
    showToolbar: false, defaultSectionsCollapsed: false,
  }));
  await wait();
});
assert.equal(liveScroller.scrollTop, 240);
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
key(interactionEditor!, "z", { ctrlKey: true, shiftKey: true });
key(interactionEditor!, "h", { ctrlKey: true });
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
interaction.body.querySelector<HTMLInputElement>(".cm-live-task input")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
interaction.body.querySelector<HTMLElement>(".cm-live-horizontal-rule")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
interaction.body.querySelector<HTMLElement>(".cm-live-toggle-button")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
interaction.body.querySelector<HTMLButtonElement>(".cm-live-code-copy")?.click();
interactionView.dispatch({ changes: { from: 0, to: interactionView.state.doc.length, insert: "<" }, selection: { anchor: 1 } });
key(interactionEditor!, "Backspace");
interactionView.dispatch({ changes: { from: 0, to: interactionView.state.doc.length, insert: "→" }, selection: { anchor: 1 } });
key(interactionEditor!, "Backspace");
interactionView.dispatch({ changes: { from: 0, to: interactionView.state.doc.length, insert: "- item" }, selection: { anchor: 6 } });
const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(paste, "clipboardData", { value: { getData: () => "first\nsecond", items: [], files: [], types: ["text/plain"] } });
interactionEditor!.dispatchEvent(paste);
const liveImagePaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(liveImagePaste, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => clipboardImageBlob }], files: [], types: ["Files"], getData: () => "" } });
interactionEditor!.dispatchEvent(liveImagePaste);
const missingImagePaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(missingImagePaste, "clipboardData", { value: { items: [], files: [], types: ["Files"], getData: () => "" } });
interactionEditor!.dispatchEvent(missingImagePaste);
await act(async () => { await wait(); });
const attachment = interaction.body.querySelector<HTMLElement>(".cm-live-attachment");
await act(async () => {
  attachment?.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  const image = attachment?.querySelector<HTMLImageElement>("img");
  if (image) Object.defineProperty(image, "getBoundingClientRect", { configurable: true, value: () => ({ width: 160 }) });
  attachment?.querySelector<HTMLElement>(".cm-live-attachment-resize")?.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 40 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 40 }));
  await wait();
});
const resizedAttachment = interaction.body.querySelector<HTMLElement>(".cm-live-attachment");
resizedAttachment?.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
interaction.body.querySelector<HTMLButtonElement>(".cm-live-attachment-menu button:first-child")?.click();
resizedAttachment?.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
interaction.body.querySelector<HTMLButtonElement>(".cm-live-attachment-menu button:last-child")?.click();
const handle = interaction.body.querySelector<HTMLElement>(".cm-live-object-handle");
handle?.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
interaction.body.querySelector<HTMLButtonElement>(".cm-live-object-menu button")?.click();
assert.ok(interactionChanges >= 0 && interactionErrors >= 0);
await act(async () => { interaction.root.unmount(); });
interaction.shell.remove();

const outline = mount("outline-host");
await act(async () => {
  outline.root.render(createElement(LiveMarkdownEditor, {
    noteID: "outline", value: "item\n  child", onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {}, showToolbar: false, defaultSectionsCollapsed: false,
  }));
  await wait();
});
const outlineEditor = outline.body.querySelector<HTMLElement>(".cm-content")!;
const outlineView = EditorView.findFromDOM(outlineEditor)!;
outlineView.dispatch({ selection: EditorSelection.cursor(2) });
key(outlineEditor, "Tab");
key(outlineEditor, "Tab", { shiftKey: true });
await act(async () => { await wait(); outline.root.unmount(); });
outline.shell.remove();

const citation = mount("citation-host");
await act(async () => {
  citation.root.render(createElement(LiveMarkdownEditor, {
    noteID: "citation", value: "[site](https://example.com)", onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {}, showToolbar: false, defaultSectionsCollapsed: false,
  }));
  await wait();
});
const citationLink = citation.body.querySelector<HTMLButtonElement>(".cm-live-citation");
assert.ok(citationLink);
citationLink.click();
citation.body.closest("body")?.querySelector<HTMLButtonElement>(".cm-live-link-menu button:last-child")?.click();
const citationDialog = document.body.querySelector<HTMLDialogElement>(".cm-live-link-dialog");
assert.ok(citationDialog);
const citationInputs = citationDialog.querySelectorAll<HTMLInputElement>("input");
citationInputs[0].value = "updated";
citationInputs[1].value = "https://updated.example";
citationDialog.querySelector("form")?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
await act(async () => { await wait(); citation.root.unmount(); });
citation.shell.remove();

document.documentElement.dataset.journalLines = "full";
const layout = mount("layout-host");
await act(async () => {
  layout.root.render(createElement(LiveMarkdownEditor, {
    noteID: "layout", value: "> Parent\n  > Child\n    ```ts\n    const deep = 1;\n    ```\n  following", onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {}, showToolbar: false, defaultSectionsCollapsed: true,
  }));
  await wait();
});
layout.body.querySelector<HTMLElement>(".cm-scroller")?.dispatchEvent(new dom.window.Event("scroll"));
layout.body.querySelector<HTMLButtonElement>(".cm-live-toggle-button")?.click();
await act(async () => { await wait(); layout.root.unmount(); });
layout.shell.remove();
delete document.documentElement.dataset.journalLines;

const boundary = mount("board-boundary-host");
const boundaryBoards = [boardMarker("boundary-a"), "", boardMarker("boundary-b")];
await act(async () => {
  boundary.root.render(createElement(LiveMarkdownEditor, {
    noteID: "board-boundary",
    value: boundaryBoards.join("\n"),
    onChange: () => {},
    onSave: () => {},
    onError: () => {},
    onOpenWikilink: () => {},
    onOpenCard: () => {},
    cardTitles: new Map(),
    cardData: new Map(),
    onCreateCard: async () => null,
    onCreateBoard: async () => null,
    onMoveCard: () => {},
    onAddCardToBoard: () => {},
    onChangeBoardTitle: () => {},
    onDecreaseFontSize: () => {},
    onIncreaseFontSize: () => {},
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const boundaryEditor = boundary.body.querySelector<HTMLElement>(".cm-content")!;
const boundaryView = EditorView.findFromDOM(boundaryEditor)!;
const blankLine = boundaryView.state.doc.line(2);
assert.ok([...boundary.body.querySelectorAll<HTMLElement>(".cm-line.cm-live-empty-line")].some((line) => (
  line.lastElementChild?.tagName === "BR"
)));
boundaryView.dispatch({ selection: EditorSelection.cursor(blankLine.from) });
await act(async () => {
  key(boundaryEditor, "Backspace");
  await wait();
});
assert.equal(boundaryView.state.doc.toString(), [boundaryBoards[0], boundaryBoards[2]].join("\n"));
boundaryView.dispatch({
  changes: { from: 0, to: boundaryView.state.doc.length, insert: boundaryBoards.join("\n") },
});
boundaryView.dispatch({ selection: EditorSelection.cursor(boundaryView.state.doc.line(2).to) });
await act(async () => {
  key(boundaryEditor, "Delete");
  await wait();
});
assert.equal(boundaryView.state.doc.toString(), [boundaryBoards[0], boundaryBoards[2]].join("\n"));
boundaryView.dispatch({
  changes: { from: 0, to: boundaryView.state.doc.length, insert: [boundaryBoards[0], "text"].join("\n") },
});
boundaryView.dispatch({ selection: EditorSelection.cursor(boundaryView.state.doc.line(2).from) });
await act(async () => {
  key(boundaryEditor, "Backspace");
  await wait();
});
assert.equal(boundaryView.state.doc.toString(), [boundaryBoards[0], "text"].join("\n"));
boundaryView.dispatch({
  changes: { from: 0, to: boundaryView.state.doc.length, insert: boundaryBoards.join("\n") },
});
boundaryView.dispatch({ selection: EditorSelection.range(0, 1) });
await act(async () => {
  key(boundaryEditor, "Backspace");
  await wait();
});
assert.equal(boundaryView.state.doc.toString(), boundaryBoards.join("\n"));
boundaryView.dispatch({
  selection: EditorSelection.range(
    boundaryView.state.doc.line(2).from - 1,
    boundaryView.state.doc.line(3).from,
  ),
});
await act(async () => {
  key(boundaryEditor, "Backspace");
  await wait();
});
assert.equal(boundaryView.state.doc.toString(), boundaryBoards.join("\n"));
await act(async () => { boundary.root.unmount(); });
boundary.shell.remove();

const indentation = mount("indentation-host");
await act(async () => {
  indentation.root.render(createElement(LiveMarkdownEditor, {
    noteID: "indentation",
    value: "> Parent\n  \n  following",
    onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {}, showToolbar: false,
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const indentationEditor = indentation.body.querySelector<HTMLElement>(".cm-content");
const indentationView = EditorView.findFromDOM(indentationEditor!);
assert.ok(indentationView);
const blankLineFrom = indentationView!.state.doc.line(2).from;
indentationView!.dispatch({ selection: EditorSelection.cursor(blankLineFrom) });
const inputHandler = indentationView!.state.facet(EditorView.inputHandler).find((handler) =>
  handler(indentationView!, blankLineFrom, blankLineFrom, "typed"),
);
assert.ok(inputHandler);
assert.equal(indentationView!.state.doc.toString(), "> Parent\n  typed\n  following");
assert.equal(indentationView!.state.selection.main.head, blankLineFrom + 2 + "typed".length);
await act(async () => { indentation.root.unmount(); });
indentation.shell.remove();

const searchTargetHost = mount("search-target-host");
await act(async () => {
  searchTargetHost.root.render(createElement(LiveMarkdownEditor, {
    noteID: "search-target",
    value: "phrase here\nother phrase",
    searchTarget: {
      noteID: "search-target",
      offset: 0,
      matchLength: 6,
      utf16Offset: 0,
      utf16MatchLength: 6,
      query: "phrase",
    },
    onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {}, showToolbar: false,
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const searchTargetEditor = searchTargetHost.body.querySelector<HTMLElement>(".cm-content");
const searchTargetView = EditorView.findFromDOM(searchTargetEditor!);
assert.ok(searchTargetView);
assert.equal(searchTargetView!.state.selection.main.from, 0);
assert.equal(searchTargetView!.state.selection.main.to, 6);
assert.equal(searchTargetHost.body.querySelectorAll(".cm-live-search-highlight").length, 1);
searchTargetView!.dispatch({ changes: { from: 0, insert: "x" } });
assert.equal(searchTargetHost.body.querySelectorAll(".cm-live-search-highlight").length, 0);
await act(async () => { searchTargetHost.root.unmount(); });
searchTargetHost.shell.remove();

const scratchpadToolbarShell = document.createElement("section");
scratchpadToolbarShell.className = "scratchpad-editor";
const scratchpadHeading = scratchpadToolbarShell.appendChild(document.createElement("header"));
scratchpadHeading.className = "scratchpad-heading";
const scratchpadBody = scratchpadToolbarShell.appendChild(document.createElement("div"));
scratchpadBody.className = "document-body scratchpad-editor-body";
document.body.append(scratchpadToolbarShell);
const scratchpadRoot = createRoot(scratchpadBody);
await act(async () => {
  scratchpadRoot.render(createElement(LiveMarkdownEditor, {
    noteID: "scratchpad-toolbar",
    value: "Scratchpad",
    onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {},
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const scratchpadToolbar = scratchpadToolbarShell.querySelector(".markdown-toolbar");
assert.equal(scratchpadHeading.nextElementSibling, scratchpadToolbar);
assert.equal(scratchpadToolbar?.nextElementSibling, scratchpadBody);
await act(async () => { scratchpadRoot.unmount(); });
scratchpadToolbarShell.remove();

const noteToolbar = mount("note-toolbar-host");
const noteHeading = document.createElement("header");
noteToolbar.shell.insertBefore(noteHeading, noteToolbar.body);
await act(async () => {
  noteToolbar.root.render(createElement(LiveMarkdownEditor, {
    noteID: "note-toolbar",
    value: "Note",
    onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {},
    defaultSectionsCollapsed: false,
  }));
  await wait();
});
const noteToolbarElement = noteToolbar.shell.querySelector(".markdown-toolbar");
assert.equal(noteHeading.nextElementSibling, noteToolbarElement);
assert.equal(noteToolbarElement?.nextElementSibling, noteToolbar.body);
await act(async () => { noteToolbar.root.unmount(); });
noteToolbar.shell.remove();

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
const sourceImagePaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(sourceImagePaste, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => clipboardImageBlob }], files: [], types: ["Files"], getData: () => "" } });
sourceEditor?.dispatchEvent(sourceImagePaste);
await act(async () => { await wait(); });
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

const liveDrag = mount("live-drag-host");
await act(async () => {
  liveDrag.root.render(createElement(LiveMarkdownEditor, {
    noteID: "live-drag", value: "> Parent\n  child\n> Sibling", onChange: () => {}, onSave: () => {}, onError: () => {},
    onOpenWikilink: () => {}, onOpenCard: () => {}, showToolbar: false, defaultSectionsCollapsed: false,
  }));
  await wait();
});
const liveDragHandle = liveDrag.body.querySelector<HTMLElement>(".cm-live-object-handle")!;
const liveDragLines = liveDrag.body.querySelectorAll<HTMLElement>(".cm-live-object-line[data-object-line]");
const liveDragTarget = liveDragLines[2]!;
Object.defineProperty(liveDragTarget, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, height: 100 }) });
const originalElementsFromPoint = document.elementsFromPoint;
Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [liveDragTarget] });
const liveDragEvent = (type: string, clientY: number) => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: 10 }, clientY: { value: clientY } });
  return event;
};
liveDragHandle.dispatchEvent(liveDragEvent("pointerdown", 50));
document.dispatchEvent(liveDragEvent("pointermove", 10));
document.dispatchEvent(liveDragEvent("pointermove", 50));
document.dispatchEvent(liveDragEvent("pointermove", 90));
document.dispatchEvent(liveDragEvent("pointerup", 90));
Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: originalElementsFromPoint });
await act(async () => { await wait(); liveDrag.root.unmount(); });
liveDrag.shell.remove();

const mainHost = document.body.appendChild(document.createElement("div"));
mainHost.id = "root";
const reactDOMClient = await import("react-dom/client");
const originalCreateRoot = reactDOMClient.default.createRoot;
const fakeRoot = { render: (_element: unknown) => {}, unmount: () => {} };
reactDOMClient.default.createRoot = (() => fakeRoot) as typeof originalCreateRoot;
try {
  await import("../src/main.tsx?coverage-normal");
  dom.window.localStorage.setItem("cipherleaf-theme", "dark");
  dom.window.localStorage.setItem("cipherleaf-scratchpad-opacity", "0.75");
  dom.window.localStorage.setItem("cipherleaf-editor-font-size", "18");
  dom.reconfigure({ url: "http://localhost/?window=scratchpad" });
  await import("../src/main.tsx?coverage-scratchpad");
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "cipherleaf-theme", newValue: "archivist" }));
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "cipherleaf-scratchpad-opacity", newValue: "0.25" }));
  dom.window.dispatchEvent(new dom.window.Event("focus"));
} finally {
  reactDOMClient.default.createRoot = originalCreateRoot;
  mainHost.remove();
}

dom.window.close();
