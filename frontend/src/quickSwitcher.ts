export type SwitcherNote = { id: string; title: string };

export function rankQuickSwitcher<T extends SwitcherNote>(notes: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return notes.slice(0, 20);
  return notes
    .map((note) => ({ note, score: fuzzyScore(note.title.toLocaleLowerCase(), needle) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => left.score - right.score || left.note.title.localeCompare(right.note.title))
    .slice(0, 20)
    .map((item) => item.note);
}

function fuzzyScore(value: string, query: string): number {
  const exact = value.indexOf(query);
  if (exact >= 0) return exact + (value.length - query.length) / 100;
  let cursor = 0;
  let score = 0;
  for (const character of query) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return -1;
    score += index - cursor;
    cursor = index + 1;
  }
  return score + 100 + (value.length - query.length) / 100;
}
