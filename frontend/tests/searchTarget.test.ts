import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import {
  rangeForActiveDocument,
  searchHighlightField,
  searchTargetTransaction,
  setSearchHighlight,
  targetForMatch,
  utf8ByteOffsetToUtf16Offset,
} from "../src/searchTarget.ts";

function highlightRanges(state: EditorState) {
  const ranges: Array<{ from: number; to: number; className: string | undefined }> = [];
  state.field(searchHighlightField).between(0, state.doc.length, (from, to, value) => {
    ranges.push({ from, to, className: value.spec.class });
  });
  return ranges;
}

test("resolves a content result in the current note", () => {
  const target = targetForMatch({
    noteId: "current",
    field: "content",
    offset: 7,
    matchLength: 6,
  });

  assert.deepEqual(rangeForActiveDocument(target, "current", "before needle after"), {
    from: 7,
    to: 13,
  });
  assert.equal(targetForMatch({
    noteId: "current",
    field: "title",
    offset: 0,
    matchLength: 1,
  }), null);
});

test("waits for a newly opened note before resolving its result", () => {
  const target = targetForMatch({
    noteId: "new-note",
    field: "content",
    offset: 7,
    matchLength: 5,
  });

  assert.equal(rangeForActiveDocument(target, "old-note", "old document"), null);
  assert.deepEqual(rangeForActiveDocument(target, "new-note", "before match"), {
    from: 7,
    to: 12,
  });
});

test("converts Go UTF-8 offsets to CodeMirror UTF-16 offsets", () => {
  const document = "préfix 😀 needle";
  const target = targetForMatch({
    noteId: "unicode",
    field: "content",
    offset: 13,
    matchLength: 6,
  });

  assert.equal(utf8ByteOffsetToUtf16Offset("é", 1), null);
  assert.deepEqual(rangeForActiveDocument(target, "unicode", document), {
    from: 10,
    to: 16,
  });
});

test("uses UTF-16 offsets calculated by Go", () => {
  const target = targetForMatch({
    noteId: "unicode",
    field: "content",
    offset: 13,
    matchLength: 6,
    utf16Offset: 10,
    utf16MatchLength: 6,
  });

  assert.deepEqual(rangeForActiveDocument(target, "unicode", "préfix 😀 needle"), {
    from: 10,
    to: 16,
  });
});

test("resolves the query when Live Preview normalizes the document", () => {
  const source = "first -> target\nsecond -> target";
  const document = source.replaceAll("->", "→");
  const offset = new TextEncoder().encode(source.slice(0, source.lastIndexOf("target"))).length;
  const target = targetForMatch(
    { noteId: "normalized", field: "content", offset, matchLength: 6 },
    "target",
  );

  const range = rangeForActiveDocument(target, "normalized", document, source);
  assert.deepEqual(range, {
    from: document.lastIndexOf("target"),
    to: document.lastIndexOf("target") + 6,
  });
});

test("selects, centers, and clears the search highlight after an edit or note switch", () => {
  let state = EditorState.create({
    doc: "before needle after",
    extensions: [searchHighlightField],
  });
  const transaction = state.update(searchTargetTransaction({ from: 7, to: 13 }));
  state = transaction.state;

  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: 7, to: 13 },
  );
  assert.equal((transaction.effects[1].value as unknown as { y: string }).y, "center");
  assert.deepEqual(highlightRanges(state), [
    { from: 7, to: 13, className: "cm-live-search-highlight" },
  ]);

  const switchedNote = EditorState.create({
    doc: "a different note",
    extensions: [searchHighlightField],
  });
  assert.deepEqual(highlightRanges(switchedNote), []);

  state = state.update({ changes: { from: 0, insert: "!" } }).state;
  assert.deepEqual(highlightRanges(state), []);

  state = state.update({ effects: setSearchHighlight.of(null) }).state;
  assert.deepEqual(highlightRanges(state), []);
});
