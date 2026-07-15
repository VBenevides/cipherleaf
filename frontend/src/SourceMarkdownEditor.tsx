import { useEffect, useRef } from "react";
import { Annotation, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { history, redo, undo } from "@codemirror/commands";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { minimalSetup } from "codemirror";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import { attachmentMarkdown } from "./markdown";
import {
  clipboardImage,
  clipboardMayContainImage,
  imageDataURL,
  readClipboardImage,
} from "./LiveMarkdownEditor";

type Props = {
  noteID: string;
  value: string;
  onChange: (value: string) => void;
  onError: (reason: unknown) => void;
  readOnly?: boolean;
  scrollSync?: {
    register: (scroller: HTMLElement) => () => void;
    sync: (source: HTMLElement) => void;
  };
};

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

export default function SourceMarkdownEditor({
  noteID,
  value,
  onChange,
  onError,
  readOnly = false,
  scrollSync,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onChangeRef.current = onChange;
    onErrorRef.current = onError;
  }, [onChange, onError]);

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          minimalSetup,
          EditorState.readOnly.of(readOnly),
          history({ newGroupDelay: 250 }),
          markdown({ codeLanguages: languages }),
          search({ top: false }),
          keymap.of([
            ...searchKeymap,
            {
              key: "Mod-z",
              preventDefault: true,
              run: (current) => undo(current),
            },
            {
              key: "Ctrl-r",
              preventDefault: true,
              run: (current) => redo(current),
            },
            {
              key: "Ctrl-Shift-z",
              preventDefault: true,
              run: (current) => redo(current),
            },
            {
              key: "Mod-h",
              preventDefault: true,
              run: (current) => openSearchPanel(current),
            },
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": readOnly ? "Portable Markdown" : "Raw Markdown editor",
            "aria-readonly": readOnly ? "true" : "false",
            spellcheck: "true",
          }),
          EditorView.domEventHandlers({
            paste(event, pastedView) {
              if (readOnly) return false;
              const image = clipboardImage(event);
              if (!image && !clipboardMayContainImage(event)) return false;
              event.preventDefault();
              const insertion = pastedView.state.selection.main.from;
              void (image ? Promise.resolve(image) : readClipboardImage())
                .then((source) => {
                  if (!source) throw new Error("Could not read image data from the clipboard");
                  return imageDataURL(source);
                })
                .then((data) => VaultService.SaveImageAttachment(noteID, data))
                .then((id) => {
                  const actualInsertion = Math.min(insertion, pastedView.state.doc.length);
                  const line = pastedView.state.doc.lineAt(actualInsertion);
                  const prefix = actualInsertion > line.from ? "\n" : "";
                  const inserted = `${prefix}${attachmentMarkdown(id)}\n`;
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
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(externalDocumentUpdate),
              )
            ) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    const syncScroll = () => scrollSync?.sync(editor.scrollDOM);
    const unregisterScroll = scrollSync?.register(editor.scrollDOM);
    editor.scrollDOM.addEventListener("scroll", syncScroll, { passive: true });
    return () => {
      editor.scrollDOM.removeEventListener("scroll", syncScroll);
      unregisterScroll?.();
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      selection: preservedSelection(editor, value.length),
      annotations: [
        externalDocumentUpdate.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }, [value]);

  return <div ref={host} className="source-markdown-editor live-markdown-editor" />;
}
