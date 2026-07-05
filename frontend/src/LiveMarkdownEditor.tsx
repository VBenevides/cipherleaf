import { useEffect, useRef } from "react";
import {
  Annotation,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { minimalSetup } from "codemirror";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { openSearchPanel, searchKeymap, search } from "@codemirror/search";
import { isHorizontalRule } from "./markdown";
import { SNIPPETS, expandSnippet } from "./snippets";

type LiveMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onOpenWikilink: (title: string) => void;
  scrollToOffset?: number | null;
};

type LivePreviewState = {
  collapsedQuotes: ReadonlySet<number>;
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
};

const externalDocumentUpdate = Annotation.define<boolean>();
const toggleQuote = StateEffect.define<number>({
  map: (position, changes) => changes.mapPos(position),
});

const liveMarkdownTheme = EditorView.theme(
  {
    "&": {
      "--outline-indent-step": "2ch",
      "--outline-section-bg": "rgba(127, 127, 127, 0.08)",
      "--outline-section-border": "rgba(127, 127, 127, 0.32)",
      "--outline-section-radius": "8px",
    },

  ".cm-line.cm-live-outline-line": {
    position: "relative",
    boxSizing: "border-box",
    background: "var(--outline-section-bg)",
    paddingLeft:
      "calc(1.5rem + var(--outline-depth, 0) * var(--outline-indent-step))",
    paddingTop: "2px",
    paddingBottom: "2px",
    borderLeft: "2px solid var(--outline-section-border)",
  },

  ".cm-line.cm-live-outline-start": {
    borderTopLeftRadius: "var(--outline-section-radius)",
    borderTopRightRadius: "var(--outline-section-radius)",
  },

  ".cm-line.cm-live-outline-end": {
    borderBottomLeftRadius: "var(--outline-section-radius)",
    borderBottomRightRadius: "var(--outline-section-radius)",
  },

  ".cm-live-quote-toggle, .cm-live-outline-spacer": {
    display: "inline-flex",
    width: "1.25rem",
    marginLeft: "-1.25rem",
    justifyContent: "center",
    alignItems: "center",
  },
});

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
    element.className = "cm-live-folded-quote";
    element.textContent = ` … ${this.hiddenLines} hidden ${this.hiddenLines === 1 ? "line" : "lines"}`;
    return element;
  }
}

class QuoteToggleWidget extends WidgetType {
  constructor(
    readonly position: number,
    readonly collapsed: boolean,
  ) {
    super();
  }

  eq(other: QuoteToggleWidget) {
    return other.position === this.position && other.collapsed === this.collapsed;
  }

  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-live-quote-toggle ${this.collapsed ? "is-collapsed" : ""}`;
    button.setAttribute("aria-label", this.collapsed ? "Expand quoted section" : "Collapse quoted section");
    button.setAttribute("aria-expanded", String(!this.collapsed));
    button.title = this.collapsed ? "Expand quoted section" : "Collapse quoted section";
    button.textContent = "⌄";
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
    const link = document.createElement("span");
    link.className = "cm-live-wikilink";
    link.textContent = this.title;
    link.title = `Hold Ctrl and click to open “${this.title}”`;
    link.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        this.open(this.title);
        return;
      }
      view.dispatch({ selection: { anchor: this.position } });
      view.focus();
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

function decorateInlineMarkdown(
  state: EditorState,
  lineNumber: number,
  text: string,
  offset: number,
  decorations: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
  openWikilink: (title: string) => void,
) {
  const active = lineIsActive(state, lineNumber);

  const bold = /(\*\*|__)(?=\S)(.+?\S)\1/g;
  for (const match of text.matchAll(bold)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const markerSize = match[1].length;
    const end = start + match[0].length;
    decorations.push(
      Decoration.mark({ class: "cm-live-strong" }).range(start + markerSize, end - markerSize),
    );
    if (!active) {
      addHiddenRange(start, start + markerSize, decorations, atomicRanges);
      addHiddenRange(end - markerSize, end, decorations, atomicRanges);
    }
  }

  const italic = /(^|[^*_])([*_])(?=\S)([^*_\n]*?\S)\2(?![*_])/g;
  for (const match of text.matchAll(italic)) {
    if (match.index === undefined) continue;
    const start = offset + match.index + match[1].length;
    const end = start + match[2].length + match[3].length + match[2].length;
    decorations.push(Decoration.mark({ class: "cm-live-em" }).range(start + 1, end - 1));
    if (!active) {
      addHiddenRange(start, start + 1, decorations, atomicRanges);
      addHiddenRange(end - 1, end, decorations, atomicRanges);
    }
  }

  const inlineCode = /`([^`\n]+)`/g;
  for (const match of text.matchAll(inlineCode)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const end = start + match[0].length;
    decorations.push(Decoration.mark({ class: "cm-live-code" }).range(start + 1, end - 1));
    if (!active) {
      addHiddenRange(start, start + 1, decorations, atomicRanges);
      addHiddenRange(end - 1, end, decorations, atomicRanges);
    }
  }

  const strike = /~~(?=\S)(.+?\S)~~/g;
  for (const match of text.matchAll(strike)) {
    if (match.index === undefined) continue;
    const start = offset + match.index;
    const end = start + match[0].length;
    decorations.push(Decoration.mark({ class: "cm-live-strike" }).range(start + 2, end - 2));
    if (!active) {
      addHiddenRange(start, start + 2, decorations, atomicRanges);
      addHiddenRange(end - 2, end, decorations, atomicRanges);
    }
  }

  if (!active) {
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

function outlineLine(text: string) {
  const match = text.match(/^(\s*)((?:>\s*)+)(.*)$/);
  if (!match) return null;
  return {
    prefixSize: match[1].length + match[2].length,
    depth: (match[2].match(/>/g) ?? []).length,
    content: match[3],
  };
}

function buildLivePreviewState(
  state: EditorState,
  collapsedQuotes: ReadonlySet<number>,
  openWikilink: (title: string) => void,
): LivePreviewState {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const nextCollapsed = new Set(collapsedQuotes);

  for (let lineNumber = 1; lineNumber <= state.doc.lines;) {
    const line = state.doc.line(lineNumber);
    const outline = outlineLine(line.text);

    if (outline) {
      let lastDescendant = lineNumber;
      for (let candidate = lineNumber + 1; candidate <= state.doc.lines; candidate++) {
        const nested = outlineLine(state.doc.line(candidate).text);
        if (!nested || nested.depth <= outline.depth) break;
        lastDescendant = candidate;
      }

      const hasChildren = lastDescendant > lineNumber;
      const collapsed = hasChildren && nextCollapsed.has(line.from);
      const contentOffset = line.from + outline.prefixSize;

      const previousOutline =
        lineNumber > 1 ? outlineLine(state.doc.line(lineNumber - 1).text) : null;

      const nextOutline =
        lineNumber < state.doc.lines ? outlineLine(state.doc.line(lineNumber + 1).text) : null;

      const startsOutlineGroup = !previousOutline;
      const endsOutlineGroup = collapsed || !nextOutline;

      const isTask = decorateTaskMarker(
        outline.content,
        contentOffset,
        decorations,
        atomicRanges,
      );

      const outlineList = !isTask && outline.content.match(/^([-+*])\s+/);
      if (outlineList) {
        addHiddenRange(
          contentOffset,
          contentOffset + outlineList[0].length,
          decorations,
          atomicRanges,
          new TextWidget("•", "cm-live-bullet"),
        );
      }

      const classes = [
        "cm-live-outline-line",
        startsOutlineGroup ? "cm-live-outline-start" : "",
        endsOutlineGroup ? "cm-live-outline-end" : "",
        hasChildren ? "cm-live-outline-parent" : "",
        collapsed ? "cm-live-outline-collapsed" : "",
        isTask ? "cm-live-task-line" : "",
        outlineList ? "cm-live-list-line" : "",
      ].filter(Boolean).join(" ");

      decorations.push(
        Decoration.line({
          attributes: {
            class: classes,
            style: `--outline-depth: ${Math.max(0, outline.depth - 1)}`,
          },
        }).range(line.from),
      );

      decorations.push(
        Decoration.widget({
          widget: hasChildren
            ? new QuoteToggleWidget(line.from, collapsed)
            : new TextWidget("", "cm-live-outline-spacer"),
          side: -1,
        }).range(line.from),
      );

      addHiddenRange(
        line.from,
        contentOffset,
        decorations,
        atomicRanges,
      );

      decorateInlineMarkdown(
        state,
        lineNumber,
        outline.content,
        contentOffset,
        decorations,
        atomicRanges,
        openWikilink,
      );

      if (collapsed) {
        const lastLine = state.doc.line(lastDescendant);
        addHiddenRange(
          line.to,
          lastLine.to,
          decorations,
          atomicRanges,
          new FoldedQuoteWidget(lastDescendant - lineNumber),
        );
        lineNumber = lastDescendant + 1;
      } else {
        lineNumber++;
      }
      continue;
    }

    if (isHorizontalRule(line.text)) {
      decorations.push(
        Decoration.line({ class: "cm-live-horizontal-rule-line" }).range(line.from),
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
      decorations.push(
        Decoration.line({ class: `cm-live-heading cm-live-h${level}` }).range(line.from),
      );
      if (!lineIsActive(state, lineNumber)) {
        addHiddenRange(
          line.from,
          line.from + heading[0].length,
          decorations,
          atomicRanges,
        );
      }
    }

    const indentation = line.text.match(/^\s*/)?.[0].length ?? 0;
    const task = decorateTaskMarker(
      line.text.slice(indentation),
      line.from + indentation,
      decorations,
      atomicRanges,
    );

    if (task) {
      decorations.push(Decoration.line({ class: "cm-live-task-line" }).range(line.from));
    }

    const unorderedList = !task && line.text.match(/^(\s*)([-+*])\s+/);
    if (unorderedList) {
      const markerStart = line.from + unorderedList[1].length;
      addHiddenRange(
        markerStart,
        markerStart + unorderedList[2].length + 1,
        decorations,
        atomicRanges,
        new TextWidget("•", "cm-live-bullet"),
      );
      decorations.push(Decoration.line({ class: "cm-live-list-line" }).range(line.from));
    }

    decorateInlineMarkdown(
      state,
      lineNumber,
      line.text,
      line.from,
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
  };
}

function livePreviewExtension(openWikilink: (title: string) => void) {
  const field = StateField.define<LivePreviewState>({
    create(state) {
      return buildLivePreviewState(state, new Set(), openWikilink);
    },
    update(value, transaction) {
      const collapsed = new Set<number>();
      for (const position of value.collapsedQuotes) {
        collapsed.add(transaction.changes.mapPos(position));
      }
      for (const effect of transaction.effects) {
        if (!effect.is(toggleQuote)) continue;
        if (collapsed.has(effect.value)) collapsed.delete(effect.value);
        else collapsed.add(effect.value);
      }
      return buildLivePreviewState(transaction.state, collapsed, openWikilink);
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
      const insert = `${marker}${selected}${marker}`;
      const contentFrom = range.from + marker.length;
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
      const outlinePrefix = line.text.match(/^\s*(?:>\s*)+/)?.[0];
      const indentation = line.text.match(/^\s*/)?.[0].length ?? 0;
      return {
        from: line.from + (outlinePrefix?.length ?? indentation),
        insert: prefix,
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
        const expansion = expandSnippet(snippet.trigger);
        view.dispatch({
          changes: { from, to, insert: expansion },
          selection: EditorSelection.cursor(from + expansion.length),
        });
      },
    })),
    validFor: /^[A-Za-z]*$/,
  };
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
    const match = line.text.match(/^(\s*)(>+)/);
    if (!match) continue;

    const markerStart = line.from + match[1].length;

    if (direction === 1) {
      changes.push({ from: markerStart, insert: ">" });
    } else if (match[2].length > 1) {
      changes.push({ from: markerStart, to: markerStart + 1, insert: "" });
    }
  }

  if (changes.length === 0) return false;

  view.dispatch({ changes });
  view.focus();

  return true;
}

export default function LiveMarkdownEditor({
  value,
  onChange,
  onSave,
  onOpenWikilink,
  scrollToOffset,
}: LiveMarkdownEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  const pendingScroll = useRef<number | null>(scrollToOffset ?? null);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onOpenWikilinkRef.current = onOpenWikilink;
  }, [onChange, onSave, onOpenWikilink]);

  useEffect(() => {
    if (typeof scrollToOffset === "number") {
      pendingScroll.current = scrollToOffset;
    }
  }, [scrollToOffset]);

  useEffect(() => {
    if (!host.current) return;

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([
            {
              key: "Tab",
              run: (editor) => changeOutlineDepth(editor, 1),
            },
            {
              key: "Shift-Tab",
              run: (editor) => changeOutlineDepth(editor, -1),
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
          ]),
          search(),
          keymap.of(searchKeymap),
          autocompletion({
            override: [snippetCompletion],
          }),
          minimalSetup,
          markdown(),
          liveMarkdownTheme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "Live Preview Markdown editor",
            spellcheck: "true",
          }),
          placeholder("Begin writing…"),
          livePreviewExtension((title) => onOpenWikilinkRef.current(title)),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(externalDocumentUpdate),
              )
            ) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (pendingScroll.current !== null) {
              const target = pendingScroll.current;
              pendingScroll.current = null;
              const doc = update.state.doc;
              if (target >= 0 && target <= doc.length) {
                update.view.dispatch({
                  selection: { anchor: target },
                  effects: EditorView.scrollIntoView(target, { y: "center" }),
                });
                update.view.focus();
              }
            }
          }),
        ],
      }),
    });

    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      annotations: externalDocumentUpdate.of(true),
    });
  }, [value]);

  const runWithEditor = (action: (editor: EditorView) => void) => {
    if (view.current) action(view.current);
  };

  return (
    <div className="live-editor-frame">
      <div className="markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
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
        <button
          type="button"
          title="Italic"
          aria-label="Make text italic"
          onMouseDown={(event) => {
            event.preventDefault();
            runWithEditor((editor) => wrapSelection(editor, "_"));
          }}
        >
          <em>I</em>
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
      </div>
      <div ref={host} className="live-markdown-editor" />
    </div>
  );
}
