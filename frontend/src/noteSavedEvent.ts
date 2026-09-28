export type NoteSavedEvent = {
  vaultId: string;
  noteID: string;
  revision: number;
};

export function parseNoteSavedEvent(event: unknown): NoteSavedEvent | null {
  const raw =
    event && typeof event === "object" && "data" in event ? event.data : event;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !("vaultId" in raw) ||
    !("noteId" in raw) ||
    !("revision" in raw)
  )
    return null;
  const { vaultId, noteId, revision } = raw;
  if (
    typeof vaultId !== "string" ||
    !vaultId ||
    typeof noteId !== "string" ||
    !noteId ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    return null;
  return { vaultId, noteID: noteId, revision };
}
