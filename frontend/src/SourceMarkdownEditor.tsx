import { useEffect, useRef } from "react";
import { Annotation, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
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
};

const externalDocumentUpdate = Annotation.define<boolean>();

export default function SourceMarkdownEditor({
  noteID,
  value,
  onChange,
  onError,
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
          markdown(),
          search({ top: false }),
          keymap.of([
            ...searchKeymap,
            {
              key: "Mod-h",
              preventDefault: true,
              run: (current) => openSearchPanel(current),
            },
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "Source Markdown editor",
            spellcheck: "true",
          }),
          EditorView.domEventHandlers({
            paste(event, pastedView) {
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

  return <div ref={host} className="source-markdown-editor live-markdown-editor" />;
}
