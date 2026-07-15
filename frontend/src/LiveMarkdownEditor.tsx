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
import { LanguageDescription, highlightingFor } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { highlightTree } from "@lezer/highlight";
import { minimalSetup } from "codemirror";
import { history, redo, undo } from "@codemirror/commands";
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
  normalizeArrowText,
  parseAttachmentMarkdown,
  tableCells,
} from "./markdown";
import {
  classifyObjectLine,
  continuationPrefix,
  isSeparatorLine,
  lineIndent,
  lineStartsObject,
  moveObjectInMarkdown,
  objectContentIndent,
  objectDepthByLine,
  objectHierarchyIndent,
  objectOwnerLineNumber as ownerLineNumberInLines,
  normalizeStackedExclusiveObjectPrefix,
  parseObjectDocument,
  replaceExclusiveObjectPrefix,
  remapObjectKeysByLine,
  repeatedObjectPrefix,
  visualIndent,
  type ObjectDropMode,
  type ObjectDocument,
} from "./objectDocument";
import {
  rangeForActiveDocument,
  searchHighlightField,
  searchTargetTransaction,
  type SearchTarget,
} from "./searchTarget";
import { SNIPPETS, expandSnippetWithContext } from "./snippets";
import { VaultService } from "../bindings/cipherleaf/internal/app";

type LiveMarkdownEditorProps = {
  noteID: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onError: (reason: unknown) => void;
  onOpenWikilink: (title: string) => void;
  onDecreaseFontSize: () => void;
  onIncreaseFontSize: () => void;
  searchTarget?: SearchTarget | null;
  onSearchTargetApplied?: () => void;
  caretOffset?: number | null;
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

const setDeepCodeHighlights = StateEffect.define<DecorationSet>();

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
    const positions: { top: number; left: number }[] = [];
    for (const line of editor.dom.querySelectorAll<HTMLElement>(
      ".cm-line:not(.cm-live-attachment-line):not(.cm-live-code-block)",
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

      const handleRect = line.querySelector<HTMLElement>(".cm-live-object-handle")?.getBoundingClientRect();
      const left = (handleRect?.right ?? lineRect.left) - scrollerRect.left + scroller.scrollLeft + 6;
      for (const row of rows) {
        positions.push({
          top: row.bottom - scrollerRect.top + scroller.scrollTop,
          left,
        });
      }
    }

    const fragment = document.createDocumentFragment();
    for (const position of positions) {
      const rule = document.createElement("span");
      rule.className = "cm-journal-rule";
      rule.style.top = `${position.top}px`;
      rule.style.left = `${position.left}px`;
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
      paddingTop: "2px",
      paddingBottom: "2px",
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
      backgroundColor: "rgba(127, 127, 127, 0.14)",
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
  ) {
    super();
  }

  eq(other: TaskWidget) {
    return other.checked === this.checked && other.checkPosition === this.checkPosition;
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
          insert: this.checked ? " " : "x",
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

    button.textContent = this.empty ? "•" : this.collapsed ? "▸" : "▾";

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

function forgetAttachmentData(noteID: string, attachmentID: string) {
  const key = attachmentCacheKey(noteID, attachmentID);
  attachmentCacheBytes -= (attachmentDataCache.get(key)?.length ?? 0) * 2;
  attachmentDataCache.delete(key);
  attachmentDataRequests.delete(key);
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
  ) {
    super();
  }

  eq(other: AttachmentWidget) {
    return other.noteID === this.noteID &&
      other.attachmentID === this.attachmentID &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.align === this.align;
  }

  toDOM(view: EditorView) {
    const figure = document.createElement("span");
    figure.className = `cm-live-attachment align-${this.align}`;
    const image = figure.appendChild(document.createElement("img"));
    image.alt = this.alt;
    image.style.width = `${this.width}px`;
    image.style.maxWidth = "100%";
    image.draggable = false;
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
        });
        view.focus();
        forgetAttachmentData(this.noteID, this.attachmentID);
        void VaultService.DeleteAttachment(this.noteID, this.attachmentID)
          .catch(this.onError);
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

  toDOM(view: EditorView) {
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
  if (to <= from) return;
  const range = Decoration.mark({
    attributes: { "aria-hidden": "true" },
    class: "cm-live-syntax-hidden",
  }).range(from, to);
  decorations.push(range);
  atomicRanges.push(range);
}

function decorateInlineMarkdown(
  state: EditorState,
  lineNumber: number,
  text: string,
  offset: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
  openWikilink: (title: string) => void,
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

function decorateTaskMarker(
  text: string,
  offset: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
): boolean {
  const task = text.match(/^(?:[-+*]\s+)?\[([ xX])\]\s+/);
  if (!task) return false;
  const bracketOffset = text.indexOf("[");
  addHiddenRange(
    offset,
    offset + task[0].length,
    decorations,
    atomicRanges,
    new TaskWidget(
      task[1].toLowerCase() === "x",
      offset + bracketOffset + 1,
    ),
  );
  return true;
}

type ToggleLine = {
  indent: number;
  prefixSize: number;
  content: string;
};

function parentObjectPrefixForContinuation(state: EditorState, lineNumber: number): string | null {
  const line = state.doc.line(lineNumber);
  if (lineStartsObject(line.text)) return null;

  for (let previousNumber = lineNumber - 1; previousNumber >= 1; previousNumber--) {
    const previous = state.doc.line(previousNumber);
    if (previous.text.trim() === "") continue;
    if (!lineStartsObject(previous.text)) continue;
    if (line.text.trim() !== "" && lineIndent(line.text) < objectContentIndent(previous.text)) return null;
    const previousObject = classifyObjectLine(previous.text);
    return previousObject.tag === "section"
      ? repeatedObjectPrefix(previous.text)
      : previous.text.match(/^[ \t]*/)?.[0] ?? "";
  }

  return null;
}

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

function isSectionSeparatorLine(lines: readonly string[], lineNumber: number): boolean {
  return isSeparatorLine(lines, lineNumber);
}

function objectOwnerLineNumber(lines: readonly string[], lineNumber: number): number {
  return ownerLineNumberInLines(lines, lineNumber);
}

function toggleLine(text: string): ToggleLine | null {
  const match = text.match(/^([ \t]*)(>+)([ \t]?)(.*)$/);
  if (!match) return null;

  return {
    indent: visualIndent(match[1]) + (match[2].length - 1) * 2,
    prefixSize: match[1].length + match[2].length + match[3].length,
    content: match[4],
  };
}

function toggleLineStyle(): string {
  return "--toggle-padding-left: calc(var(--live-object-depth, 0) * 24px);";
}

function listLineStyle(markerWidth = "1.25em"): string {
  return `--live-list-indent: calc(var(--live-object-depth, 0) * 24px); --live-list-marker-width: ${markerWidth};`;
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

function toggleSectionEnd(
  state: EditorState,
  lines: readonly string[],
  objectDocument: ObjectDocument,
  startLineNumber: number,
  startIndent: number,
): number {
  let endLineNumber = startLineNumber;

  for (
    let lineNumber = startLineNumber + 1;
    lineNumber <= state.doc.lines;
    lineNumber++
  ) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    const owner = objectDocument.byLine.get(lineNumber);

    if (owner?.tag === "code") {
      if (lineNumber === owner.lineNumber && owner.indent <= startIndent) break;
      endLineNumber = owner.lineEnd;
      lineNumber = owner.lineEnd;
      continue;
    }

    if (isSectionSeparatorLine(lines, lineNumber)) break;

    if (
      text.trim() !== "" &&
      lineStartsObject(text) &&
      objectHierarchyIndent(text) <= startIndent
    ) break;

    endLineNumber = lineNumber;
  }

  return endLineNumber;
}

function toggleChildObjectLineNumbers(
  state: EditorState,
  lines: readonly string[],
  startLineNumber: number,
  startIndent: number,
): number[] {
  const children: number[] = [];

  for (
    let lineNumber = startLineNumber + 1;
    lineNumber <= state.doc.lines;
    lineNumber++
  ) {
    const line = state.doc.line(lineNumber);
    if (isSectionSeparatorLine(lines, lineNumber)) break;
    if (!lineStartsObject(line.text)) continue;
    if (objectHierarchyIndent(line.text) <= startIndent) break;
    children.push(lineNumber);
  }

  return children;
}

function toggleHasChildren(
  state: EditorState,
  lines: readonly string[],
  lineNumber: number,
  toggle: ToggleLine,
): boolean {
  return toggleChildObjectLineNumbers(state, lines, lineNumber, toggle.indent).length > 0;
}

function headingLevel(text: string): number | null {
  const match = text.match(/^(#{1,6})\s+/);
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
  lines: readonly string[] = state.doc.toString().split("\n"),
): number[] {
  const positions: number[] = [];

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const toggle = toggleLine(line.text);
    const level = headingLevel(line.text);

    if (toggle && toggleHasChildren(state, lines, lineNumber, toggle)) {
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
  lines: readonly string[],
  objectDocument: ObjectDocument,
  position: number,
  collapsed: Set<string>,
) {
  const line = state.doc.lineAt(position);
  const toggle = toggleLine(line.text);
  const level = headingLevel(line.text);

  if (line.from !== position) {
    collapsed.delete(collapseKeyForPosition(state, position, objectDocument));
    return;
  }

  const endLineNumber = toggle
    ? toggleSectionEnd(state, lines, objectDocument, line.number, toggle.indent)
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
    const toggle = toggleLine(line.text);
    const continuationOwner = continuationOwnerObject(objectDocument, lineNumber);

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
    if (attachment && !lineIsActive(state, lineNumber)) {
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
        ),
      );
      lineNumber++;
      continue;
    }

    if (toggle) {
      const toggleAttachment = parseAttachmentMarkdown(toggle.content);
      const sectionEndLineNumber = toggleSectionEnd(
        state,
        lines,
        objectDocument,
        lineNumber,
        toggle.indent,
      );

      const hasChildren = sectionEndLineNumber > lineNumber;
      const collapseKey = collapseKeyForPosition(state, line.from, objectDocument);
      const collapsed = hasChildren && nextCollapsed.has(collapseKey);
      const contentOffset = line.from + toggle.prefixSize;

      const isTask = !toggleAttachment && decorateTaskMarker(
        toggle.content,
        contentOffset,
        decorations,
        atomicRanges,
      );

      const toggleList = !toggleAttachment && !isTask &&
        toggle.content.match(/^([-*])\s+/);
      if (toggleList) {
        decorateUnorderedListMarker(
          contentOffset,
          toggleList[1] as "-" | "*",
          decorations,
          atomicRanges,
          contentOffset + toggleList[0].length,
        );
      }
      const toggleOrderedList = !toggleAttachment && !isTask && !toggleList &&
        toggle.content.match(/^(\d+[.)])\s+/);
      if (toggleOrderedList) {
        addHiddenRange(
          contentOffset,
          contentOffset + toggleOrderedList[0].length,
          decorations,
          atomicRanges,
          new TextWidget(toggleOrderedList[1], "cm-live-list-marker"),
        );
      }

      const classes = [
        "cm-live-toggle-line",
        hasChildren ? "cm-live-toggle-parent" : "cm-live-toggle-empty",
        collapsed ? "cm-live-toggle-collapsed" : "",
        toggleAttachment ? "cm-live-attachment-line" : "",
        isTask ? "cm-live-task-line" : "",
        isTask || toggleList || toggleOrderedList ? "cm-live-list-line" : "",
      ].filter(Boolean).join(" ");

      const toggleMarkerWidth = isTask ? "1.45em" : toggleOrderedList ? "2em" : "1.25em";
      decorations.push(
        Decoration.line({
          attributes: objectLineAttributes(
            lineNumber,
            classes,
            isTask || toggleList || toggleOrderedList
              ? `${toggleLineStyle()} ${listLineStyle(toggleMarkerWidth)}`
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

      if (toggleAttachment && !lineIsActive(state, lineNumber)) {
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
          ),
        );
      } else {
        decorateInlineMarkdown(
          state,
          lineNumber,
          toggle.content,
          contentOffset,
          decorations,
          atomicRanges,
          openWikilink,
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

    const heading = line.text.match(/^(#{1,6})\s+/);
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
        state,
        lineNumber,
        line.text.slice(heading[0].length),
        line.from + heading[0].length,
        decorations,
        atomicRanges,
        openWikilink,
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
        state,
        lineNumber,
        line.text.slice(prefixSize),
        line.from + prefixSize,
        decorations,
        atomicRanges,
        openWikilink,
      );
      lineNumber++;
      continue;
    }

    const bare = line.text.match(/^(\s*)<([ \t]?)/);
    const barePrefixSize = bare?.[0].length ?? 0;
    if (bare) {
      addHiddenRange(line.from, line.from + barePrefixSize, decorations, atomicRanges);
    }

    const indentation = line.text.match(/^\s*/)?.[0].length ?? 0;
    const task = decorateTaskMarker(
      line.text.slice(indentation),
      line.from + indentation,
      decorations,
      atomicRanges,
    );

    if (task) {
      if (indentation > 0) addHiddenRange(line.from, line.from + indentation, decorations, atomicRanges);
      decorations.push(Decoration.line({
        attributes: objectLineAttributes(
          lineNumber,
          "cm-live-task-line cm-live-list-line",
          listLineStyle("1.45em"),
          depthByLine.get(lineNumber) ?? 0,
        ),
      }).range(line.from));
    }

    const unorderedList = !task && line.text.match(/^(\s*)([-*])\s+/);
    if (unorderedList) {
      decorateUnorderedListMarker(
        line.from,
        unorderedList[2] as "-" | "*",
        decorations,
        atomicRanges,
        line.from + unorderedList[0].length,
      );
      decorations.push(Decoration.line({
        attributes: objectLineAttributes(
          lineNumber,
          "cm-live-list-line",
          listLineStyle(),
          depthByLine.get(lineNumber) ?? 0,
        ),
      }).range(line.from));
    }

    const orderedList = !task && !unorderedList && line.text.match(/^(\s*)(\d+[.)])\s+/);
    if (orderedList) {
      addHiddenRange(
        line.from,
        line.from + orderedList[0].length,
        decorations,
        atomicRanges,
        new TextWidget(orderedList[2], "cm-live-list-marker"),
      );
      decorations.push(Decoration.line({
        attributes: objectLineAttributes(
          lineNumber,
          "cm-live-list-line",
          listLineStyle("2em"),
          depthByLine.get(lineNumber) ?? 0,
        ),
      }).range(line.from));
    }

    if (!task && !unorderedList && !orderedList) {
      decorations.push(
        Decoration.line({
          attributes: lineAttributes(lineNumber),
        }).range(line.from),
      );
    }

    decorateInlineMarkdown(
      state,
      lineNumber,
      line.text.slice(barePrefixSize),
      line.from + barePrefixSize,
      decorations,
      atomicRanges,
      openWikilink,
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
  noteID: string,
  onError: (reason: unknown) => void,
  highlightLineNumbers: ReadonlySet<number>,
  defaultSectionsCollapsed: boolean,
) {
  const field = StateField.define<LivePreviewState>({
    create(state) {
      const docText = state.doc.toString();
      const context = {
        lines: docText.split("\n"),
        objectDocument: parseObjectDocument(docText),
      };
      const collapsed = savedCollapsedPositions(state, noteID) ?? (defaultSectionsCollapsed
        ? new Set(collapsibleQuotePositions(state, context.lines).map((position) => collapseKeyForPosition(state, position, context.objectDocument)))
        : new Set<string>());
      return buildLivePreviewState(
        state,
        collapsed,
        openWikilink,
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
            const docText = transaction.state.doc.toString();
            cachedContext = {
              lines: docText.split("\n"),
              objectDocument: parseObjectDocument(docText),
            };
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
          const { lines, objectDocument } = collapseContext();
          collapseChanged = true;
          collapsed.clear();
          if (effect.value) {
            for (const position of collapsibleQuotePositions(transaction.state, lines)) {
              collapsed.add(collapseKeyForPosition(transaction.state, position, objectDocument));
            }
          }
          continue;
        }
        if (effect.is(setQuoteCollapsed)) {
          const { lines, objectDocument } = collapseContext();
          collapseChanged = true;
          const key = collapseKeyForPosition(transaction.state, effect.value.position, objectDocument);
          if (effect.value.collapsed) collapsed.add(key);
          else expandToggleTree(
            transaction.state,
            lines,
            objectDocument,
            effect.value.position,
            collapsed,
          );
          continue;
        }
        if (!effect.is(toggleQuote)) continue;
        const { lines, objectDocument } = collapseContext();
        collapseChanged = true;
        const key = collapseKeyForPosition(transaction.state, effect.value, objectDocument);
        if (collapsed.has(key)) {
          expandToggleTree(transaction.state, lines, objectDocument, effect.value, collapsed);
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

  return field;
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

  view.dispatch({ changes });
  view.focus();
}

function snippetCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\/[A-Za-z]*/);
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
        applySnippetExpansion(view, snippet.trigger, from, to);
      },
    })),
    validFor: /^[A-Za-z]*$/,
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

function applySnippetExpansion(view: EditorView, trigger: string, from: number, to: number) {
  const isRoll = trigger === "rollb" || trigger === "rollf";
  const replacement = isRoll ? rollReplacementRange(view, from, to) : { from, to };
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

function expandSnippetBeforeCursor(view: EditorView) {
  const range = view.state.selection.main;
  if (!range.empty) return false;

  const before = view.state.sliceDoc(0, range.head);
  const match = before.match(/\/([A-Za-z]+)$/);
  if (!match) return false;

  const from = range.head - match[0].length;
  return applySnippetExpansion(view, match[1], from, range.head);
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

    const removable = line.text.match(/^ {1,2}|\t/)?.[0];
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
  const document = parseObjectDocument(view.state.doc.toString());
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
      const spaces = line.text.match(/^ {1,4}/)?.[0];
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

function closeCodeAfterBlankLine(view: EditorView) {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  const owner = parseObjectDocument(view.state.doc.toString()).byLine.get(line.number);
  if (owner?.tag !== "code" || line.number <= owner.lineNumber || line.text.trim() || range.head !== line.to) {
    return false;
  }

  const indent = view.state.doc.line(owner.lineNumber).text.match(/^[ \t]*/)?.[0] ?? "";
  if (owner.lineEnd > owner.textLineEnd) {
    const closing = view.state.doc.line(owner.lineEnd);
    if (closing.number === line.number + 1) {
      view.dispatch({ selection: EditorSelection.cursor(closing.to) });
    } else {
      const inserted = `\n${indent}` + "```";
      view.dispatch({
        changes: [
          { from: range.head, insert: inserted },
          { from: closing.from, to: closing.to, insert: "" },
        ],
        selection: EditorSelection.cursor(range.head + inserted.length),
      });
    }
  } else {
    const inserted = `\n${indent}` + "```";
    view.dispatch({
      changes: { from: range.head, insert: inserted },
      selection: EditorSelection.cursor(range.head + inserted.length),
    });
  }
  return true;
}

function insertNewlineAtOutlineDepth(view: EditorView) {
  const range = view.state.selection.main;
  if (!range.empty) return false;

  const line = view.state.doc.lineAt(range.head);
  const object = classifyObjectLine(line.text);
  const indentation = line.text.match(/^[ \t]*/)?.[0] ?? "";
  const section = line.text.match(/^([ \t]*>+[ \t]?)/);
  const bare = line.text.match(/^([ \t]*)<([ \t]?)/);
  const list = line.text.match(/^([ \t]*)(?:(\d+)([.)])|([-+*]))[ \t]+/);
  const continuationObjectPrefix = parentObjectPrefixForContinuation(view.state, line.number);
  const owner = parseObjectDocument(view.state.doc.toString()).byLine.get(line.number);
  const isCodeContent = owner?.tag === "code" && line.number > owner.lineNumber && line.number <= owner.textLineEnd;
  if (!isCodeContent && !lineStartsObject(line.text) && continuationObjectPrefix === null) return false;

  const inserted = isCodeContent
    ? `\n${indentation}`
    : continuationObjectPrefix
    ? `\n${continuationObjectPrefix}`
    : object.tag === "code"
    ? "\n"
    : object.tag === "section"
    ? `\n${section?.[1] ?? `${indentation}> `}`
    : bare
    ? `\n${bare[1]}< `
    : object.tag === "bulletpoint" && list
    ? `\n${indentation}${list[2] ? `${Number(list[2]) + 1}${list[3]}` : list[4]} `
    : `\n${indentation}`;

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

function setAllSectionsCollapsed(view: EditorView, collapsed: boolean) {
  view.dispatch({ effects: setAllQuotesCollapsed.of(collapsed) });
  view.focus();
  return true;
}

function currentToggleSectionPosition(state: EditorState): number | null {
  const lines = state.doc.toString().split("\n");
  const objectDocument = parseObjectDocument(state.doc.toString());
  const currentLineNumber = state.doc.lineAt(state.selection.main.head).number;
  const currentLine = state.doc.line(currentLineNumber);
  const currentToggle = toggleLine(currentLine.text);
  const currentHeadingLevel = headingLevel(currentLine.text);

  if (
    currentToggle &&
    toggleHasChildren(state, lines, currentLineNumber, currentToggle)
  ) {
    return currentLine.from;
  }

  if (
    currentHeadingLevel !== null &&
    headingHasChildren(state, currentLineNumber, currentHeadingLevel)
  ) {
    return currentLine.from;
  }

  for (let lineNumber = currentLineNumber - 1; lineNumber >= 1; lineNumber--) {
    const line = state.doc.line(lineNumber);
    const toggle = toggleLine(line.text);
    const level = headingLevel(line.text);

    if (!toggle && level === null) continue;

    const endLineNumber = toggle
      ? toggleSectionEnd(state, lines, objectDocument, lineNumber, toggle.indent)
      : headingSectionEnd(state, lineNumber, level!);

    if (endLineNumber >= currentLineNumber && endLineNumber > lineNumber) {
      return line.from;
    }
  }

  return null;
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

function objectLineElementAt(view: EditorView, x: number, y: number): HTMLElement | null {
  const elements = document.elementsFromPoint(x, y);
  let objectDocument: ObjectDocument | null = null;
  for (const element of elements) {
    let line: HTMLElement | null = null;
    if (element instanceof HTMLElement && element.matches(".cm-live-object-line[data-object-line]")) {
      line = element;
    } else if (element instanceof HTMLElement) {
      line = element.closest<HTMLElement>(".cm-live-object-line[data-object-line]");
    }

    if (line) {
      const lineNumber = Number(line.dataset.objectLine);
      if (!objectDocument) objectDocument = parseObjectDocument(view.state.doc.toString());
      const ownerLineNumber = Number.isFinite(lineNumber)
        ? objectDocument.byLine.get(lineNumber)?.lineNumber ?? lineNumber
        : lineNumber;
      const owner = Number.isFinite(ownerLineNumber)
        ? view.dom.querySelector<HTMLElement>(`.cm-live-object-line[data-object-line="${ownerLineNumber}"]`)
        : null;
      return owner ?? line;
    }
  }
  return null;
}

function dropModeForPoint(
  targetLine: HTMLElement,
  clientY: number,
  previous?: ObjectDropMode | null,
): ObjectDropMode {
  const rect = targetLine.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (previous === "before" && ratio < 0.4) return "before";
  if (previous === "after" && ratio > 0.6) return "after";
  if (previous === "child" && ratio > 0.2 && ratio < 0.8) return "child";
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
    selection: EditorSelection.cursor(Math.min(state.doc.line(sourceLineNumber).from, next.length)),
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
  onDecreaseFontSize,
  onIncreaseFontSize,
  searchTarget = null,
  onSearchTargetApplied,
  caretOffset = null,
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
  const onDecreaseFontSizeRef = useRef(onDecreaseFontSize);
  const onIncreaseFontSizeRef = useRef(onIncreaseFontSize);
  const onSearchTargetAppliedRef = useRef(onSearchTargetApplied);
  const onCaretChangeRef = useRef(onCaretChange);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);

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
    onDecreaseFontSizeRef.current = onDecreaseFontSize;
    onIncreaseFontSizeRef.current = onIncreaseFontSize;
    onSearchTargetAppliedRef.current = onSearchTargetApplied;
    onCaretChangeRef.current = onCaretChange;
  }, [onChange, onSave, onError, onOpenWikilink, onDecreaseFontSize, onIncreaseFontSize, onSearchTargetApplied, onCaretChange]);

  useEffect(() => {
    if (!host.current) return;

    const normalizedValue = normalizeArrowText(value);
    let scheduleJournalRules = () => {};
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: normalizedValue,
        extensions: [
          Prec.highest(keymap.of([
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
              key: "Enter",
              run: (editor) =>
                acceptCompletion(editor) ||
                expandSnippetBeforeCursor(editor) ||
                closeCodeAfterBlankLine(editor) ||
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
            override: [snippetCompletion],
          }),
          minimalSetup,
          history({ newGroupDelay: 250 }),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          markdown({ codeLanguages: languages }),
          deepCodeHighlightField,
          deepCodeHighlightLoader,
          liveMarkdownTheme,
          caretLocatorField,
          EditorView.lineWrapping,
          EditorView.inputHandler.of((inputView, from, to, text) => {
            if (readOnly) return false;
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
                const normalizedPrefix = normalizeStackedExclusiveObjectPrefix(prospective, previousLine);
                if (normalizedPrefix !== prospective) {
                  const prefixLength = normalizedPrefix.match(/^[ \t]*(?:(?:>+|[-*]|\d+[.)])[ \t]+|<[ \t]?)/)?.[0].length ?? 0;
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
              changeTo < inputView.state.doc.length &&
              inserted.endsWith("-") &&
              inputView.state.sliceDoc(changeTo, changeTo + 1) === ">"
            ) {
              changeTo++;
              inserted += ">";
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
            pointerdown(event, pointerView) {
              if (readOnly) return false;
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
                const targetLine = objectLineElementAt(pointerView, lastX, lastY);
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
                const targetLine = objectLineElementAt(pointerView, lastX, lastY);
                const targetLineNumber = Number(targetLine?.dataset.objectLine);
                if (!targetLine || !Number.isFinite(targetLineNumber)) return;
                moveObjectBlock(pointerView, sourceLine, targetLineNumber, lastY, targetLine, previewMode);
              };
              document.addEventListener("pointermove", move);
              document.addEventListener("pointerup", finish);
              document.addEventListener("pointercancel", finish);
              return true;
            },
            paste(event, pastedView) {
              if (readOnly) return false;
              const image = clipboardImage(event);
              if (!image && !clipboardMayContainImage(event)) {
                const text = event.clipboardData?.getData("text/plain") ?? "";
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
                  const actualInsertion = Math.min(insertion, pastedView.state.doc.length);
                  const line = pastedView.state.doc.lineAt(actualInsertion);
                  const prefix = actualInsertion > line.from ? "\n" : "";
                  const inserted = `${prefix}${markdown}\n`;
                  pastedView.dispatch({
                    changes: { from: actualInsertion, insert: inserted },
                    selection: EditorSelection.cursor(actualInsertion + inserted.length),
                  });
                })
                .catch((reason) => onErrorRef.current(reason));
              return true;
            },
          }),
          placeholder("Begin writing…"),
          livePreviewExtension(
            (title) => onOpenWikilinkRef.current(title),
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
          }),
        ],
      }),
    });
    const journalRules = installJournalRules(editor);
    scheduleJournalRules = journalRules.schedule;

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
                  runWithEditor((editor) => wrapSelection(editor, "**"));
                }}
              >
                <strong>B</strong>
              </button>
              <span className="markdown-toolbar-separator" />
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
                <span className="toolbar-toggle" aria-hidden="true">
                  ▾
                </span>
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
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${source.type};base64,${btoa(binary)}`;
}

export function clipboardImage(event: ClipboardEvent): Blob | string | null {
  const clipboard = event.clipboardData;
  if (!clipboard) return null;
  for (let index = 0; index < clipboard.items.length; index++) {
    const item = clipboard.items[index];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (let index = 0; index < clipboard.files.length; index++) {
    const file = clipboard.files[index];
    if (file.type.startsWith("image/")) return file;
  }
  const encoded = `${clipboard.getData("text/html")}\n${clipboard.getData("text/plain")}`;
  return embeddedClipboardImage(encoded);
}

export function clipboardClaimsImage(event: ClipboardEvent): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  for (let index = 0; index < clipboard.items.length; index++) {
    if (clipboard.items[index].type.startsWith("image/")) return true;
  }
  for (let index = 0; index < clipboard.types.length; index++) {
    const type = clipboard.types[index];
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
  return text === "" && !types.some((type) => type === "text/html");
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
