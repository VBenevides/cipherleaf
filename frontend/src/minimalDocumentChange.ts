export function minimalDocumentChange<T>(
  state: {
    doc: { toString(): string };
    changes(change: { from: number; to: number; insert: string }): T;
  },
  next: string,
): T {
  const current = state.doc.toString();
  let from = 0;
  while (
    from < current.length &&
    from < next.length &&
    current.codePointAt(from) === next.codePointAt(from)
  )
    from++;
  let currentTo = current.length;
  let nextTo = next.length;
  while (
    currentTo > from &&
    nextTo > from &&
    current.codePointAt(currentTo - 1) === next.codePointAt(nextTo - 1)
  ) {
    currentTo--;
    nextTo--;
  }
  return state.changes({
    from,
    to: currentTo,
    insert: next.slice(from, nextTo),
  });
}
