import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Annotation,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { HighlightStyle, LanguageDescription, highlightingFor, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { highlightTree, tags } from "@lezer/highlight";
import { minimalSetup } from "codemirror";
import { history, redo, undo } from "@codemirror/commands";
import { Browser, Clipboard } from "@wailsio/runtime";
import {
  acceptCompletion,
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { openSearchPanel, searchKeymap, search } from "@codemirror/search";
import {
  attachmentMarkdown,
  isHorizontalRule,
  isTableDivider,
  embeddedClipboardImage,
  insertAttachmentMarkdown,
  markdownCitation,
  markdownCitations,
  normalizeArrowText,
  parseAttachmentMarkdown,
  tableCells,
} from "./markdown";
import {
  continuationPrefix,
  deleteObjectInMarkdown,
  moveObjectInMarkdown,
  objectAncestorsByLine,
  objectContentIndent,
  objectDepthByLine,
  objectOwnerLineNumber,
  objectBlockEnd,
  insertLogicalObjectAfterCaret,
  normalizeStackedExclusiveObjectPrefix,
  parseObjectDocument,
  replaceExclusiveObjectPrefix,
  remapObjectKeysByLine,
  repeatedObjectPrefix,
  type ObjectDropMode,
  type ObjectDocument,
  type ObjectLine,
} from "./objectDocument";
import {
  rangeForActiveDocument,
  searchHighlightField,
  searchTargetTransaction,
  type SearchTarget,
} from "./searchTarget";
import { SNIPPETS, completeCodeFenceElement, expandSnippetWithContext } from "./snippets";
import { expandedSelection } from "./editorSelection";
import { boardCardsForColumn, BOARD_COLUMNS, BOARD_COLUMN_LABELS, DEFAULT_BOARD_TITLE, parseBoardMarker, type CardMetadata, type CardStatus } from "./cards";
import { VaultService } from "../bindings/cipherleaf/internal/app";

type LiveMarkdownEditorProps = {
  noteID: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onError: (reason: unknown) => void;
  onOpenWikilink: (title: string) => void;
  onOpenCard?: (id: string) => void;
  cardTitles?: ReadonlyMap<string, string>;
  cardData?: ReadonlyMap<string, CardMetadata>;
  onCreateCard?: () => Promise<string | null>;
  onCreateBoard?: () => Promise<string | null>;
  onMoveCard?: (id: string, status: CardStatus) => void;
  onAddCardToBoard?: (boardID: string) => void;
  onChangeBoardTitle?: (boardID: string, title: string) => void;
  onDecreaseFontSize: () => void;
  onIncreaseFontSize: () => void;
  searchTarget?: SearchTarget | null;
  onSearchTargetApplied?: () => void;
  caretOffset?: number | null;
  caretRestoreVersion?: number;
  onCaretChange?: (offset: number) => void;
  readOnly?: boolean;
  showToolbar?: boolean;
  highlightLineNumbers?: ReadonlySet<number>;
  defaultSectionsCollapsed?: boolean;
};

type LivePreviewState = {
  collapsedQuotes: ReadonlySet<string>;
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  lines: readonly string[];
  objectDocument: ObjectDocument;
};

type ObjectDocumentContext = {
  lines: readonly string[];
  objectDocument: ObjectDocument;
};

const objectDocumentField = StateField.define<ObjectDocumentContext>({
  create(state) {
    const text = state.doc.toString();
    return { lines: text.split("\n"), objectDocument: parseObjectDocument(text) };
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const text = transaction.state.doc.toString();
    return { lines: text.split("\n"), objectDocument: parseObjectDocument(text) };
  },
});

function cachedObjectDocument(state: EditorState): ObjectDocument {
  return state.field(objectDocumentField).objectDocument;
}

const setDeepCodeHighlights = StateEffect.define<DecorationSet>();

const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: tags.function(tags.variableName), color: "var(--syntax-function)" },
  { tag: [tags.typeName, tags.className], color: "var(--syntax-type)" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool], color: "var(--syntax-number)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
]);

const deepCodeHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setDeepCodeHighlights)) value = effect.value;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const deepCodeHighlightLoader = ViewPlugin.fromClass(class {
  private generation = 0;

  constructor(view: EditorView) {
    void this.refresh(view);
  }

  update(update: { docChanged: boolean; view: EditorView }) {
    if (update.docChanged) void this.refresh(update.view);
  }

  destroy() {
    this.generation++;
  }

  private async refresh(view: EditorView) {
    const generation = ++this.generation;
    const source = view.state.doc.toString();
    const codeObjects = parseObjectDocument(source).objects.filter(
      (object) => object.tag === "code" && object.indent >= 4 && object.text && object.language,
    );
    const supports = await Promise.all(codeObjects.map(async (object) => {
      const description = LanguageDescription.matchLanguageName(languages, object.language ?? "");
      return description ? description.load().catch(() => null) : null;
    }));
    if (generation !== this.generation || source !== view.state.doc.toString()) return;

    const decorations: Range<Decoration>[] = [];
    codeObjects.forEach((object, index) => {
      const support = supports[index];
      if (!support || object.lineNumber >= view.state.doc.lines) return;
      const from = view.state.doc.line(object.lineNumber + 1).from;
      if (from >= object.textTo) return;
      decorations.push(Decoration.mark({ class: "cm-live-deep-code" }).range(from, object.textTo));
      const tree = support.language.parser.parse(object.text);
      highlightTree(tree, {
        style: (tags) => highlightingFor(view.state, tags, tree.topNode.type),
      }, (start, end, classes) => {
        if (start < end) decorations.push(Decoration.mark({ class: classes }).range(from + start, from + end));
      });
    });
    view.dispatch({ effects: setDeepCodeHighlights.of(Decoration.set(decorations, true)) });
  }
});

function collapsedStorageKey(noteID: string): string {
  return `cipherleaf-collapsed-sections:${noteID}`;
}

function collapseKeyForPosition(
  state: EditorState,
  position: number,
  objectDocument: ObjectDocument,
): string {
  const line = state.doc.lineAt(position);
  const object = objectDocument.byLine.get(line.number);
  return object ? `object:${object.id}` : `position:${line.from}`;
}

function savedCollapsedPositions(_state: EditorState, noteID: string): Set<string> | null {
  try {
    const saved = window.localStorage.getItem(collapsedStorageKey(noteID));
    if (!saved) return null;
    return new Set(JSON.parse(saved) as string[]);
  } catch {
    return null;
  }
}

function persistCollapsedPositions(_state: EditorState, noteID: string, collapsed: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(collapsedStorageKey(noteID), JSON.stringify([...collapsed]));
  } catch {
    // Best-effort UI state persistence.
  }
}

const externalDocumentUpdate = Annotation.define<boolean>();

function preservedSelection(editor: EditorView, length: number) {
  const selection = editor.state.selection;
  return EditorSelection.create(
    selection.ranges.map((range) => EditorSelection.range(
      Math.min(range.anchor, length),
      Math.min(range.head, length),
    )),
    selection.mainIndex,
  );
}
const toggleQuote = StateEffect.define<number>({
  map: (position, changes) => changes.mapPos(position),
});
const setQuoteCollapsed = StateEffect.define<{ position: number; collapsed: boolean }>({
  map: (value, changes) => ({
    ...value,
    position: changes.mapPos(value.position),
  }),
});
const setAllQuotesCollapsed = StateEffect.define<boolean>();
const locateCaret = StateEffect.define<number>({
  map: (position, changes) => changes.mapPos(position),
});
const caretLocatorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    if (transaction.startState.selection.main.head !== transaction.state.selection.main.head) {
      next = Decoration.none;
    }
    for (const effect of transaction.effects) {
      if (effect.is(locateCaret)) {
        const line = transaction.state.doc.lineAt(effect.value);
        next = Decoration.set([
          Decoration.line({ class: "cm-caret-locator" }).range(line.from),
        ]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function installJournalRules(editor: EditorView) {
  const scroller = editor.scrollDOM;
  const layer = document.createElement("div");
  layer.className = "cm-journal-rules";
  scroller.appendChild(layer);
  let frame = 0;
  const enabled = () => {
    const mode = document.documentElement.dataset.journalLines;
    return mode === "full" || mode === "dotted";
  };

  const render = () => {
    frame = 0;
    if (!enabled()) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const positions: { top: number }[] = [];
    for (const line of editor.dom.querySelectorAll<HTMLElement>(
      ".cm-line:not(.cm-live-attachment-line):not(.cm-live-code-block):not(.cm-live-board-line)",
    )) {
      const lineRect = line.getBoundingClientRect();
      if (lineRect.bottom < scrollerRect.top || lineRect.top > scrollerRect.bottom) continue;

      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const rects: DOMRect[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(...range.getClientRects());
      }
      rects.sort((left, right) => left.top - right.top);
      const rows: { top: number; bottom: number }[] = [];
      for (const rect of rects) {
        const row = rows[rows.length - 1];
        if (row) {
          if (rect.top < row.bottom && rect.bottom > row.top) {
            row.top = Math.min(row.top, rect.top);
            row.bottom = Math.max(row.bottom, rect.bottom);
            continue;
          }
        }
        rows.push({ top: rect.top, bottom: rect.bottom });
      }
      if (rows.length === 0) rows.push({ top: lineRect.top, bottom: lineRect.bottom });

      for (const row of rows) {
        positions.push({
          top: row.bottom - scrollerRect.top + scroller.scrollTop,
        });
      }
    }

    const fragment = document.createDocumentFragment();
    for (const position of positions) {
      const rule = document.createElement("span");
      rule.className = "cm-journal-rule";
      rule.style.top = `${position.top}px`;
      fragment.appendChild(rule);
    }
    layer.replaceChildren(fragment);
  };

  const schedule = () => {
    if (!enabled()) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (layer.childElementCount) layer.replaceChildren();
      return;
    }
    if (!frame) frame = requestAnimationFrame(render);
  };
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(scroller);
  const themeObserver = new MutationObserver(schedule);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-journal-lines", "data-editor-font", "data-theme", "style"],
  });
  scroller.addEventListener("scroll", schedule, { passive: true });
  schedule();

  return {
    schedule,
    destroy() {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      scroller.removeEventListener("scroll", schedule);
      layer.remove();
    },
  };
}

const liveMarkdownTheme = EditorView.theme(
  {
    "&": {
      "--toggle-button-width": "0.8em",
    },

    ".cm-line.cm-live-toggle-line": {
      boxSizing: "border-box",
      backgroundColor: "transparent",
      paddingLeft: "var(--toggle-padding-left, 0px)",
      paddingTop: "var(--editor-line-spacing)",
      paddingBottom: "var(--editor-line-spacing)",
    },

    ".cm-live-toggle-button": {
      display: "inline-flex",
      width: "var(--toggle-button-width)",
      justifyContent: "flex-start",
      alignItems: "center",
      verticalAlign: "baseline",
      background: "transparent",
      border: "0",
      color: "inherit",
      cursor: "pointer",
      padding: "0",
      font: "inherit",
      lineHeight: "inherit",
      opacity: "0.9",
    },

    ".cm-live-toggle-button:hover": {
      backgroundColor: "color-mix(in srgb, var(--ink) 14%, transparent)",
      borderRadius: "3px",
    },

    ".cm-live-toggle-button.is-empty": {
      cursor: "default",
      color: "var(--green)",
      opacity: "1",
    },

    ".cm-live-toggle-button.is-empty:hover": {
      backgroundColor: "transparent",
    },

    ".cm-live-toggle-button:disabled": {
      color: "inherit",
    },

    ".cm-live-folded-toggle": {
      display: "none",
    },
  },
);

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
  ) {
    super();
  }

  eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = this.className;
    element.textContent = this.text;
    return element;
  }
}

class InlineSpacerWidget extends WidgetType {
  constructor(readonly width: string) {
    super();
  }

  eq(other: InlineSpacerWidget) {
    return other.width === this.width;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-live-indent-spacer";
    element.style.width = this.width;
    return element;
  }
}

class HorizontalRuleWidget extends WidgetType {
  constructor(readonly position: number) {
    super();
  }

  eq(other: HorizontalRuleWidget) {
    return other.position === this.position;
  }

  toDOM(view: EditorView) {
    const rule = document.createElement("span");
    rule.className = "cm-live-horizontal-rule";
    rule.setAttribute("role", "separator");
    rule.title = "Click to edit the Markdown divider";
    rule.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.position } });
      view.focus();
    });
    return rule;
  }

  ignoreEvent() {
    return true;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly checkPosition: number,
    readonly empty: boolean,
  ) {
    super();
  }

  eq(other: TaskWidget) {
    return other.checked === this.checked &&
      other.checkPosition === this.checkPosition &&
      other.empty === this.empty;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-live-task";
    const checkbox = wrapper.appendChild(document.createElement("input"));
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    checkbox.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        changes: {
          from: this.checkPosition,
          to: this.checkPosition + 1,
          insert: this.checked ? " " : this.empty ? "x]" : "x",
        },
      });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent() {
    return true;
  }
}

class FoldedQuoteWidget extends WidgetType {
  constructor(readonly hiddenLines: number) {
    super();
  }

  eq(other: FoldedQuoteWidget) {
    return other.hiddenLines === this.hiddenLines;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-live-folded-toggle";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}

class DragHandleWidget extends WidgetType {
  constructor(readonly lineNumber: number) {
    super();
  }

  eq(other: DragHandleWidget) {
    return other.lineNumber === this.lineNumber;
  }

  toDOM() {
    const handle = document.createElement("span");
    handle.className = "cm-live-object-handle";
    handle.dataset.objectLine = String(this.lineNumber);
    handle.title = "Drag object";
    handle.setAttribute("aria-label", "Drag object");
    for (let index = 0; index < 6; index++) {
      const dot = document.createElement("span");
      dot.setAttribute("aria-hidden", "true");
      handle.append(dot);
    }
    return handle;
  }

  ignoreEvent() {
    return false;
  }
}

class CopyCodeWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  eq(other: CopyCodeWidget) {
    return other.code === this.code;
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-live-code-copy";
    button.textContent = "Copy";
    button.title = "Copy code";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard.writeText(this.code).then(() => {
        button.textContent = "Copied";
        window.setTimeout(() => { button.textContent = "Copy"; }, 1200);
      }).catch(() => { button.textContent = "Copy failed"; });
    });
    return button;
  }

  ignoreEvent() {
    return true;
  }
}

class QuoteToggleWidget extends WidgetType {
  constructor(
    readonly position: number,
    readonly collapsed: boolean,
    readonly empty: boolean,
  ) {
    super();
  }

  eq(other: QuoteToggleWidget) {
    return other.position === this.position &&
      other.collapsed === this.collapsed &&
      other.empty === this.empty;
  }

  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "cm-live-toggle-button",
      this.empty ? "" : "disclosure-chevron",
      this.collapsed ? "is-collapsed" : "is-expanded",
      this.empty ? "is-empty" : "",
    ].filter(Boolean).join(" ");

    button.setAttribute(
      "aria-label",
      this.empty
        ? "Bullet point"
        : this.collapsed
          ? "Expand section"
          : "Collapse section",
    );

    if (!this.empty) {
      button.setAttribute("aria-expanded", String(!this.collapsed));
    }
    button.title = this.empty
      ? "Bullet point"
      : this.collapsed
        ? "Expand section"
        : "Collapse section";

    button.textContent = this.empty ? "•" : "";

    if (this.empty) {
      button.disabled = true;
      return button;
    }

    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: toggleQuote.of(this.position) });
      view.focus();
    });

    return button;
  }

  ignoreEvent() {
    return true;
  }
}

class TableWidget extends WidgetType {
  constructor(readonly rows: string[][]) {
    super();
  }

  eq(other: TableWidget) {
    return JSON.stringify(other.rows) === JSON.stringify(this.rows);
  }

  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-live-table-wrap";
    const table = wrapper.appendChild(document.createElement("table"));
    const [head, ...body] = this.rows;
    const thead = table.appendChild(document.createElement("thead"));
    const headRow = thead.appendChild(document.createElement("tr"));
    for (const cell of head) {
      const th = headRow.appendChild(document.createElement("th"));
      th.textContent = cell;
    }
    const tbody = table.appendChild(document.createElement("tbody"));
    for (const row of body) {
      const tr = tbody.appendChild(document.createElement("tr"));
      for (let index = 0; index < head.length; index++) {
        const td = tr.appendChild(document.createElement("td"));
        td.textContent = row[index] ?? "";
      }
    }
    return wrapper;
  }
}

async function copyImageToClipboard(image: HTMLImageElement) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Copying images is not supported by this system");
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare image for copying");
  context.drawImage(image, 0, 0);
  const blob = new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("Could not prepare image for copying")),
      "image/png",
    );
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

const attachmentDataCache = new Map<string, string>();
const attachmentDataRequests = new Map<string, Promise<string>>();
const maxAttachmentCacheBytes = 32 * 1024 * 1024;
let attachmentCacheBytes = 0;
let attachmentCacheGeneration = 0;

function attachmentCacheKey(noteID: string, attachmentID: string) {
  return `${noteID}:${attachmentID}`;
}

function rememberAttachmentData(key: string, data: string) {
  const previous = attachmentDataCache.get(key);
  if (previous !== undefined) attachmentCacheBytes -= previous.length * 2;
  attachmentDataCache.delete(key);
  attachmentDataCache.set(key, data);
  attachmentCacheBytes += data.length * 2;
  while (attachmentCacheBytes > maxAttachmentCacheBytes) {
    const oldest = attachmentDataCache.keys().next().value;
    if (oldest === undefined) break;
    attachmentCacheBytes -= (attachmentDataCache.get(oldest)?.length ?? 0) * 2;
    attachmentDataCache.delete(oldest);
  }
}

function clearAttachmentDataCache() {
  attachmentCacheGeneration++;
  attachmentCacheBytes = 0;
  attachmentDataCache.clear();
  attachmentDataRequests.clear();
}

function cachedAttachmentData(noteID: string, attachmentID: string) {
  const key = attachmentCacheKey(noteID, attachmentID);
  const cached = attachmentDataCache.get(key);
  if (cached !== undefined) {
    attachmentDataCache.delete(key);
    attachmentDataCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const pending = attachmentDataRequests.get(key);
  if (pending) return pending;
  const generation = attachmentCacheGeneration;
  const request = VaultService.GetAttachment(noteID, attachmentID)
    .then((data) => {
      if (generation === attachmentCacheGeneration) rememberAttachmentData(key, data);
      return data;
    })
    .finally(() => {
      if (attachmentDataRequests.get(key) === request) attachmentDataRequests.delete(key);
    });
  attachmentDataRequests.set(key, request);
  return request;
}

class AttachmentWidget extends WidgetType {
  constructor(
    readonly noteID: string,
    readonly attachmentID: string,
    readonly alt: string,
    readonly width: number,
    readonly align: "left" | "center" | "right",
    readonly from: number,
    readonly to: number,
    readonly onError: (reason: unknown) => void,
    readonly selected = false,
  ) {
    super();
  }

  eq(other: AttachmentWidget) {
    return other.noteID === this.noteID &&
      other.attachmentID === this.attachmentID &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.align === this.align &&
      other.selected === this.selected;
  }

  toDOM(view: EditorView) {
    const figure = document.createElement("span");
    figure.className = `cm-live-attachment align-${this.align}${this.selected ? " is-selected" : ""}`;
    const image = figure.appendChild(document.createElement("img"));
    image.alt = this.alt;
    image.style.width = `${this.width}px`;
    image.style.maxWidth = "100%";
    image.draggable = false;
    figure.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      document.querySelectorAll<HTMLElement>(".cm-live-attachment.is-selected").forEach((item) => item.classList.remove("is-selected"));
      figure.classList.add("is-selected");
    });
    image.setAttribute("aria-busy", "true");
    void cachedAttachmentData(this.noteID, this.attachmentID)
      .then((data) => {
        image.src = `data:image/webp;base64,${data}`;
        image.removeAttribute("aria-busy");
      })
      .catch(() => {
        image.alt = `${this.alt} (image unavailable)`;
        image.removeAttribute("aria-busy");
      });

    const resizeHandle = figure.appendChild(document.createElement("span"));
    resizeHandle.className = "cm-live-attachment-resize";
    resizeHandle.title = "Drag to resize image";
    resizeHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = image.getBoundingClientRect().width;
      let width = Math.round(startWidth);
      const move = (moveEvent: PointerEvent) => {
        width = Math.max(120, Math.min(2400, Math.round(startWidth + moveEvent.clientX - startX)));
        image.style.width = `${width}px`;
      };
      const finish = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        if (width !== this.width) {
          view.dispatch({
            changes: {
              from: this.from,
              to: this.to,
              insert: attachmentMarkdown(this.attachmentID, width, this.alt, this.align),
            },
            scrollIntoView: false,
          });
        }
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", finish);
      document.addEventListener("pointercancel", finish);
    });

    figure.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector(".cm-live-attachment-menu")?.remove();
      const menu = document.body.appendChild(document.createElement("div"));
      menu.className = "cm-live-attachment-menu";
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;
      const close = (closeEvent?: PointerEvent) => {
        if (closeEvent && menu.contains(closeEvent.target as Node)) return;
        menu.remove();
        document.removeEventListener("pointerdown", close);
      };
      const copy = menu.appendChild(document.createElement("button"));
      copy.type = "button";
      copy.textContent = "Copy as image";
      copy.addEventListener("click", () => {
        close();
        void copyImageToClipboard(image).catch(this.onError);
      });
      for (const align of ["left", "center", "right"] as const) {
        const alignButton = menu.appendChild(document.createElement("button"));
        alignButton.type = "button";
        alignButton.textContent = align === "left"
          ? "Align left"
          : align === "center"
            ? "Align center"
            : "Align right";
        alignButton.disabled = align === this.align;
        alignButton.addEventListener("click", () => {
          close();
          view.dispatch({
            changes: {
              from: this.from,
              to: this.to,
              insert: attachmentMarkdown(this.attachmentID, this.width, this.alt, align),
            },
            scrollIntoView: false,
          });
          view.focus();
        });
      }
      const remove = menu.appendChild(document.createElement("button"));
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => {
        close();
        view.dispatch({
          changes: {
            from: this.from,
            to: this.to,
            insert: "",
          },
          scrollIntoView: false,
        });
        view.focus();
      });
      queueMicrotask(() => document.addEventListener("pointerdown", close));
    });
    return figure;
  }

  ignoreEvent() {
    return true;
  }
}

class WikilinkWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly position: number,
    readonly open: (title: string) => void,
  ) {
    super();
  }

  eq(other: WikilinkWidget) {
    return other.title === this.title && other.position === this.position;
  }

  toDOM(_view: EditorView) {
    const label = this.title.split("|")[0]?.trim() || this.title;
    const link = document.createElement("span");
    link.className = "cm-live-wikilink";
    link.textContent = label;
    link.title = `Open “${label}”`;
    link.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.open(this.title);
    });
    return link;
  }

  ignoreEvent() {
    return true;
  }
}

class CitationWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly url: string,
    readonly from: number,
    readonly to: number,
    readonly onError: (reason: unknown) => void,
  ) {
    super();
  }

  eq(other: CitationWidget) {
    return other.label === this.label && other.url === this.url &&
      other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "cm-live-citation";
    link.textContent = this.label;
    link.title = this.url;
    link.setAttribute("aria-haspopup", "menu");
    link.addEventListener("mousedown", (event) => event.preventDefault());
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector(".cm-live-attachment-menu")?.remove();
      const menu = document.body.appendChild(document.createElement("div"));
      menu.className = "cm-live-attachment-menu cm-live-link-menu";
      menu.setAttribute("role", "menu");
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;
      const close = (closeEvent?: PointerEvent) => {
        if (closeEvent && menu.contains(closeEvent.target as Node)) return;
        menu.remove();
        document.removeEventListener("pointerdown", close);
      };
      for (const [label, action] of [
        ["Open link", () => Browser.OpenURL(this.url)],
        ["Copy link", () => Clipboard.SetText(this.url)],
      ] as const) {
        const button = menu.appendChild(document.createElement("button"));
        button.type = "button";
        button.role = "menuitem";
        button.textContent = label;
        button.addEventListener("click", () => {
          close();
          void action().catch(this.onError);
        });
      }
      const edit = menu.appendChild(document.createElement("button"));
      edit.type = "button";
      edit.role = "menuitem";
      edit.textContent = "Edit link";
      edit.addEventListener("click", () => {
        close();
        document.querySelector(".cm-live-link-dialog")?.remove();
        const dialog = document.body.appendChild(document.createElement("dialog"));
        dialog.className = "vault-modal cm-live-link-dialog";
        dialog.setAttribute("aria-labelledby", "edit-link-title");
        const form = dialog.appendChild(document.createElement("form"));
        const title = form.appendChild(document.createElement("h2"));
        title.id = "edit-link-title";
        title.textContent = "Edit link";
        const nameLabel = form.appendChild(document.createElement("label"));
        nameLabel.append("Name");
        const name = nameLabel.appendChild(document.createElement("input"));
        name.value = this.label;
        const urlLabel = form.appendChild(document.createElement("label"));
        urlLabel.append("Link");
        const url = urlLabel.appendChild(document.createElement("input"));
        url.inputMode = "url";
        url.value = this.url;
        const error = form.appendChild(document.createElement("p"));
        error.className = "cm-live-link-dialog-error";
        error.setAttribute("aria-live", "polite");
        const actions = form.appendChild(document.createElement("div"));
        actions.className = "app-dialog-actions";
        const cancel = actions.appendChild(document.createElement("button"));
        cancel.type = "button";
        cancel.className = "secondary-button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => dialog.close());
        const save = actions.appendChild(document.createElement("button"));
        save.type = "submit";
        save.className = "primary-button";
        save.textContent = "Save";
        form.addEventListener("submit", (submitEvent) => {
          submitEvent.preventDefault();
          const markdown = markdownCitation(name.value, url.value);
          if (!markdown) {
            error.textContent = "Enter a name and a valid HTTP(S) link or local path.";
            return;
          }
          view.dispatch({ changes: { from: this.from, to: this.to, insert: markdown } });
          dialog.close();
          view.focus();
        });
        dialog.addEventListener("close", () => dialog.remove());
        dialog.showModal();
        name.select();
      });
      queueMicrotask(() => document.addEventListener("pointerdown", close));
    });
    return link;
  }

  ignoreEvent() {
    return true;
  }
}

class CardReferenceWidget extends WidgetType {
  constructor(readonly id: string, readonly title: string, readonly open: (id: string) => void) { super(); }

  eq(other: CardReferenceWidget) {
    return other.id === this.id && other.title === this.title;
  }

  toDOM() {
    const link = document.createElement("span");
    link.className = "cm-live-card-reference";
    link.textContent = this.title || "Untitled";
    link.title = `Open card “${this.title || "Untitled"}”`;
    link.setAttribute("role", "link");
    link.tabIndex = 0;
    const activate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.open(this.id);
    };
    link.addEventListener("mousedown", activate);
    link.addEventListener("click", (event) => event.stopPropagation());
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    return link;
  }

  ignoreEvent() { return true; }
}

const boardCardMime = "application/x-cipherleaf-board-card";

class BoardWidget extends WidgetType {
  constructor(
    readonly boardID: string,
    readonly title: string,
    readonly cardIDs: readonly string[],
    readonly cards: ReadonlyMap<string, CardMetadata>,
    readonly openCard: (id: string) => void,
    readonly moveCard: (id: string, status: CardStatus) => void,
    readonly addCard: (boardID: string) => void,
    readonly changeTitle: (boardID: string, title: string) => void,
  ) { super(); }

  eq(other: BoardWidget) {
    return other.boardID === this.boardID && other.title === this.title && JSON.stringify(other.cardIDs) === JSON.stringify(this.cardIDs);
  }

  toDOM() {
    const board = document.createElement("section");
    board.className = "cm-live-board";
    const title = board.appendChild(document.createElement("input"));
    title.className = "cm-live-board-title";
    title.type = "text";
    title.value = this.title || DEFAULT_BOARD_TITLE;
    title.setAttribute("aria-label", "Board title");
    const stopEditorEvent = (event: Event) => event.stopPropagation();
    for (const eventName of ["mousedown", "click", "input", "change"])
      title.addEventListener(eventName, stopEditorEvent);
    title.addEventListener("change", () => this.changeTitle(this.boardID, title.value));
    title.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        title.blur();
      }
    });
    board.setAttribute("aria-label", title.value);
    const controls = board.appendChild(document.createElement("div"));
    controls.className = "cm-live-board-controls";
    const filter = controls.appendChild(document.createElement("input"));
    filter.type = "search";
    filter.placeholder = "Filter cards by title";
    filter.setAttribute("aria-label", "Filter board cards by title");
    const tagFilter = controls.appendChild(document.createElement("input"));
    tagFilter.type = "search";
    tagFilter.placeholder = "Filter tags";
    tagFilter.setAttribute("aria-label", "Filter board cards by tags");
    const add = controls.appendChild(document.createElement("button"));
    add.type = "button";
    add.className = "secondary-button";
    add.textContent = "New card";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      this.addCard(this.boardID);
    });
    const clear = controls.appendChild(document.createElement("button"));
    clear.type = "button";
    clear.className = "secondary-button";
    clear.textContent = "Clear";
    clear.addEventListener("click", (event) => {
      event.stopPropagation();
      filter.value = "";
      tagFilter.value = "";
      render();
    });
    const columns = board.appendChild(document.createElement("div"));
    columns.className = "cm-live-board-columns";
    const render = () => {
      columns.replaceChildren();
      const titleQuery = filter.value.trim().toLocaleLowerCase();
      const requiredTags = tagFilter.value.split(",");
      for (const status of BOARD_COLUMNS) {
        const column = columns.appendChild(document.createElement("div"));
        column.className = `cm-live-board-column status-${status}`;
        column.dataset.status = status;
        column.setAttribute("role", "group");
        column.setAttribute("aria-label", BOARD_COLUMN_LABELS[status]);
        column.addEventListener("dragover", (event) => event.preventDefault());
        column.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const id = event.dataTransfer?.getData("text/plain");
          if (id) this.moveCard(id, status);
        });
        const heading = column.appendChild(document.createElement("h4"));
        heading.textContent = BOARD_COLUMN_LABELS[status];
        const cards = boardCardsForColumn(this.cards, this.cardIDs, status, titleQuery, requiredTags);
        if (cards.length === 0) {
          const empty = column.appendChild(document.createElement("p"));
          empty.className = "cm-live-board-empty";
          empty.textContent = "No cards";
        }
        for (const card of cards) {
          const item = column.appendChild(document.createElement("button"));
          item.type = "button";
          item.className = "cm-live-board-card";
          item.draggable = true;
          item.textContent = card.title || "Untitled";
          item.title = `Open card “${card.title || "Untitled"}”`;
          item.addEventListener("dragstart", (event) => {
            event.dataTransfer?.setData("text/plain", card.id);
            event.dataTransfer?.setData(boardCardMime, card.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          });
          item.addEventListener("click", (event) => {
            event.stopPropagation();
            this.openCard(card.id);
          });
          item.setAttribute("aria-label", `${card.title || "Untitled"}, ${BOARD_COLUMN_LABELS[status]}`);
          item.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const index = BOARD_COLUMNS.indexOf(status);
            const nextIndex = index + (event.key === "ArrowRight" ? 1 : -1);
            if (nextIndex < 0 || nextIndex >= BOARD_COLUMNS.length) return;
            event.preventDefault();
            this.moveCard(card.id, BOARD_COLUMNS[nextIndex]);
          });
          const date = status === "not-started" ? card.createdAt
            : status === "in-progress" ? card.startedAt
              : status === "blocked" ? card.blockedOn
                : card.finishedAt;
          if (date) item.append(` · ${new Date(date).toLocaleDateString()}`);
        }
      }
    };
    filter.addEventListener("input", render);
    tagFilter.addEventListener("input", render);
    render();
    return board;
  }

  ignoreEvent() { return true; }
}

function rangeTouchesBoard(state: EditorState, from: number, to: number): boolean {
  const firstLine = state.doc.lineAt(from).number;
  const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    if (parseBoardMarker(state.doc.line(lineNumber).text)) return true;
  }
  return false;
}

function lineIsActive(state: EditorState, lineNumber: number): boolean {
  return state.selection.ranges.some((range) => {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    return lineNumber >= startLine && lineNumber <= endLine;
  });
}

function selectionStaysOnSameLines(before: EditorState, after: EditorState): boolean {
  if (before.selection.ranges.length !== after.selection.ranges.length) return false;
  return before.selection.ranges.every((range, index) => {
    const next = after.selection.ranges[index];
    return before.doc.lineAt(range.from).number === after.doc.lineAt(next.from).number &&
      before.doc.lineAt(range.to).number === after.doc.lineAt(next.to).number;
  });
}

function addHiddenRange(
  from: number,
  to: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
  widget?: WidgetType,
) {
  if (to <= from) return;
  const replacement = Decoration.replace(widget ? { widget } : {});
  const range = replacement.range(from, to);
  decorations.push(range);
  atomicRanges.push(range);
}

function hideSyntaxRange(
  from: number,
  to: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  addHiddenRange(from, to, decorations, atomicRanges);
}

function decorateInlineMarkdown(
  text: string,
  offset: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
  openWikilink: (title: string) => void,
  openCard: (id: string) => void,
  cardTitle: (id: string) => string | null,
  onError: (reason: unknown) => void,
) {
  const bold = /(\*\*|__)(?=\S)(.+?\S)\1/g;
  for (const match of text.matchAll(bold)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const markerSize = match[1].length;
    const end = start + match[0].length;
    decorations.push(
      Decoration.mark({ class: "cm-live-strong" }).range(start + markerSize, end - markerSize),
    );
    hideSyntaxRange(start, start + markerSize, decorations, atomicRanges);
    hideSyntaxRange(end - markerSize, end, decorations, atomicRanges);
  }

  const italic = /(?<![\p{L}\p{N}_])_(?=\S)([^\s_]+)_(?![\p{L}\p{N}_])/gu;
  for (const match of text.matchAll(italic)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const end = start + match[0].length;
    decorations.push(Decoration.mark({ class: "cm-live-em" }).range(start + 1, end - 1));
    hideSyntaxRange(start, start + 1, decorations, atomicRanges);
    hideSyntaxRange(end - 1, end, decorations, atomicRanges);
  }

  const asteriskItalic = /(?<![\p{L}\p{N}*])\*(?!\*)(?=\S)(.+?\S)\*(?![\p{L}\p{N}*])/gu;
  for (const match of text.matchAll(asteriskItalic)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const end = start + match[0].length;
    decorations.push(Decoration.mark({ class: "cm-live-em" }).range(start + 1, end - 1));
    hideSyntaxRange(start, start + 1, decorations, atomicRanges);
    hideSyntaxRange(end - 1, end, decorations, atomicRanges);
  }

  const inlineCode = /`([^`\n]+)`/g;
  for (const match of text.matchAll(inlineCode)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const end = start + match[0].length;
    decorations.push(Decoration.mark({ class: "cm-live-code" }).range(start + 1, end - 1));
    hideSyntaxRange(start, start + 1, decorations, atomicRanges);
    hideSyntaxRange(end - 1, end, decorations, atomicRanges);
  }

  const strike = /~~(?=\S)(.+?\S)~~/g;
  for (const match of text.matchAll(strike)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const end = start + match[0].length;
    decorations.push(Decoration.mark({ class: "cm-live-strike" }).range(start + 2, end - 2));
    hideSyntaxRange(start, start + 2, decorations, atomicRanges);
    hideSyntaxRange(end - 2, end, decorations, atomicRanges);
  }

  const wikilinks = /\[\[([^\]\n]+)\]\]/g;
  for (const match of text.matchAll(wikilinks)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const end = start + match[0].length;
    addHiddenRange(
      start,
      end,
      decorations,
      atomicRanges,
      new WikilinkWidget(match[1], start, openWikilink),
    );
  }

  for (const match of text.matchAll(/(?<!\!)\[card\]\(([a-f0-9]{32})\)/gi)) {
    if (match.index === undefined) continue;
    const title = cardTitle(match[1]);
    if (title === null) continue;
    const start = offset + match.index;
    addHiddenRange(
      start,
      start + match[0].length,
      decorations,
      atomicRanges,
      new CardReferenceWidget(match[1], title, openCard),
    );
  }

  for (const citation of markdownCitations(text)) {
    if (/^\[card\]\([a-f0-9]{32}\)$/i.test(text.slice(citation.index, citation.index + citation.length))) continue;
    const start = offset + citation.index;
    addHiddenRange(
      start,
      start + citation.length,
      decorations,
      atomicRanges,
      new CitationWidget(citation.label, citation.url, start, start + citation.length, onError),
    );
  }
}

function decorateUnorderedListMarker(
  from: number,
  marker: "-" | "*",
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
  to = from + 1,
) {
  addHiddenRange(
    from,
    to,
    decorations,
    atomicRanges,
    new TextWidget(marker === "*" ? "•" : "-", "cm-live-list-symbol"),
  );
}

function decorateObjectTask(
  object: ObjectLine,
  syntaxFrom: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
): boolean {
  if (object.checked === undefined) return false;
  const bracketOffset = object.sourcePrefix.lastIndexOf("[");
  if (bracketOffset < 0) return false;
  const bracketFrom = object.from + bracketOffset;
  if (object.listMarker) {
    decorateObjectListMarker(object, syntaxFrom, decorations, atomicRanges, bracketFrom);
  } else if (object.barePrefixSize > 0) {
    addHiddenRange(syntaxFrom, bracketFrom, decorations, atomicRanges);
  }
  const taskFrom = object.listMarker || object.barePrefixSize > 0 ? bracketFrom : syntaxFrom;
  addHiddenRange(
    taskFrom,
    object.textFrom,
    decorations,
    atomicRanges,
    new TaskWidget(
      object.checked,
      bracketFrom + 1,
      object.sourcePrefix.slice(bracketOffset, bracketOffset + 2) === "[]",
    ),
  );
  return true;
}

function decorateObjectListMarker(
  object: ObjectLine,
  syntaxFrom: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
  to = object.textFrom,
): "unordered" | "ordered" | null {
  const marker = object.listMarker;
  if (!marker) return null;
  if (marker === "-" || marker === "*") {
    decorateUnorderedListMarker(syntaxFrom, marker, decorations, atomicRanges, to);
    return "unordered";
  }
  addHiddenRange(
    syntaxFrom,
    to,
    decorations,
    atomicRanges,
    new TextWidget(marker, "cm-live-list-marker"),
  );
  return "ordered";
}

type ToggleLine = {
  prefixSize: number;
  content: string;
  object: ObjectLine;
};

function continuationOwnerObject(document: ObjectDocument, lineNumber: number) {
  const owner = document.byLine.get(lineNumber);
  return owner && owner.lineNumber !== lineNumber ? owner : null;
}

function continuationPrefixSizeForIndent(raw: string, targetIndent: number): number {
  let offset = 0;
  let column = 0;

  while (offset < raw.length && column < targetIndent) {
    const character = raw[offset];
    if (character !== " " && character !== "\t") break;
    column += character === "\t" ? 2 : 1;
    offset++;
  }

  return offset;
}

function continuationMarkerWidth(document: ObjectDocument, ownerLineNumber: number): string | null {
  const owner = document.byLine.get(ownerLineNumber);
  if (!owner) return null;

  const widths: string[] = [];
  if (owner.tag === "section") widths.push("var(--toggle-button-width)");
  if (owner.checked !== undefined) widths.push("1.45em");
  else if (owner.tag === "bulletpoint") widths.push("1.6em");

  return widths.length > 0 ? `calc(${widths.join(" + ")})` : null;
}

function toggleLine(document: ObjectDocument, lineNumber: number, text: string): ToggleLine | null {
  const object = document.byLine.get(lineNumber);
  if (!object || object.lineNumber !== lineNumber || !object.tags.includes("section")) return null;
  return {
    prefixSize: object.sectionPrefixSize,
    content: text.slice(object.sectionPrefixSize),
    object,
  };
}

function toggleLineStyle(): string {
  return "--toggle-padding-left: calc(var(--live-object-depth, 0) * 24px);";
}

function listLineStyle(): string {
  return "--live-list-indent: calc(var(--live-object-depth, 0) * 24px);";
}

function objectLineAttributes(
  lineNumber: number,
  className = "",
  style?: string,
  depth = 0,
): Record<string, string> {
  const depthStyle = `--live-object-depth: ${depth};`;
  return {
    class: ["cm-live-object-line", className].filter(Boolean).join(" "),
    "data-object-line": String(lineNumber),
    style: style ? `${depthStyle} ${style}` : depthStyle,
  };
}

function objectTreeEnd(object: ObjectLine): number {
  return object.children.reduce(
    (end, child) => Math.max(end, objectTreeEnd(child)),
    object.lineEnd,
  );
}

function toggleSectionEnd(document: ObjectDocument, lineNumber: number): number {
  const object = document.byLine.get(lineNumber);
  const section = object?.lineNumber === lineNumber && object?.tags.includes("section") ? object : null;
  return section ? objectTreeEnd(section) : lineNumber;
}

function toggleHasChildren(toggle: ToggleLine): boolean {
  return toggle.object.children.length > 0;
}

function headingLevel(text: string): number | null {
  const match = /^(#{1,6})\s+/.exec(text);
  return match ? match[1].length : null;
}

function headingSectionEnd(
  state: EditorState,
  startLineNumber: number,
  startLevel: number,
): number {
  let endLineNumber = startLineNumber;

  for (
    let lineNumber = startLineNumber + 1;
    lineNumber <= state.doc.lines;
    lineNumber++
  ) {
    const line = state.doc.line(lineNumber);
    const level = headingLevel(line.text);
    if (level !== null && level <= startLevel) break;
    endLineNumber = lineNumber;
  }

  return endLineNumber;
}

function headingHasChildren(
  state: EditorState,
  lineNumber: number,
  level: number,
): boolean {
  return headingSectionEnd(state, lineNumber, level) > lineNumber;
}

function collapsibleQuotePositions(
  state: EditorState,
  objectDocument: ObjectDocument,
): number[] {
  const positions: number[] = [];

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const toggle = toggleLine(objectDocument, lineNumber, line.text);
    const level = headingLevel(line.text);

    if (toggle && toggleHasChildren(toggle)) {
      positions.push(line.from);
      continue;
    }

    if (level !== null && headingHasChildren(state, lineNumber, level)) {
      positions.push(line.from);
    }
  }

  return positions;
}

function expandToggleTree(
  state: EditorState,
  objectDocument: ObjectDocument,
  position: number,
  collapsed: Set<string>,
) {
  const line = state.doc.lineAt(position);
  const toggle = toggleLine(objectDocument, line.number, line.text);
  const level = headingLevel(line.text);

  if (line.from !== position) {
    collapsed.delete(collapseKeyForPosition(state, position, objectDocument));
    return;
  }

  const endLineNumber = toggle
    ? toggleSectionEnd(objectDocument, line.number)
    : level !== null
      ? headingSectionEnd(state, line.number, level)
      : line.number;
  for (
    let lineNumber = line.number;
    lineNumber <= endLineNumber;
    lineNumber++
  ) {
    collapsed.delete(collapseKeyForPosition(state, state.doc.line(lineNumber).from, objectDocument));
  }
}

function buildLivePreviewState(
  state: EditorState,
  collapsedQuotes: ReadonlySet<string>,
  openWikilink: (title: string) => void,
  openCard: (id: string) => void,
  cardTitle: (id: string) => string | null,
  cards: ReadonlyMap<string, CardMetadata>,
  moveCard: (id: string, status: CardStatus) => void,
  addCard: (boardID: string) => void,
  changeBoardTitle: (boardID: string, title: string) => void,
  noteID: string,
  onError: (reason: unknown) => void,
  highlightLineNumbers: ReadonlySet<number>,
  context?: ObjectDocumentContext,
): LivePreviewState {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const nextCollapsed = new Set(collapsedQuotes);
  const prepared = context ?? (() => {
    const docText = state.doc.toString();
    return {
      lines: docText.split("\n"),
      objectDocument: parseObjectDocument(docText),
    };
  })();
  const { lines, objectDocument } = prepared;
  const depthByLine = objectDepthByLine(objectDocument);
  const lineAttributes = (lineNumber: number, className = "", style?: string) =>
    objectLineAttributes(
      lineNumber,
      [className, highlightLineNumbers.has(lineNumber) ? "cm-live-conflict-diff" : ""].filter(Boolean).join(" "),
      style,
      depthByLine.get(lineNumber) ?? 0,
    );

  for (let lineNumber = 1; lineNumber <= state.doc.lines;) {
    const line = state.doc.line(lineNumber);
    const lineObject = objectDocument.byLine.get(lineNumber);
    const toggle = toggleLine(objectDocument, lineNumber, line.text);
    const continuationOwner = continuationOwnerObject(objectDocument, lineNumber);

    const board = parseBoardMarker(line.text);
    if (board) {
      decorations.push(
        Decoration.line({ attributes: { class: "cm-live-board-line" } }).range(line.from),
        Decoration.widget({
          widget: new DragHandleWidget(lineNumber),
          side: -1,
        }).range(line.from),
      );
      addHiddenRange(
        line.from,
        line.to,
        decorations,
        atomicRanges,
        new BoardWidget(board.id, board.title, board.cardIDs, cards, openCard, moveCard, addCard, changeBoardTitle),
      );
      lineNumber++;
      continue;
    }

    if (objectDocument.byLine.get(lineNumber)?.lineNumber === lineNumber && !continuationOwner) {
      decorations.push(
        Decoration.widget({
          widget: new DragHandleWidget(lineNumber),
          side: -1,
        }).range(line.from),
      );
    }

    const codeObject = objectDocument.byLine.get(lineNumber);
    if (codeObject?.tag === "code") {
      const edge = lineNumber === codeObject.lineNumber
        ? "cm-live-code-fence-open"
        : lineNumber > codeObject.textLineEnd
          ? "cm-live-code-fence-close"
          : "cm-live-code-content";
      decorations.push(Decoration.line({
        attributes: lineAttributes(lineNumber, `cm-live-code-block ${edge}`),
      }).range(line.from));
      if (edge !== "cm-live-code-content") {
        const indentation = line.text.length - line.text.trimStart().length;
        hideSyntaxRange(line.from, line.from + indentation, decorations, atomicRanges);
      }
      if (lineNumber === codeObject.lineNumber) {
        const languageFrom = line.text.indexOf(codeObject.language ?? "");
        if (languageFrom >= 0 && codeObject.language) {
          decorations.push(Decoration.mark({ class: "cm-live-code-language" }).range(
            line.from + languageFrom,
            line.from + languageFrom + codeObject.language.length,
          ));
        }
        decorations.push(Decoration.widget({
          widget: new CopyCodeWidget(codeObject.text),
          side: 1,
        }).range(line.to));
      }
      lineNumber++;
      continue;
    }

    if (
      lineNumber < state.doc.lines &&
      line.text.includes("|") &&
      isTableDivider(state.doc.line(lineNumber + 1).text)
    ) {
      let lastLineNumber = lineNumber + 1;
      while (
        lastLineNumber < state.doc.lines &&
        state.doc.line(lastLineNumber + 1).text.includes("|") &&
        state.doc.line(lastLineNumber + 1).text.trim() !== ""
      ) {
        lastLineNumber++;
      }
      const active = state.selection.ranges.some((range) =>
        range.to >= line.from && range.from <= state.doc.line(lastLineNumber).to,
      );
      if (!active) {
        const rows = [tableCells(line.text)];
        for (let row = lineNumber + 2; row <= lastLineNumber; row++) {
          rows.push(tableCells(state.doc.line(row).text));
        }
        addHiddenRange(
          line.from,
          state.doc.line(lastLineNumber).to,
          decorations,
          atomicRanges,
          new TableWidget(rows),
        );
        lineNumber = lastLineNumber + 1;
        continue;
      }
    }

    const attachment = parseAttachmentMarkdown(line.text);
    if (attachment) {
      decorations.push(
        Decoration.line({
          attributes: lineAttributes(lineNumber, "cm-live-attachment-line"),
        }).range(line.from),
      );
      addHiddenRange(
        line.from,
        line.to,
        decorations,
        atomicRanges,
        new AttachmentWidget(
          noteID,
          attachment.id,
          attachment.alt,
          attachment.width,
          attachment.align,
          line.from,
          line.to,
          onError,
          lineIsActive(state, lineNumber),
        ),
      );
      lineNumber++;
      continue;
    }

    if (toggle) {
      const toggleAttachment = parseAttachmentMarkdown(toggle.content);
      const sectionEndLineNumber = toggleSectionEnd(objectDocument, lineNumber);

      const hasChildren = sectionEndLineNumber > lineNumber;
      const collapseKey = collapseKeyForPosition(state, line.from, objectDocument);
      const collapsed = hasChildren && nextCollapsed.has(collapseKey);
      const contentOffset = line.from + toggle.prefixSize;

      const isTask = !toggleAttachment && decorateObjectTask(
        toggle.object,
        contentOffset,
        decorations,
        atomicRanges,
      );
      const listKind = !toggleAttachment && !isTask
        ? decorateObjectListMarker(toggle.object, contentOffset, decorations, atomicRanges)
        : null;

      const classes = [
        "cm-live-toggle-line",
        hasChildren ? "cm-live-toggle-parent" : "cm-live-toggle-empty",
        collapsed ? "cm-live-toggle-collapsed" : "",
        toggleAttachment ? "cm-live-attachment-line" : "",
        isTask ? "cm-live-task-line" : "",
        isTask || listKind ? "cm-live-list-line" : "",
      ].filter(Boolean).join(" ");

      decorations.push(
        Decoration.line({
          attributes: objectLineAttributes(
            lineNumber,
            classes,
            isTask || listKind
              ? `${toggleLineStyle()} ${listLineStyle()}`
              : toggleLineStyle(),
            depthByLine.get(lineNumber) ?? 0,
          ),
        }).range(line.from),
      );

      addHiddenRange(
        line.from,
        contentOffset,
        decorations,
        atomicRanges,
        new QuoteToggleWidget(line.from, collapsed, !hasChildren),
      );

      if (toggleAttachment) {
        addHiddenRange(
          contentOffset,
          line.to,
          decorations,
          atomicRanges,
          new AttachmentWidget(
            noteID,
            toggleAttachment.id,
            toggleAttachment.alt,
            toggleAttachment.width,
            toggleAttachment.align,
            contentOffset,
            line.to,
            onError,
            lineIsActive(state, lineNumber),
          ),
        );
      } else {
        decorateInlineMarkdown(
          toggle.content,
          contentOffset,
          decorations,
          atomicRanges,
          openWikilink,
          openCard,
          cardTitle,
          onError,
        );
      }

      if (collapsed) {
        const lastLine = state.doc.line(sectionEndLineNumber);

        addHiddenRange(
          line.to,
          lastLine.to,
          decorations,
          atomicRanges,
          new FoldedQuoteWidget(sectionEndLineNumber - lineNumber),
        );

        lineNumber = sectionEndLineNumber + 1;
      } else {
        lineNumber++;
      }

      continue;
    }

    if (isHorizontalRule(line.text)) {
      decorations.push(
        Decoration.line({
          attributes: lineAttributes(lineNumber, "cm-live-horizontal-rule-line"),
        }).range(line.from),
      );
      if (!lineIsActive(state, lineNumber)) {
        addHiddenRange(
          line.from,
          line.to,
          decorations,
          atomicRanges,
          new HorizontalRuleWidget(line.from),
        );
      }
      lineNumber++;
      continue;
    }

    const heading = /^(#{1,6})\s+/.exec(line.text);
    if (heading) {
      const level = heading[1].length;
      const sectionEndLineNumber = headingSectionEnd(state, lineNumber, level);
      const hasChildren = sectionEndLineNumber > lineNumber;
      const collapseKey = collapseKeyForPosition(state, line.from, objectDocument);
      const collapsed = hasChildren && nextCollapsed.has(collapseKey);
      decorations.push(
        Decoration.line({
          attributes: objectLineAttributes(
            lineNumber,
            [
              "cm-live-heading",
              `cm-live-h${level}`,
              hasChildren ? "cm-live-heading-parent" : "",
              collapsed ? "cm-live-heading-collapsed" : "",
            ].filter(Boolean).join(" "),
            undefined,
            depthByLine.get(lineNumber) ?? 0,
          ),
        }).range(line.from),
      );
      if (hasChildren) {
        addHiddenRange(
          line.from,
          line.from + heading[0].length,
          decorations,
          atomicRanges,
          new QuoteToggleWidget(line.from, collapsed, false),
        );
      } else if (!lineIsActive(state, lineNumber)) {
        addHiddenRange(
          line.from,
          line.from + heading[0].length,
          decorations,
          atomicRanges,
        );
      }

      decorateInlineMarkdown(
        line.text.slice(heading[0].length),
        line.from + heading[0].length,
        decorations,
        atomicRanges,
        openWikilink,
        openCard,
        cardTitle,
        onError,
      );

      if (collapsed) {
        const lastLine = state.doc.line(sectionEndLineNumber);
        addHiddenRange(
          line.to,
          lastLine.to,
          decorations,
          atomicRanges,
          new FoldedQuoteWidget(sectionEndLineNumber - lineNumber),
        );
        lineNumber = sectionEndLineNumber + 1;
        continue;
      }

      lineNumber++;
      continue;
    }

    if (continuationOwner) {
      const indent = continuationOwner.contentIndent;
      const prefixSize = continuationPrefixSizeForIndent(line.text, indent);
      const markerWidth = continuationMarkerWidth(objectDocument, continuationOwner.lineNumber);
      decorations.push(
        Decoration.line({
          attributes: objectLineAttributes(
            lineNumber,
            "cm-live-object-continuation-line",
            markerWidth ? `--live-continuation-marker-width: ${markerWidth};` : "",
            depthByLine.get(continuationOwner.lineNumber) ?? 0,
          ),
        }).range(line.from),
      );
      addHiddenRange(
        line.from,
        line.from + prefixSize,
        decorations,
        atomicRanges,
        markerWidth ? new InlineSpacerWidget(markerWidth) : undefined,
      );
      decorateInlineMarkdown(
        line.text.slice(prefixSize),
        line.from + prefixSize,
        decorations,
          atomicRanges,
          openWikilink,
          openCard,
          cardTitle,
          onError,
      );
      lineNumber++;
      continue;
    }

    const object = lineObject?.lineNumber === lineNumber ? lineObject : null;
    const barePrefixSize = object?.barePrefixSize ?? 0;
    if (barePrefixSize > 0 && object?.checked === undefined && !object?.listMarker) {
      addHiddenRange(line.from, line.from + barePrefixSize, decorations, atomicRanges);
    }

    const task = object
      ? decorateObjectTask(object, line.from, decorations, atomicRanges)
      : false;

    if (task) {
      decorations.push(Decoration.line({
        attributes: objectLineAttributes(
          lineNumber,
          "cm-live-task-line cm-live-list-line",
          listLineStyle(),
          depthByLine.get(lineNumber) ?? 0,
        ),
      }).range(line.from));
    }

    const listKind = object && !task
      ? decorateObjectListMarker(object, line.from, decorations, atomicRanges)
      : null;
    if (listKind === "unordered") {
      decorations.push(Decoration.line({
        attributes: objectLineAttributes(
          lineNumber,
          "cm-live-list-line",
          listLineStyle(),
          depthByLine.get(lineNumber) ?? 0,
        ),
      }).range(line.from));
    }

    if (listKind === "ordered") {
      decorations.push(Decoration.line({
        attributes: objectLineAttributes(
          lineNumber,
          "cm-live-list-line",
          listLineStyle(),
          depthByLine.get(lineNumber) ?? 0,
        ),
      }).range(line.from));
    }

    if (!task && !listKind) {
      decorations.push(
        Decoration.line({
          attributes: lineAttributes(lineNumber),
        }).range(line.from),
      );
    }

    decorateInlineMarkdown(
      line.text.slice(barePrefixSize),
      line.from + barePrefixSize,
      decorations,
      atomicRanges,
      openWikilink,
      openCard,
      cardTitle,
      onError,
    );

    lineNumber++;
  }

  return {
    collapsedQuotes: nextCollapsed,
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    lines,
    objectDocument,
  };
}

function livePreviewExtension(
  openWikilink: (title: string) => void,
  openCard: (id: string) => void,
  cardTitle: (id: string) => string | null,
  cards: ReadonlyMap<string, CardMetadata>,
  moveCard: (id: string, status: CardStatus) => void,
  addCard: (boardID: string) => void,
  changeBoardTitle: (boardID: string, title: string) => void,
  noteID: string,
  onError: (reason: unknown) => void,
  highlightLineNumbers: ReadonlySet<number>,
  defaultSectionsCollapsed: boolean,
) {
  const field = StateField.define<LivePreviewState>({
    create(state) {
      const context = state.field(objectDocumentField);
      const collapsed = savedCollapsedPositions(state, noteID) ?? (defaultSectionsCollapsed
        ? new Set(collapsibleQuotePositions(state, context.objectDocument).map((position) => collapseKeyForPosition(state, position, context.objectDocument)))
        : new Set<string>());
      return buildLivePreviewState(
        state,
        collapsed,
        openWikilink,
        openCard,
        cardTitle,
        cards,
        moveCard,
        addCard,
        changeBoardTitle,
        noteID,
        onError,
        highlightLineNumbers,
        context,
      );
    },
    update(value, transaction) {
      let collapsed = new Set(value.collapsedQuotes);
      let cachedContext: ObjectDocumentContext | null = null;
      const collapseContext = () => {
        if (!cachedContext) {
          if (transaction.docChanged) {
            cachedContext = transaction.state.field(objectDocumentField);
          } else {
            cachedContext = {
              lines: value.lines,
              objectDocument: value.objectDocument,
            };
          }
        }
        return cachedContext;
      };
      let collapseChanged = false;
      if (transaction.docChanged) {
        const { objectDocument } = collapseContext();
        collapsed = remapObjectKeysByLine(
          collapsed,
          value.objectDocument,
          objectDocument,
          (lineNumber) => {
            const from = transaction.startState.doc.line(lineNumber).from;
            return transaction.state.doc.lineAt(transaction.changes.mapPos(from, 1)).number;
          },
        );
        collapseChanged = true;
      }
      for (const effect of transaction.effects) {
        if (effect.is(setAllQuotesCollapsed)) {
          const { objectDocument } = collapseContext();
          collapseChanged = true;
          collapsed.clear();
          if (effect.value) {
            for (const position of collapsibleQuotePositions(transaction.state, objectDocument)) {
              collapsed.add(collapseKeyForPosition(transaction.state, position, objectDocument));
            }
          }
          continue;
        }
        if (effect.is(setQuoteCollapsed)) {
          const { objectDocument } = collapseContext();
          collapseChanged = true;
          const key = collapseKeyForPosition(transaction.state, effect.value.position, objectDocument);
          if (effect.value.collapsed) collapsed.add(key);
          else expandToggleTree(
            transaction.state,
            objectDocument,
            effect.value.position,
            collapsed,
          );
          continue;
        }
        if (!effect.is(toggleQuote)) continue;
        const { objectDocument } = collapseContext();
        collapseChanged = true;
        const key = collapseKeyForPosition(transaction.state, effect.value, objectDocument);
        if (collapsed.has(key)) {
          expandToggleTree(transaction.state, objectDocument, effect.value, collapsed);
        }
        else collapsed.add(key);
      }
      if (!transaction.docChanged && !collapseChanged &&
        (!transaction.selection || selectionStaysOnSameLines(transaction.startState, transaction.state))) {
        return value;
      }
      if (collapseChanged) persistCollapsedPositions(transaction.state, noteID, collapsed);
      return buildLivePreviewState(
        transaction.state,
        collapsed,
        openWikilink,
        openCard,
        cardTitle,
        cards,
        moveCard,
        addCard,
        changeBoardTitle,
        noteID,
        onError,
        highlightLineNumbers,
        cachedContext ?? (
          transaction.docChanged
            ? undefined
            : { lines: value.lines, objectDocument: value.objectDocument }
        ),
      );
    },
    provide(currentField) {
      return [
        EditorView.decorations.from(currentField, (value) => value.decorations),
        EditorView.atomicRanges.of(
          (view) => view.state.field(currentField).atomicRanges,
        ),
      ];
    },
  });

  return [objectDocumentField, field];
}

function wrapSelection(view: EditorView, marker: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to);
      const markerSize = marker.length;

      if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= markerSize * 2) {
        const inner = selected.slice(markerSize, selected.length - markerSize);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        };
      }

      const before = range.from >= markerSize
        ? view.state.sliceDoc(range.from - markerSize, range.from)
        : "";
      const after = range.to + markerSize <= view.state.doc.length
        ? view.state.sliceDoc(range.to, range.to + markerSize)
        : "";

      if (selected && before === marker && after === marker) {
        return {
          changes: [
            { from: range.to, to: range.to + markerSize, insert: "" },
            { from: range.from - markerSize, to: range.from, insert: "" },
          ],
          range: EditorSelection.range(range.from - markerSize, range.to - markerSize),
        };
      }

      const insert = `${marker}${selected}${marker}`;
      const contentFrom = range.from + markerSize;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: selected
          ? EditorSelection.range(contentFrom, contentFrom + selected.length)
          : EditorSelection.cursor(contentFrom),
      };
    }),
  );

  view.focus();
}

function insertMarkdownLink(view: EditorView) {
  const url = "https://";
  view.dispatch(
    view.state.changeByRange((range) => {
      const label = view.state.sliceDoc(range.from, range.to) || "link text";
      const insert = `[${label}](${url})`;
      const urlFrom = range.from + label.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlFrom, urlFrom + url.length),
      };
    }),
  );
  view.focus();
}

function insertFencedCodeBlock(view: EditorView) {
  const language = "txt";
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to);
      const insert = `\`\`\`${language}\n${selected}\n\`\`\``;
      const contentFrom = range.from + language.length + 4;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: selected
          ? EditorSelection.range(contentFrom, contentFrom + selected.length)
          : EditorSelection.cursor(contentFrom),
      };
    }),
  );
  view.focus();
}

function prefixSelectedLines(view: EditorView, prefix: string) {
  const lineNumbers = new Set<number>();

  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      lineNumbers.add(lineNumber);
    }
  }

  const changes = [...lineNumbers]
    .sort((left, right) => left - right)
    .map((lineNumber) => {
      const line = view.state.doc.line(lineNumber);
      const previousLine = lineNumber > 1 ? view.state.doc.line(lineNumber - 1).text : undefined;
      return {
        from: line.from,
        to: line.to,
        insert: replaceExclusiveObjectPrefix(line.text, prefix, previousLine),
      };
    });

  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: view.state.selection.map(changeSet, 1),
  });
  view.focus();
}

function removeBareTaskPrefix(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  const prefix = view.state.sliceDoc(line.from, range.head);
  const match = /^([ \t]*)<[ \t]?$/.exec(prefix);
  if (!match) return false;
  const from = line.from + match[1].length;
  view.dispatch({
    changes: { from, to: range.head, insert: "" },
    selection: EditorSelection.cursor(from),
  });
  return true;
}

function restoreArrowSubstitution(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty || range.head === 0) return false;
  const glyph = view.state.sliceDoc(range.head - 1, range.head);
  const source = glyph === "→" ? "->" : glyph === "←" ? "<-" : null;
  if (!source) return false;
  view.dispatch({
    changes: { from: range.head - 1, to: range.head, insert: source },
    selection: EditorSelection.cursor(range.head - 1 + source.length),
  });
  return true;
}

function boardMarkerAtDeletionBoundary(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return rangeTouchesBoard(view.state, range.from, range.to);
  const positions = [range.head, range.head - 1, range.head + 1];
  return positions.some((position) =>
    position >= 0 && position <= view.state.doc.length && parseBoardMarker(view.state.doc.lineAt(position).text) !== null,
  );
}

function handleBackspace(view: EditorView): boolean {
  return boardMarkerAtDeletionBoundary(view) || restoreArrowSubstitution(view) || removeBareTaskPrefix(view);
}

function handleBoardDelete(view: EditorView): boolean {
  return boardMarkerAtDeletionBoundary(view);
}

function snippetCompletion(
  context: CompletionContext,
  onCreateCard?: () => Promise<string | null>,
  onCreateBoard?: () => Promise<string | null>,
): CompletionResult | null {
  const before = context.matchBefore(/\/[A-Za-z][A-Za-z_]*/);
  if (!before || !context.explicit && !/\//.test(before.text)) {
    return null;
  }
  if (before.from === before.to && !context.explicit) {
    return null;
  }
  return {
    from: before.from,
    to: before.to,
    options: SNIPPETS.map((snippet) => ({
      label: `/${snippet.trigger}`,
      detail: snippet.description,
        apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
        applySnippetExpansion(view, snippet.trigger, from, to, onCreateCard, onCreateBoard);
      },
    })),
    validFor: /^[A-Za-z][A-Za-z_]*$/,
  };
}

function rollReplacementRange(view: EditorView, from: number, to: number) {
  const line = view.state.doc.lineAt(from);
  const beforeTrigger = view.state.sliceDoc(line.from, from);
  const afterTrigger = view.state.sliceDoc(to, line.to);
  if (/^\s*>?\s*$/.test(beforeTrigger) && /^\s*$/.test(afterTrigger)) {
    return { from: line.from, to: line.to };
  }
  return { from, to };
}

function applySnippetExpansion(
  view: EditorView,
  trigger: string,
  from: number,
  to: number,
  onCreateCard?: () => Promise<string | null>,
  onCreateBoard?: () => Promise<string | null>,
) {
  const isRoll = trigger === "rollb" || trigger === "rollf";
  const replacement = isRoll || trigger === "board" ? rollReplacementRange(view, from, to) : { from, to };
  const create = trigger === "card" ? onCreateCard : trigger === "board" ? onCreateBoard : undefined;
  if (create) {
    void create().then((expansion) => {
      if (!expansion) return;
      view.dispatch({
        changes: { ...replacement, insert: expansion },
        selection: EditorSelection.cursor(replacement.from + expansion.length),
      });
      view.focus();
    }).catch(() => {});
    return true;
  }
  const expansion = expandSnippetWithContext(
    trigger,
    view.state.sliceDoc(0, replacement.from),
    view.state.sliceDoc(replacement.to),
  );

  if (expansion === `/${trigger}`) {
    console.warn(
      trigger === "rollf"
        ? "/rollf did not expand. Place it before a > YYYY-MM-DD section."
        : `/${trigger} did not expand. Place it after a > YYYY-MM-DD section.`,
    );
    return false;
  }

  console.info(`Expanded /${trigger}`);
  view.dispatch({
    changes: { ...replacement, insert: expansion },
    selection: EditorSelection.cursor(replacement.from + expansion.length),
  });
  view.focus();
  return true;
}

function expandSnippetBeforeCursor(
  view: EditorView,
  onCreateCard?: () => Promise<string | null>,
  onCreateBoard?: () => Promise<string | null>,
) {
  const range = view.state.selection.main;
  if (!range.empty) return false;

  const before = view.state.sliceDoc(0, range.head);
  const match = /\/([A-Za-z][A-Za-z_]*)$/.exec(before);
  if (!match) return false;

  const from = range.head - match[0].length;
  return applySnippetExpansion(view, match[1], from, range.head, onCreateCard, onCreateBoard);
}

function changeOutlineDepth(view: EditorView, direction: 1 | -1) {
  const lineNumbers = new Set<number>();

  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      lineNumbers.add(lineNumber);
    }
  }

  const changes: { from: number; to?: number; insert: string }[] = [];

  for (const lineNumber of [...lineNumbers].sort((left, right) => left - right)) {
    const line = view.state.doc.line(lineNumber);

    if (direction === 1) {
      changes.push({
        from: line.from,
        insert: "  ",
      });
      continue;
    }

    const removable = /(?:^ {1,2}|\t)/.exec(line.text)?.[0];
    if (!removable) continue;

    changes.push({
      from: line.from,
      to: line.from + removable.length,
      insert: "",
    });
  }

  if (changes.length === 0) return false;

  view.dispatch({ changes });
  view.focus();

  return true;
}

function changeCodeIndent(view: EditorView, direction: 1 | -1) {
  const document = cachedObjectDocument(view.state);
  const lineNumbers = new Set<number>();

  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      const owner = document.byLine.get(lineNumber);
      if (owner?.tag === "code" && lineNumber > owner.lineNumber && lineNumber <= owner.textLineEnd) {
        lineNumbers.add(lineNumber);
      }
    }
  }

  if (lineNumbers.size === 0) return false;
  const changes: { from: number; to?: number; insert: string }[] = [];
  for (const lineNumber of lineNumbers) {
    const line = view.state.doc.line(lineNumber);
    if (direction === 1) {
      changes.push({ from: line.from, insert: "    " });
    } else {
      const spaces = /^ {1,4}/.exec(line.text)?.[0];
      if (spaces) changes.push({ from: line.from, to: line.from + spaces.length, insert: "" });
    }
  }

  if (changes.length === 0) return true;
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: view.state.selection.map(changeSet, 1),
  });
  return true;
}

function insertNewlineAtOutlineDepth(view: EditorView) {
  const range = view.state.selection.main;
  if (!range.empty) return false;

  const line = view.state.doc.lineAt(range.head);
  const indentation = line.text.slice(0, line.text.length - line.text.trimStart().length);
  const document = cachedObjectDocument(view.state);
  const owner = document.byLine.get(line.number);
  const object = owner?.lineNumber === line.number ? owner : null;
  const isCodeContent = owner?.tag === "code" && line.number > owner.lineNumber && line.number <= owner.textLineEnd;
  if (!isCodeContent && !object) return false;

  const atObjectStart = range.head === line.from && object?.tag !== "code";
  const inserted = atObjectStart
    ? "\n"
    : isCodeContent
    ? `\n${indentation}`
    : object?.tag === "code"
    ? "\n"
    : `\n${repeatedObjectPrefix(line.text) ?? indentation}`;

  view.dispatch({
    changes: {
      from: range.head,
      insert: inserted,
    },
    selection: EditorSelection.cursor(range.head + inserted.length),
  });

  view.focus();
  return true;
}

function insertSoftObjectBreak(view: EditorView) {
  const range = view.state.selection.main;
  if (!range.empty) return false;

  const line = view.state.doc.lineAt(range.head);
  const lines = view.state.doc.toString().split("\n");
  const ownerLine = objectOwnerLineNumber(lines, line.number);
  const prefix = ownerLine !== line.number && ownerLine > 0
    ? " ".repeat(objectContentIndent(lines[ownerLine - 1] ?? ""))
    : continuationPrefix(line.text);
  if (prefix === null) return false;

  const inserted = `\n${prefix}`;
  view.dispatch({
    changes: {
      from: range.head,
      insert: inserted,
    },
    selection: EditorSelection.cursor(range.head + inserted.length),
  });
  view.focus();
  return true;
}

function multilineObjectPaste(view: EditorView, text: string) {
  if (!text.includes("\n")) return false;
  const range = view.state.selection.main;

  const line = view.state.doc.lineAt(range.from);
  const prefix = continuationPrefix(line.text);
  if (prefix === null) return false;

  const normalized = normalizeArrowText(text.replace(/\r\n?/g, "\n"));
  const inserted = normalized.split("\n").map((part, index) =>
    index === 0 ? part : `${prefix}${part}`
  ).join("\n");

  view.dispatch({
    changes: {
      from: range.from,
      to: range.to,
      insert: inserted,
    },
    selection: EditorSelection.cursor(range.from + inserted.length),
  });
  view.focus();
  return true;
}

let logicalObjectClipboard = "";

function setAllSectionsCollapsed(view: EditorView, collapsed: boolean) {
  view.dispatch({ effects: setAllQuotesCollapsed.of(collapsed) });
  view.focus();
  return true;
}

function currentToggleSectionPosition(state: EditorState): number | null {
  const objectDocument = cachedObjectDocument(state);
  const currentLineNumber = state.doc.lineAt(state.selection.main.head).number;
  const currentLine = state.doc.line(currentLineNumber);
  const currentHeadingLevel = headingLevel(currentLine.text);

  let object = objectDocument.byLine.get(currentLineNumber);
  let sectionLineNumber = 0;
  while (object) {
    if (object.tags.includes("section") && object.children.length > 0) {
      sectionLineNumber = object.lineNumber;
      break;
    }
    object = object.parentId ? objectDocument.byId.get(object.parentId) : undefined;
  }

  let headingLineNumber = 0;
  if (currentHeadingLevel !== null && headingHasChildren(state, currentLineNumber, currentHeadingLevel)) {
    headingLineNumber = currentLineNumber;
  }

  for (let lineNumber = currentLineNumber - 1; headingLineNumber === 0 && lineNumber >= 1; lineNumber--) {
    const line = state.doc.line(lineNumber);
    const level = headingLevel(line.text);
    if (level === null) continue;
    const endLineNumber = headingSectionEnd(state, lineNumber, level);

    if (endLineNumber >= currentLineNumber && endLineNumber > lineNumber) {
      headingLineNumber = lineNumber;
    }
  }

  const lineNumber = Math.max(sectionLineNumber, headingLineNumber);
  return lineNumber > 0 ? state.doc.line(lineNumber).from : null;
}

function setCurrentSectionCollapsed(view: EditorView, collapsed: boolean) {
  const position = currentToggleSectionPosition(view.state);

  if (position === null) return false;

  view.dispatch({
    effects: setQuoteCollapsed.of({ position, collapsed }),
  });

  view.focus();
  return true;
}

function showCaretLocation(view: EditorView) {
  const position = view.state.selection.main.head;
  const sectionPosition = currentToggleSectionPosition(view.state);
  const effects = [
    locateCaret.of(position),
    EditorView.scrollIntoView(position, { y: "center" }),
  ];
  if (sectionPosition !== null) {
    effects.push(setQuoteCollapsed.of({ position: sectionPosition, collapsed: false }));
  }
  view.dispatch({ effects });
  view.focus();
  return true;
}

function objectHandleElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement
    ? target.closest<HTMLElement>(".cm-live-object-handle[data-object-line]")
    : null;
}

function showObjectHandleMenu(event: MouseEvent, view: EditorView, lineNumber: number, board = false) {
  document.querySelector(".cm-live-object-menu")?.remove();
  const menu = document.body.appendChild(document.createElement("div"));
  menu.className = "cm-live-attachment-menu cm-live-object-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const close = (closeEvent?: PointerEvent) => {
    if (closeEvent && menu.contains(closeEvent.target as Node)) return;
    menu.remove();
    document.removeEventListener("pointerdown", close);
  };
  const remove = menu.appendChild(document.createElement("button"));
  remove.type = "button";
  remove.role = "menuitem";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    close();
    const state = view.state;
    const doc = state.doc.toString();
    if (lineNumber < 1 || lineNumber > state.doc.lines) return;
    const line = state.doc.line(lineNumber);
    const next = deleteObjectInMarkdown(doc, lineNumber);
    if (next === doc) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: EditorSelection.cursor(Math.min(line.from, next.length)),
    });
    view.focus();
  });
  if (!board) {
    const duplicate = menu.insertBefore(document.createElement("button"), remove);
    duplicate.type = "button";
    duplicate.role = "menuitem";
    duplicate.textContent = "Duplicate";
    duplicate.addEventListener("click", () => {
      close();
      const state = view.state;
      const doc = state.doc.toString();
      const lines = doc.split("\n");
      if (lineNumber < 1 || lineNumber > lines.length) return;
      logicalObjectClipboard = lines.slice(lineNumber - 1, objectBlockEnd(lines, lineNumber)).join("\n");
      void navigator.clipboard?.writeText(logicalObjectClipboard).catch(() => {});
      const next = insertLogicalObjectAfterCaret(doc, logicalObjectClipboard, state.doc.line(lineNumber).to);
      if (next === doc) return;
      const duplicateStart = state.doc.line(objectBlockEnd(lines, lineNumber)).to + 1;
      view.dispatch({
        changes: { from: 0, to: state.doc.length, insert: next },
        selection: EditorSelection.cursor(Math.min(duplicateStart, next.length)),
      });
      view.focus();
    });
  }
  queueMicrotask(() => document.addEventListener("pointerdown", close));
}

function objectLineElementAt(x: number, y: number): HTMLElement | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element instanceof HTMLElement && element.matches(".cm-live-object-line[data-object-line]")) {
      return element;
    }
    if (element instanceof HTMLElement) {
      const line = element.closest<HTMLElement>(".cm-live-object-line[data-object-line]");
      if (line) return line;
    }
  }
  return null;
}

function objectTargetLineNumber(view: EditorView, line: HTMLElement): number {
  const lineNumber = Number(line.dataset.objectLine);
  return cachedObjectDocument(view.state).byLine.get(lineNumber)?.lineNumber ?? lineNumber;
}

function dropModeForPoint(
  targetLine: HTMLElement,
  clientY: number,
  previous?: ObjectDropMode | null,
): ObjectDropMode {
  const rect = targetLine.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (previous === "before" && ratio < 0.32) return "before";
  if (previous === "after" && ratio > 0.68) return "after";
  if (previous === "child" && ratio > 0.24 && ratio < 0.76) return "child";
  if (ratio < 0.28) return "before";
  if (ratio > 0.72) return "after";
  return "child";
}

function clearObjectDropPreview(target?: HTMLElement | null) {
  if (target) {
    target.classList.remove("is-drop-before", "is-drop-child", "is-drop-after");
    target.removeAttribute("data-drop-mode");
    return;
  }
  document.querySelectorAll(".cm-live-object-line[data-drop-mode]").forEach((element) => {
    element.classList.remove("is-drop-before", "is-drop-child", "is-drop-after");
    element.removeAttribute("data-drop-mode");
  });
}

function moveObjectBlock(
  view: EditorView,
  sourceLineNumber: number,
  targetLineNumber: number,
  clientY: number,
  targetElement: HTMLElement,
  forcedMode?: ObjectDropMode | null,
) {
  if (sourceLineNumber === targetLineNumber) return false;

  const state = view.state;
  const mode = forcedMode ?? dropModeForPoint(targetElement, clientY);
  const doc = state.doc.toString();
  const next = moveObjectInMarkdown(doc, sourceLineNumber, targetLineNumber, mode);
  if (next === doc) return false;

  view.dispatch({
    changes: { from: 0, to: state.doc.length, insert: next },
    scrollIntoView: false,
  });
  view.focus();
  return true;
}

export default function LiveMarkdownEditor({
  noteID,
  value,
  onChange,
  onSave,
  onError,
  onOpenWikilink,
  onOpenCard,
  cardTitles = new Map<string, string>(),
  cardData = new Map<string, CardMetadata>(),
  onCreateCard,
  onCreateBoard,
  onMoveCard,
  onAddCardToBoard,
  onChangeBoardTitle,
  onDecreaseFontSize,
  onIncreaseFontSize,
  searchTarget = null,
  onSearchTargetApplied,
  caretOffset = null,
  caretRestoreVersion = 0,
  onCaretChange,
  readOnly = false,
  showToolbar = true,
  highlightLineNumbers = new Set<number>(),
  defaultSectionsCollapsed = true,
}: LiveMarkdownEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onErrorRef = useRef(onError);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  const onOpenCardRef = useRef(onOpenCard);
  const cardTitlesRef = useRef(cardTitles);
  const cardDataRef = useRef(cardData);
  const onCreateCardRef = useRef(onCreateCard);
  const onCreateBoardRef = useRef(onCreateBoard);
  const onMoveCardRef = useRef(onMoveCard);
  const onAddCardToBoardRef = useRef(onAddCardToBoard);
  const onChangeBoardTitleRef = useRef(onChangeBoardTitle);
  const onDecreaseFontSizeRef = useRef(onDecreaseFontSize);
  const onIncreaseFontSizeRef = useRef(onIncreaseFontSize);
  const onSearchTargetAppliedRef = useRef(onSearchTargetApplied);
  const onCaretChangeRef = useRef(onCaretChange);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [hiddenAncestors, setHiddenAncestors] = useState<string[]>([]);

  useEffect(() => () => clearAttachmentDataCache(), [noteID]);

  useLayoutEffect(() => {
    if (!showToolbar) return;
    const editorHost = host.current;
    if (!editorHost) return;

    const editorShell = editorHost.closest<HTMLElement>(".editor-shell");
    const documentBody = editorShell?.querySelector<HTMLElement>(".document-body");

    if (!editorShell || !documentBody) return;

    const toolbar = document.createElement("div");
    toolbar.className = "markdown-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Markdown formatting");

    editorShell.insertBefore(toolbar, documentBody);
    setToolbarHost(toolbar);

    return () => {
      setToolbarHost(null);
      toolbar.remove();
    };
  }, [showToolbar]);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onErrorRef.current = onError;
    onOpenWikilinkRef.current = onOpenWikilink;
    onOpenCardRef.current = onOpenCard;
    cardTitlesRef.current = cardTitles;
    cardDataRef.current = cardData;
    onCreateCardRef.current = onCreateCard;
    onCreateBoardRef.current = onCreateBoard;
    onMoveCardRef.current = onMoveCard;
    onAddCardToBoardRef.current = onAddCardToBoard;
    onChangeBoardTitleRef.current = onChangeBoardTitle;
    onDecreaseFontSizeRef.current = onDecreaseFontSize;
    onIncreaseFontSizeRef.current = onIncreaseFontSize;
    onSearchTargetAppliedRef.current = onSearchTargetApplied;
    onCaretChangeRef.current = onCaretChange;
  }, [onChange, onSave, onError, onOpenWikilink, onOpenCard, cardTitles, cardData, onCreateCard, onCreateBoard, onMoveCard, onAddCardToBoard, onChangeBoardTitle, onDecreaseFontSize, onIncreaseFontSize, onSearchTargetApplied, onCaretChange]);

  useEffect(() => {
    if (!host.current) return;

    const normalizedValue = normalizeArrowText(value);
    let scheduleJournalRules = () => {};
    const syncHiddenAncestors = (editor: EditorView) => {
      const visibleFrom = editor.visibleRanges[0]?.from ?? 0;
      const top = editor.scrollDOM.getBoundingClientRect().top;
      const labels = objectAncestorsByLine(
        cachedObjectDocument(editor.state),
        editor.state.doc.lineAt(editor.state.selection.main.head).number,
      ).filter((object) => {
        const line = editor.dom.querySelector<HTMLElement>(
          `.cm-live-object-line[data-object-line="${object.lineNumber}"]`,
        );
        return line ? line.getBoundingClientRect().bottom <= top : object.to < visibleFrom;
      }).map((object) => object.text.split("\n")[0].trim()).filter(Boolean);
      setHiddenAncestors((current) =>
        current.length === labels.length && current.every((label, index) => label === labels[index])
          ? current
          : labels
      );
    };
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: normalizedValue,
        extensions: [
          Prec.highest(keymap.of([
            {
              key: "Mod-a",
              preventDefault: true,
              run: (view) => {
                view.dispatch({
                  selection: expandedSelection(view.state, cachedObjectDocument(view.state)),
                  scrollIntoView: true,
                });
                return true;
              },
            },
            {
              key: "Mod-z",
              preventDefault: true,
              run: (editor) => undo(editor),
            },
            {
              key: "Ctrl-r",
              preventDefault: true,
              run: (editor) => redo(editor),
            },
            {
              key: "Ctrl-Shift-z",
              preventDefault: true,
              run: (editor) => redo(editor),
            },
            {
              key: "Ctrl-Alt-l",
              preventDefault: true,
              run: (editor) => showCaretLocation(editor),
            },
            {
              key: "Ctrl-]",
              preventDefault: true,
              run: (editor) => setCurrentSectionCollapsed(editor, false),
            },
            {
              key: "Ctrl-[",
              preventDefault: true,
              run: (editor) => setCurrentSectionCollapsed(editor, true),
            },
            {
              key: "Ctrl-Shift-]",
              preventDefault: true,
              run: (editor) => setAllSectionsCollapsed(editor, false),
            },
            {
              key: "Ctrl-Shift-[",
              preventDefault: true,
              run: (editor) => setAllSectionsCollapsed(editor, true),
            },
            {
              key: "Shift-Enter",
              run: (editor) => insertSoftObjectBreak(editor),
            },
            {
              key: "Backspace",
              run: handleBackspace,
            },
            {
              key: "Delete",
              run: handleBoardDelete,
            },
            {
              key: "Enter",
              run: (editor) =>
                acceptCompletion(editor) ||
                expandSnippetBeforeCursor(
                  editor,
                  () => onCreateCardRef.current?.() ?? Promise.resolve(null),
                  () => onCreateBoardRef.current?.() ?? Promise.resolve(null),
                ) ||
                insertNewlineAtOutlineDepth(editor),
            },
            {
              key: "Tab",
              run: (editor) => changeCodeIndent(editor, 1) || changeOutlineDepth(editor, 1),
            },
            {
              key: "Shift-Tab",
              run: (editor) => changeCodeIndent(editor, -1) || changeOutlineDepth(editor, -1),
            },
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            {
              key: "Ctrl--",
              preventDefault: true,
              run: () => {
                onDecreaseFontSizeRef.current();
                return true;
              },
            },
            {
              key: "Ctrl-=",
              preventDefault: true,
              run: () => {
                onIncreaseFontSizeRef.current();
                return true;
              },
            },
            {
              key: "Mod-h",
              preventDefault: true,
              run: (view) => {
                openSearchPanel(view);
                queueMicrotask(() => {
                  const input = view.dom.querySelector<HTMLInputElement>(
                    ".cm-search-replace input, .cm-panels input.cm-textfield",
                  );
                  if (input) {
                    input.focus();
                    input.select();
                  }
                });
                return true;
              },
            },
          ])),
          search(),
          keymap.of(searchKeymap),
          autocompletion({
            override: [(context) => snippetCompletion(
              context,
              () => onCreateCardRef.current?.() ?? Promise.resolve(null),
              () => onCreateBoardRef.current?.() ?? Promise.resolve(null),
            )],
          }),
          minimalSetup,
          history({ newGroupDelay: 250 }),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          markdown({ codeLanguages: languages }),
          syntaxHighlighting(codeHighlightStyle),
          deepCodeHighlightField,
          deepCodeHighlightLoader,
          liveMarkdownTheme,
          caretLocatorField,
          EditorView.lineWrapping,
          EditorView.inputHandler.of((inputView, from, to, text) => {
            if (readOnly) return false;
            if (rangeTouchesBoard(inputView.state, from, to)) return true;
            let changeFrom = from;
            let changeTo = to;
            let inserted = text;

            if (!inserted.includes("\n")) {
              const line = inputView.state.doc.lineAt(changeFrom);
              if (changeTo <= line.to) {
                const relativeFrom = changeFrom - line.from;
                const prospective = `${line.text.slice(0, relativeFrom)}${inserted}${line.text.slice(changeTo - line.from)}`;
                const previousLine = line.number > 1
                  ? inputView.state.doc.line(line.number - 1).text
                  : undefined;
                const fence = completeCodeFenceElement(prospective);
                const owner = cachedObjectDocument(inputView.state).byLine.get(line.number);
                if (fence && owner?.lineNumber === line.number && owner.tag !== "code") {
                  inputView.dispatch({
                    changes: { from: line.from, to: line.to, insert: fence },
                    selection: EditorSelection.cursor(line.from + fence.indexOf("\n") + 1),
                  });
                  return true;
                }
                const normalizedPrefix = normalizeStackedExclusiveObjectPrefix(prospective, previousLine);
                if (normalizedPrefix !== prospective) {
                  const prefixLength = /^[ \t]*(?:(?:>+|[-*]|\d+[.)])[ \t]+|<[ \t]?)/.exec(normalizedPrefix)?.[0].length ?? 0;
                  inputView.dispatch({
                    changes: { from: line.from, to: line.to, insert: normalizedPrefix },
                    selection: EditorSelection.cursor(line.from + prefixLength),
                  });
                  return true;
                }
              }
            }

            if (
              changeFrom > 0 &&
              inputView.state.sliceDoc(changeFrom - 1, changeFrom) === "-" &&
              inserted.startsWith(">")
            ) {
              changeFrom--;
              inserted = `-${inserted}`;
            }
            if (
              changeFrom > 0 &&
              inputView.state.sliceDoc(changeFrom - 1, changeFrom) === "<" &&
              inserted.startsWith("-")
            ) {
              changeFrom--;
              inserted = `<${inserted}`;
            }
            if (
              changeTo < inputView.state.doc.length &&
              inserted.endsWith("-") &&
              inputView.state.sliceDoc(changeTo, changeTo + 1) === ">"
            ) {
              changeTo++;
              inserted += ">";
            }
            if (
              changeTo < inputView.state.doc.length &&
              inserted.endsWith("<") &&
              inputView.state.sliceDoc(changeTo, changeTo + 1) === "-"
            ) {
              changeTo++;
              inserted += "-";
            }

            const normalized = normalizeArrowText(inserted);
            if (normalized === inserted) return false;

            inputView.dispatch({
              changes: {
                from: changeFrom,
                to: changeTo,
                insert: normalized,
              },
              selection: EditorSelection.cursor(changeFrom + normalized.length),
            });
            return true;
          }),
          EditorView.contentAttributes.of({
            "aria-label": "Live Preview Markdown editor",
            spellcheck: "true",
          }),
          EditorView.domEventHandlers({
            contextmenu(event, contextView) {
              if (readOnly) return false;
              const handle = objectHandleElement(event.target);
              const sourceLine = Number(handle?.dataset.objectLine);
              if (!handle || !Number.isFinite(sourceLine)) return false;
              event.preventDefault();
              event.stopPropagation();
              showObjectHandleMenu(
                event,
                contextView,
                sourceLine,
                parseBoardMarker(contextView.state.doc.line(sourceLine).text) !== null,
              );
              return true;
            },
            pointerdown(event, pointerView) {
              if (readOnly || event.button !== 0) return false;
              if (!(event.target instanceof Element && event.target.closest(".cm-live-attachment"))) {
                document.querySelectorAll<HTMLElement>(".cm-live-attachment.is-selected").forEach((item) => item.classList.remove("is-selected"));
              }
              const handle = objectHandleElement(event.target);
              const sourceLine = Number(handle?.dataset.objectLine);
              if (!handle || !Number.isFinite(sourceLine)) return false;
              event.preventDefault();
              event.stopPropagation();
              handle.setPointerCapture(event.pointerId);
              handle.classList.add("is-dragging");
              const sourceElement = handle.closest<HTMLElement>(".cm-live-object-line");
              sourceElement?.classList.add("is-dragging");

              const ghost = document.body.appendChild(document.createElement("div"));
              ghost.className = "cm-live-drag-ghost";
              ghost.textContent = pointerView.state.doc.line(sourceLine).text.trim() || "Object";

              let lastX = event.clientX;
              let lastY = event.clientY;
              let previewTarget: HTMLElement | null = null;
              let previewMode: ObjectDropMode | null = null;
              const updateGhost = () => {
                ghost.style.transform = `translate(${lastX + 12}px, ${lastY + 12}px)`;
              };
              updateGhost();
              const move = (moveEvent: PointerEvent) => {
                lastX = moveEvent.clientX;
                lastY = moveEvent.clientY;
                updateGhost();
                const targetLine = objectLineElementAt(lastX, lastY);
                if (targetLine !== previewTarget) {
                  clearObjectDropPreview(previewTarget);
                  previewTarget = targetLine;
                  previewMode = null;
                }
                if (previewTarget) {
                  const mode = dropModeForPoint(previewTarget, lastY, previewMode);
                  previewMode = mode;
                  previewTarget.classList.remove("is-drop-before", "is-drop-child", "is-drop-after");
                  previewTarget.classList.add(`is-drop-${mode}`);
                  previewTarget.dataset.dropMode = mode;
                }
              };
              const finish = (upEvent: PointerEvent) => {
                handle.releasePointerCapture(upEvent.pointerId);
                handle.classList.remove("is-dragging");
                sourceElement?.classList.remove("is-dragging");
                ghost.remove();
                clearObjectDropPreview(previewTarget);
                document.removeEventListener("pointermove", move);
                document.removeEventListener("pointerup", finish);
                document.removeEventListener("pointercancel", finish);
                const targetLine = objectLineElementAt(lastX, lastY);
                const targetLineNumber = targetLine ? objectTargetLineNumber(pointerView, targetLine) : Number.NaN;
                if (!targetLine || !Number.isFinite(targetLineNumber)) return;
                moveObjectBlock(pointerView, sourceLine, targetLineNumber, lastY, targetLine, previewMode);
              };
              document.addEventListener("pointermove", move);
              document.addEventListener("pointerup", finish);
              document.addEventListener("pointercancel", finish);
              return true;
            },
            drop(event) {
              if (!Array.from(event.dataTransfer?.types ?? []).includes(boardCardMime)) return false;
              event.preventDefault();
              event.stopPropagation();
              return true;
            },
            paste(event, pastedView) {
              if (readOnly) return false;
              const selection = pastedView.state.selection.main;
              if (rangeTouchesBoard(pastedView.state, selection.from, selection.to)) {
                event.preventDefault();
                return true;
              }
              const image = clipboardImage(event);
              if (!image && !clipboardMayContainImage(event)) {
                const text = event.clipboardData?.getData("text/plain") ?? "";
                if (logicalObjectClipboard && text === logicalObjectClipboard) {
                  const next = insertLogicalObjectAfterCaret(
                    pastedView.state.doc.toString(),
                    text,
                    pastedView.state.selection.main.head,
                  );
                  if (next !== pastedView.state.doc.toString()) {
                    event.preventDefault();
                    pastedView.dispatch({ changes: { from: 0, to: pastedView.state.doc.length, insert: next } });
                    pastedView.focus();
                    return true;
                  }
                }
                if (!multilineObjectPaste(pastedView, text)) return false;
                event.preventDefault();
                return true;
              }
              event.preventDefault();
              const insertion = pastedView.state.selection.main.from;
              void (image ? Promise.resolve(image) : readClipboardImage())
                .then((source) => {
                  if (!source) throw new Error("Could not read image data from the clipboard");
                  return imageDataURL(source);
                })
                .then((data) => VaultService.SaveImageAttachment(noteID, data))
                .then((id) => {
                  const markdown = attachmentMarkdown(id);
                  const line = pastedView.state.doc.lineAt(insertion);
                  const object = cachedObjectDocument(pastedView.state).byLine.get(line.number);
                  const prefix = object && (
                    object.indent > 0 ||
                    object.tags.includes("section") ||
                    object.tags.includes("bulletpoint") ||
                    object.checked !== undefined ||
                    object.barePrefixSize > 0
                  ) ? continuationPrefix(line.text) ?? "" : "";
                  const change = insertAttachmentMarkdown(
                    pastedView.state.doc.toString(),
                    insertion,
                    markdown,
                    prefix,
                  );
                  pastedView.dispatch({
                    changes: change,
                    selection: EditorSelection.cursor(change.from + change.insert.length),
                    scrollIntoView: false,
                  });
                })
                .catch((reason) => onErrorRef.current(reason));
              return true;
            },
          }),
          placeholder("Begin writing…"),
          livePreviewExtension(
            (title) => onOpenWikilinkRef.current(title),
            (id) => onOpenCardRef.current?.(id),
            (id) => cardTitlesRef.current.get(id) ?? null,
            cardDataRef.current,
            (id, status) => onMoveCardRef.current?.(id, status),
            (boardID) => onAddCardToBoardRef.current?.(boardID),
            (boardID, title) => onChangeBoardTitleRef.current?.(boardID, title),
            noteID,
            (reason) => onErrorRef.current(reason),
            highlightLineNumbers,
            defaultSectionsCollapsed,
          ),
          searchHighlightField,
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(externalDocumentUpdate),
              )
            ) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              onCaretChangeRef.current?.(update.state.selection.main.head);
            }
            if (update.docChanged || update.viewportChanged || update.geometryChanged) {
              scheduleJournalRules();
            }
            if (update.selectionSet || update.docChanged || update.viewportChanged || update.geometryChanged) {
              syncHiddenAncestors(update.view);
            }
          }),
        ],
      }),
    });
    const journalRules = installJournalRules(editor);
    scheduleJournalRules = journalRules.schedule;
    const handleScroll = () => syncHiddenAncestors(editor);
    editor.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });
    syncHiddenAncestors(editor);

    view.current = editor;
    if (typeof caretOffset === "number" && Number.isFinite(caretOffset)) {
      const position = Math.max(0, Math.min(Math.floor(caretOffset), editor.state.doc.length));
      editor.dispatch({
        selection: EditorSelection.cursor(position),
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
      editor.focus();
    }
    if (normalizedValue !== value) {
      queueMicrotask(() => onChangeRef.current(normalizedValue));
    }

    return () => {
      onCaretChangeRef.current?.(editor.state.selection.main.head);
      editor.scrollDOM.removeEventListener("scroll", handleScroll);
      journalRules.destroy();
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const normalizedValue = normalizeArrowText(value);
    if (editor.state.doc.toString() === normalizedValue) return;

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: normalizedValue },
      selection: preservedSelection(editor, normalizedValue.length),
      annotations: [
        externalDocumentUpdate.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
    if (normalizedValue !== value) {
      queueMicrotask(() => onChangeRef.current(normalizedValue));
    }
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || typeof caretOffset !== "number" || !Number.isFinite(caretOffset)) return;
    const position = Math.max(0, Math.min(Math.floor(caretOffset), editor.state.doc.length));
    if (editor.state.selection.main.empty && editor.state.selection.main.head === position) return;
    editor.dispatch({
      selection: EditorSelection.cursor(position),
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
    editor.focus();
  }, [caretRestoreVersion]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const range = rangeForActiveDocument(
      searchTarget,
      noteID,
      editor.state.doc.toString(),
      value,
    );
    if (!range) return;
    editor.dispatch(searchTargetTransaction(range));
    editor.focus();
    onSearchTargetAppliedRef.current?.();
  }, [noteID, searchTarget, value]);

  const runWithEditor = (action: (editor: EditorView) => void) => {
    if (view.current) action(view.current);
  };

  return (
    <>
      {toolbarHost
        ? createPortal(
            <>
              <button
                type="button"
                title="Bold"
                aria-label="Make text bold"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => wrapSelection(editor, "__"));
                }}
              >
                <strong>B</strong>
              </button>
              <button
                type="button"
                title="Italic"
                aria-label="Make text italic"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => wrapSelection(editor, "*"));
                }}
              >
                <em>I</em>
              </button>
              <button
                type="button"
                title="Strikethrough"
                aria-label="Strikethrough text"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => wrapSelection(editor, "~~"));
                }}
              >
                <s>S</s>
              </button>
              <button
                type="button"
                title="Inline code"
                aria-label="Format inline code"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => wrapSelection(editor, "`"));
                }}
              >
                <code>&lt;&gt;</code>
              </button>
              <button
                type="button"
                title="Fenced code block (txt)"
                aria-label="Insert fenced code block"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor(insertFencedCodeBlock);
                }}
              >
                <code>```</code>
              </button>
              <button
                type="button"
                title="Link"
                aria-label="Insert Markdown link"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor(insertMarkdownLink);
                }}
              >
                <span aria-hidden="true">↗</span>
              </button>
              <span className="markdown-toolbar-separator" />
              <button
                type="button"
                title="Heading"
                aria-label="Insert heading"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => prefixSelectedLines(editor, "# "));
                }}
              >
                H
              </button>
              <button
                type="button"
                title="Checklist"
                aria-label="Insert checklist item"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => prefixSelectedLines(editor, "* [ ] "));
                }}
              >
                <span className="toolbar-checkbox" aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Bullet list"
                aria-label="Insert bullet point"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => prefixSelectedLines(editor, "* "));
                }}
              >
                <span className="toolbar-bullet" aria-hidden="true">
                  •
                </span>
              </button>
              <button
                type="button"
                title="Numbered list"
                aria-label="Insert numbered list item"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => prefixSelectedLines(editor, "1. "));
                }}
              >
                1.
              </button>
              <span className="markdown-toolbar-separator" />
              <button
                type="button"
                title="Toggle section"
                aria-label="Insert toggle section"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => prefixSelectedLines(editor, "> "));
                }}
              >
                <span className="toolbar-toggle disclosure-chevron is-expanded" aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Outdent toggle (Shift+Tab)"
                aria-label="Outdent toggle section"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => changeOutlineDepth(editor, -1));
                }}
              >
                ‹
              </button>
              <button
                type="button"
                title="Indent toggle (Tab)"
                aria-label="Indent toggle section"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => changeOutlineDepth(editor, 1));
                }}
              >
                ›
              </button>
              <button
                type="button"
                title="Collapse all sections (Ctrl+Shift+[)"
                aria-label="Collapse all sections"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => setAllSectionsCollapsed(editor, true));
                }}
              >
                ⊟
              </button>
              <button
                type="button"
                title="Expand all sections (Ctrl+Shift+])"
                aria-label="Expand all sections"
                onMouseDown={(event) => {
                  event.preventDefault();
                  runWithEditor((editor) => setAllSectionsCollapsed(editor, false));
                }}
              >
                ⊞
              </button>
            </>,
            toolbarHost,
          )
        : null}
      <div className="live-editor-frame">
        {hiddenAncestors.length > 0
          ? (
              <nav className="editor-ancestor-path" aria-label="Hidden ancestors">
                {hiddenAncestors.map((ancestor, index) => (
                  <span key={`${ancestor}-${index}`}>
                    {index > 0 ? <b aria-hidden="true">›</b> : null}
                    {ancestor}
                  </span>
                ))}
                <b aria-hidden="true">› …</b>
              </nav>
            )
          : null}
        <div ref={host} className="live-markdown-editor" />
      </div>
    </>
  );

}

export async function imageDataURL(source: Blob | string): Promise<string> {
  if (typeof source === "string") return source;
  if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(source.type)) {
    throw new Error("Only PNG, JPEG, and WebP clipboard images are supported");
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${source.type};base64,${btoa(binary)}`;
}

export function clipboardImage(event: ClipboardEvent): Blob | string | null {
  const clipboard = event.clipboardData;
  if (!clipboard) return null;
  for (const item of clipboard.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of clipboard.files) {
    if (file.type.startsWith("image/")) return file;
  }
  const encoded = `${clipboard.getData("text/html")}\n${clipboard.getData("text/plain")}`;
  return embeddedClipboardImage(encoded);
}

export function clipboardClaimsImage(event: ClipboardEvent): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  for (const item of clipboard.items) {
    if (item.type.startsWith("image/")) return true;
  }
  for (const type of clipboard.types) {
    if (type.startsWith("image/") || type === "Files") return true;
  }
  return /^(?:\/?(?:PNG|JPE?G)|image\/(?:png|jpe?g))$/i.test(
    clipboard.getData("text/plain").trim(),
  );
}

export function clipboardMayContainImage(event: ClipboardEvent): boolean {
  if (clipboardClaimsImage(event)) return true;
  if (!/Linux/i.test(navigator.userAgent)) return false;
  const clipboard = event.clipboardData;
  if (!clipboard) return true;
  const text = clipboard.getData("text/plain").trim();
  const types = Array.from(clipboard.types);
  return text === "" && !types.includes("text/html");
}

export async function readClipboardImage(): Promise<Blob | string | null> {
  const linux = /Linux/i.test(navigator.userAgent);
  if (linux) {
    try {
      return await VaultService.ReadClipboardImage();
    } catch {
      // Fall through to the web clipboard API.
    }
  }
  if (navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) return item.getType(imageType);
      }
    } catch {
      // Linux WebKit often exposes the image MIME type without its bytes.
    }
  }
  if (linux) return null;
  try {
    return await VaultService.ReadClipboardImage();
  } catch {
    return null;
  }
}
