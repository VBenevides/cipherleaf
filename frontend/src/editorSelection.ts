import { EditorSelection, type EditorState } from "@codemirror/state";
import type { ObjectDocument } from "./objectDocument";

export function expandedSelection(state: EditorState, document: ObjectDocument): EditorSelection {
  const current = state.selection.main;
  const object = document.byLine.get(state.doc.lineAt(current.head).number);
  let objectRange = object && { from: object.textFrom, to: object.textTo };
  if (object?.tag === "code") {
    const contentStart = object.lineNumber < state.doc.lines
      ? state.doc.line(object.lineNumber + 1).from
      : state.doc.length;
    objectRange = { from: contentStart, to: Math.max(contentStart, object.textTo) };
  }
  const next = [
    state.wordAt(current.head),
    objectRange,
    { from: 0, to: state.doc.length },
  ].find((range) =>
    range &&
    range.from <= current.from &&
    range.to >= current.to &&
    (range.from < current.from || range.to > current.to)
  );
  return next ? EditorSelection.single(next.from, next.to) : state.selection;
}
