export function noteIDForShortcutTarget(target: string): string | null {
  return target.startsWith("note:") && target.length > "note:".length
    ? target.slice("note:".length)
    : null;
}

export function targetTabForShortcut<T extends { noteID: string }>(
  target: string,
  tabs: readonly T[],
): T | null {
  const noteID = noteIDForShortcutTarget(target);
  return noteID ? (tabs.find((tab) => tab.noteID === noteID) ?? null) : null;
}
