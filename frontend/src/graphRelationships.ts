export type RelationshipNote = { id: string; title: string; outgoingLinks?: string[] | null };

export function relationshipTargetID(notes: readonly RelationshipNote[], raw: string): string | null {
  const parts = raw.split("|").map((part) => part.trim());
  const explicitID = parts.find((part) => part.startsWith("note:"))?.slice(5);
  if (explicitID && notes.some((note) => note.id === explicitID)) return explicitID;
  return notes.find((note) => note.title.trim().toLocaleLowerCase() === parts[0].toLocaleLowerCase())?.id ?? null;
}

export type RelationshipLink = { from: string; to: string | null; label: string };

export function relationshipLinks(notes: readonly RelationshipNote[]): RelationshipLink[] {
  const links: RelationshipLink[] = [];
  for (const note of notes) {
    for (const raw of note.outgoingLinks ?? []) {
      links.push({ from: note.id, to: relationshipTargetID(notes, raw), label: raw.split("|")[0].trim() });
    }
  }
  return links;
}

export function graphModeIsEmpty(mode: "links" | "folders", noteCount: number, folderNodeCount: number): boolean {
  return mode === "links" ? noteCount === 0 : folderNodeCount === 0;
}
