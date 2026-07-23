export type RelationshipNote = { id: string; title: string; outgoingLinks?: string[] | null };

type RelationshipLookup = {
  ids: ReadonlySet<string>;
  titles: ReadonlyMap<string, string>;
};

function relationshipLookup(notes: readonly RelationshipNote[]): RelationshipLookup {
  const titles = new Map<string, string>();
  for (const { id, title } of notes) {
    const normalized = title.trim().toLocaleLowerCase();
    if (!titles.has(normalized)) titles.set(normalized, id);
  }
  return {
    ids: new Set(notes.map(({ id }) => id)),
    titles,
  };
}

function targetID(lookup: RelationshipLookup, raw: string): string | null {
  const parts = raw.split("|").map((part) => part.trim());
  const explicitID = parts.find((part) => part.startsWith("note:"))?.slice(5);
  if (explicitID && lookup.ids.has(explicitID)) return explicitID;
  return lookup.titles.get(parts[0].toLocaleLowerCase()) ?? null;
}

export function relationshipTargetID(notes: readonly RelationshipNote[], raw: string): string | null {
  return targetID(relationshipLookup(notes), raw);
}

export type RelationshipLink = { from: string; to: string | null; label: string };

export function relationshipLinks(notes: readonly RelationshipNote[]): RelationshipLink[] {
  const lookup = relationshipLookup(notes);
  const links: RelationshipLink[] = [];
  for (const note of notes) {
    for (const raw of note.outgoingLinks ?? []) {
      links.push({ from: note.id, to: targetID(lookup, raw), label: raw.split("|")[0].trim() });
    }
  }
  return links;
}

export function graphModeIsEmpty(mode: "links" | "folders", noteCount: number, folderNodeCount: number): boolean {
  return mode === "links" ? noteCount === 0 : folderNodeCount === 0;
}
