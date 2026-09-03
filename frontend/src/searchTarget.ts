import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

type FindMatchLike = {
  noteId: string;
  field: string;
  offset: number;
  matchLength: number;
  utf16Offset?: number;
  utf16MatchLength?: number;
};

export type SearchTarget = Readonly<{
  noteID: string;
  /** UTF-8 byte offset reported by the Go vault service. */
  offset: number;
  /** UTF-8 byte length reported by the Go vault service. */
  matchLength: number;
  /** JavaScript string offset calculated by the Go vault service. */
  utf16Offset?: number;
  /** JavaScript string length calculated by the Go vault service. */
  utf16MatchLength?: number;
  /** The literal query, used to resolve offsets after editor normalization. */
  query: string;
}>;

export type SearchRange = Readonly<{
  from: number;
  to: number;
}>;

const utf8Encoder = new TextEncoder();
const searchHighlight = Decoration.mark({ class: "cm-live-search-highlight" });

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidRange(range: SearchRange, documentLength: number): boolean {
  return (
    isNonNegativeSafeInteger(range.from) &&
    isNonNegativeSafeInteger(range.to) &&
    range.from < range.to &&
    range.to <= documentLength
  );
}

/** Converts a Go UTF-8 byte offset to a JavaScript UTF-16 string offset. */
export function utf8ByteOffsetToUtf16Offset(document: string, utf8Offset: number): number | null {
  if (!isNonNegativeSafeInteger(utf8Offset)) return null;

  let byteOffset = 0;
  let utf16Offset = 0;
  for (const character of document) {
    if (byteOffset === utf8Offset) return utf16Offset;
    byteOffset += utf8Encoder.encode(character).byteLength;
    utf16Offset += character.length;
    if (byteOffset > utf8Offset) return null;
  }

  return byteOffset === utf8Offset ? utf16Offset : null;
}

/** Creates a target only for a content result with a non-empty, valid range. */
export function targetForMatch(match: FindMatchLike, query = ""): SearchTarget | null {
  const rangeEnd = match.offset + match.matchLength;
  const hasUTF16Range =
    isNonNegativeSafeInteger(match.utf16Offset ?? -1) &&
    isNonNegativeSafeInteger(match.utf16MatchLength ?? -1) &&
    (match.utf16MatchLength ?? 0) > 0;
  if (
    match.field !== "content" ||
    !match.noteId ||
    !isNonNegativeSafeInteger(match.offset) ||
    !Number.isSafeInteger(match.matchLength) ||
    match.matchLength <= 0 ||
    !Number.isSafeInteger(rangeEnd)
  ) {
    return null;
  }

  return {
    noteID: match.noteId,
    offset: match.offset,
    matchLength: match.matchLength,
    utf16Offset: hasUTF16Range ? match.utf16Offset : undefined,
    utf16MatchLength: hasUTF16Range ? match.utf16MatchLength : undefined,
    query: query.trim(),
  };
}

function queryRanges(document: string, query: string): SearchRange[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  let expression: RegExp;
  try {
    expression = new RegExp(escaped, "giu");
  } catch {
    return [];
  }

  const ranges: SearchRange[] = [];
  for (const match of document.matchAll(expression)) {
    const from = match.index ?? -1;
    if (from < 0) continue;
    ranges.push({ from, to: from + match[0].length });
  }
  return ranges;
}

function nearestQueryRange(
  ranges: readonly SearchRange[],
  approximateFrom: number,
): SearchRange | null {
  let nearest: SearchRange | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    const distance = Math.abs(range.from - approximateFrom);
    if (distance < nearestDistance) {
      nearest = range;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Resolves a target only after the selected note's editor document is available. */
export function rangeForActiveDocument(
  target: SearchTarget | null | undefined,
  activeNoteID: string,
  document: string,
  sourceDocument = document,
): SearchRange | null {
  if (target?.noteID !== activeNoteID) return null;

  const utf8End = target.offset + target.matchLength;
  if (!Number.isSafeInteger(utf8End)) return null;

  const from = target.utf16Offset ?? utf8ByteOffsetToUtf16Offset(document, target.offset);
  const to = target.utf16Offset !== undefined && target.utf16MatchLength !== undefined
    ? target.utf16Offset + target.utf16MatchLength
    : utf8ByteOffsetToUtf16Offset(document, utf8End);
  const renderedRanges = queryRanges(document, target.query);
  const sourceRanges = queryRanges(sourceDocument, target.query);
  const sourceFrom = target.utf16Offset ??
    utf8ByteOffsetToUtf16Offset(sourceDocument, target.offset);
  const sourceRange = nearestQueryRange(
    sourceRanges,
    sourceFrom ?? Math.min(target.offset, sourceDocument.length),
  );
  const sourceIndex = sourceRange ? sourceRanges.indexOf(sourceRange) : -1;
  const queryRange = sourceIndex >= 0
    ? renderedRanges[sourceIndex] ?? null
    : nearestQueryRange(renderedRanges, from ?? Math.min(target.offset, document.length));
  if (queryRange) return queryRange;
  if (from === null || to === null || !isValidRange({ from, to }, document.length)) return null;
  return { from, to };
}

export const setSearchHighlight = StateEffect.define<SearchRange | null>();

/** A transient search-result decoration that is discarded on any document edit. */
export const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(highlights, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setSearchHighlight)) continue;
      const range = effect.value;
      return range && isValidRange(range, transaction.state.doc.length)
        ? Decoration.set([searchHighlight.range(range.from, range.to)])
        : Decoration.none;
    }
    return transaction.docChanged ? Decoration.none : highlights.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Builds the CodeMirror update that selects, centers, and highlights a result. */
export function searchTargetTransaction(range: SearchRange) {
  return {
    selection: EditorSelection.range(range.from, range.to),
    effects: [
      setSearchHighlight.of(range),
      EditorView.scrollIntoView(range.from, { y: "center" }),
    ],
  };
}
