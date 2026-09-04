import { cardReference, normalizeCardTags, parseBoardMarker, type CardMetadata } from "./cards.ts";
import {
  markdownFromCanonicalObjectDocument,
  parseObjectDocument,
  type CanonicalObjectDocument,
  type ObjectLine,
} from "./objectDocument.ts";
import { rollFirstDatedSection } from "./snippets.ts";

export const CARD_JOURNAL_START = "<!-- cipherleaf-card-journal:start -->";
export const CARD_JOURNAL_END = "<!-- cipherleaf-card-journal:end -->";

const journalBlock = new RegExp(
  String.raw`(?:^|\n)${escapeRegExp(CARD_JOURNAL_START)}\n[\s\S]*?\n${escapeRegExp(CARD_JOURNAL_END)}(?=\n|$)`,
  "g",
);

const journalMarkers = new RegExp(
  String.raw`${escapeRegExp(CARD_JOURNAL_START)}\n|${escapeRegExp(CARD_JOURNAL_END)}(?=\n|$)`,
  "g",
);

type ObjectEntry = {
  object: ObjectLine;
  key: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function objectOwnKey(object: ObjectLine): unknown[] {
  return [
    object.tag,
    object.tags,
    object.text,
    object.checked,
    object.language,
    object.closed,
    object.indent,
    object.contentIndent,
    object.sourcePrefix,
    object.attachmentId,
    object.attachmentKind,
  ];
}

function objectEntries(markdown: string): ObjectEntry[] {
  const document = parseObjectDocument(markdown);
  return document.objects.map((object) => {
    const parent = object.parentId ? document.byId.get(object.parentId) : undefined;
    return {
      object,
      key: JSON.stringify([objectOwnKey(object), parent ? objectOwnKey(parent) : null]),
    };
  });
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function changedObjects(previous: ObjectEntry[], next: ObjectEntry[]): ObjectLine[] {
  const previousKeys = previous.map(({ key }) => key);
  const nextKeys = next.map(({ key }) => key);
  const previousKeySet = new Set(previousKeys);
  const nextKeySet = new Set(nextKeys);
  const commonPrevious = previousKeys.filter((key) => nextKeySet.has(key));
  const commonNext = nextKeys.filter((key) => previousKeySet.has(key));
  const orderChanged = !sameValues(commonPrevious, commonNext);

  const previousCounts = new Map<string, number>();
  for (const key of previousKeys) previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  const matchedCounts = new Map<string, number>();
  const changed: ObjectLine[] = [];
  const changedSet = new Set<ObjectLine>();
  for (const { object, key } of next) {
    const matched = matchedCounts.get(key) ?? 0;
    if (matched < (previousCounts.get(key) ?? 0)) {
      matchedCounts.set(key, matched + 1);
    } else {
      changed.push(object);
      changedSet.add(object);
    }
  }
  if (orderChanged) {
    next.forEach(({ object, key }) => {
      if (previousKeySet.has(key) && !changedSet.has(object)) {
        changed.push(object);
        changedSet.add(object);
      }
    });
  }
  return changed;
}

function changedRoots(document: ReturnType<typeof parseObjectDocument>, changed: ObjectLine[]): ObjectLine[] {
  const rootIDs = new Set<string>();
  for (const object of changed) {
    let root = object;
    while (root.parentId) {
      const parent = document.byId.get(root.parentId);
      if (!parent) break;
      root = parent;
    }
    rootIDs.add(root.id);
  }
  return document.objects.filter((object) => rootIDs.has(object.id));
}

function canonicalNode(object: ObjectLine): CanonicalObjectDocument["objects"][number] {
  return {
    id: object.id,
    tag: object.tag,
    tags: [...object.tags],
    text: object.text,
    checked: object.checked,
    language: object.language,
    closed: object.closed,
    indent: object.indent,
    contentIndent: object.contentIndent,
    parentId: object.parentId,
    parentSectionId: object.parentSectionId,
    childrenIds: [...object.childrenIds],
    sourcePrefix: object.sourcePrefix,
    attachmentId: object.attachmentId,
    attachmentKind: object.attachmentKind,
  };
}

function copiedElement(
  document: ReturnType<typeof parseObjectDocument>,
  root: ObjectLine,
  changedIDs: ReadonlySet<string>,
): string | null {
  const included = new Set<string>();
  const collect = (object: ObjectLine, checkedAncestor = false) => {
    const changed = changedIDs.has(object.id);
    if (included.has(object.id) || (object.checked === true && !changed && !checkedAncestor)) return;
    included.add(object.id);
    object.childrenIds.forEach((id) => {
      const child = document.byId.get(id);
      if (child) collect(child, checkedAncestor || (changed && object.checked === true));
    });
  };
  collect(root);
  if (!included.has(root.id)) return null;

  const nodes = document.objects
    .filter((object) => included.has(object.id))
    .map(canonicalNode);
  const rootNode = nodes.find((node) => node.id === root.id);
  if (rootNode) {
    rootNode.parentId = null;
    rootNode.parentSectionId = null;
  }
  return markdownFromCanonicalObjectDocument({
    format: "cipherleaf.object-document",
    version: 1,
    objects: nodes,
  });
}

function localDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function stripCardJournalEntries(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(journalBlock, "");
}

function removeCardJournalMarkers(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(journalMarkers, "");
}

function journalBlockFor(
  metadata: CardMetadata,
  elements: readonly string[],
  date: Date,
): string {
  const checked = metadata.status === "finished" ? "x" : " ";
  const tags = normalizeCardTags(metadata.tags.flatMap((tag) => tag.split(",")));
  const tagSections = tags.length ? tags : [""];
  return [
    `> ${localDate(date)}`,
    ...tagSections.flatMap((tag) => [
      `  > ${tag}`,
      `    [${checked}] ${cardReference(metadata.id)}`,
      ...elements.flatMap((element) => element.split("\n").map((line) => `      ${line}`)),
    ]),
  ].join("\n");
}

function appendBody(body: string, block: string): string {
  if (!body) return block;
  let separator = "\n\n";
  if (body.endsWith("\n")) separator = "\n";
  if (body.endsWith("\n\n")) separator = "";
  return `${body}${separator}${block}`;
}

function journalForChangedContent(
  previousBody: string,
  nextBody: string,
  metadata: CardMetadata,
  date: Date,
): string | null {
  const previous = stripCardJournalEntries(previousBody);
  const next = stripCardJournalEntries(nextBody);
  const previousEntries = objectEntries(previous);
  const nextDocument = parseObjectDocument(next);
  const nextEntries = objectEntries(next);
  const changed = changedObjects(previousEntries, nextEntries);
  if (changed.length === 0) return null;

  const changedIDs = new Set(changed.map((object) => object.id));
  const elements = changedRoots(nextDocument, changed)
    .map((root) => copiedElement(nextDocument, root, changedIDs))
    .filter((element): element is string => element !== null);
  if (elements.length === 0) return null;
  return journalBlockFor(metadata, elements, date);
}

export function appendCardContentJournal(
  previousBody: string,
  nextBody: string,
  metadata: CardMetadata,
  date = new Date(),
): string | null {
  const journal = journalForChangedContent(previousBody, nextBody, metadata, date);
  return journal ? appendBody(stripCardJournalEntries(nextBody), journal) : null;
}

function insertLines(lines: string[], index: number, inserted: string): string {
  return [...lines.slice(0, index), ...inserted.split("\n"), ...lines.slice(index)].join("\n");
}

function isCurrentDateSection(object: ObjectLine, date: Date): boolean {
  if (object.parentId !== null || object.tag !== "section") return false;
  const text = object.text.trimStart();
  const currentDate = localDate(date);
  const suffix = text.slice(currentDate.length);
  return text.startsWith(currentDate) && (!suffix || suffix.startsWith(":") || /^\s/.test(suffix));
}

function isDatedRoot(object: ObjectLine): boolean {
  return object.parentId === null && object.tag === "section" && /^\s*\d{4}-\d{2}-\d{2}\b/.test(object.text);
}

function currentDateSection(
  document: ReturnType<typeof parseObjectDocument>,
  boardLine: number,
  date: Date,
): ObjectLine | undefined {
  return document.roots.find(
    (object) => (boardLine < 0 || object.lineNumber > boardLine + 1) && isCurrentDateSection(object, date),
  );
}

function sectionInsertionLine(
  lines: readonly string[],
  document: ReturnType<typeof parseObjectDocument>,
  section: ObjectLine,
): number {
  const nextSibling = document.objects.find(
    (object) => object.parentId === section.parentId && object.lineNumber > section.lineNumber,
  );
  const nextRoot = document.roots.find((object) => object.lineNumber > section.lineNumber);
  const next = nextSibling ?? nextRoot;
  let index = next ? next.lineNumber - 1 : lines.length;
  while (index > section.lineNumber && lines[index - 1]?.trim() === "") index--;
  return index;
}

function journalTagBlocks(journal: string): string[] {
  return journal.split(/\n(?= {2}> )/).slice(1);
}

function sectionTag(section: ObjectLine): string {
  return section.text.split("\n", 1)[0].trim().toLocaleLowerCase();
}

function objectPathKey(
  document: ReturnType<typeof parseObjectDocument>,
  object: ObjectLine,
  stopID: string | null = null,
): string | null {
  const path: unknown[][] = [];
  let current: ObjectLine | undefined = object;
  while (current && current.id !== stopID) {
    path.unshift([current.tag, current.tags, current.text, current.language, current.attachmentId]);
    current = current.parentId ? document.byId.get(current.parentId) : undefined;
  }
  return stopID && current?.id !== stopID ? null : JSON.stringify(path);
}

function changedCheckedObjects(
  previousBody: string,
  nextBody: string,
): [ReturnType<typeof parseObjectDocument>, ObjectLine[], boolean] {
  const previous = objectEntries(stripCardJournalEntries(previousBody));
  const next = stripCardJournalEntries(nextBody);
  const document = parseObjectDocument(next);
  const changed = changedObjects(previous, objectEntries(next));
  const checked = changed.filter((object) => object.checked === true);
  const covered = new Set<string>();
  const collect = (object: ObjectLine) => {
    covered.add(object.id);
    object.childrenIds.forEach((id) => {
      const child = document.byId.get(id);
      if (child) collect(child);
    });
  };
  checked.forEach(collect);
  return [document, checked, changed.every((object) => covered.has(object.id))];
}

function syncCheckedObjects(
  lines: string[],
  document: ReturnType<typeof parseObjectDocument>,
  dateSection: ObjectLine,
  tag: string,
  metadata: CardMetadata,
  nextDocument: ReturnType<typeof parseObjectDocument>,
  checkedObjects: readonly ObjectLine[],
): boolean {
  const tagSection = dateSection.childrenIds
    .map((id) => document.byId.get(id))
    .find((object) => object?.tag === "section" && sectionTag(object) === tag.toLocaleLowerCase());
  if (!tagSection) return false;

  const cardIDs = tagSection.childrenIds.filter(
    (id) => document.byId.get(id)?.text === cardReference(metadata.id),
  );

  const matches = checkedObjects.map((object) => {
    const key = objectPathKey(nextDocument, object);
    // ponytail: quadratic scan is fine for journal-sized documents; index paths if this becomes hot.
    return document.objects.filter((candidate) =>
      candidate.checked !== undefined && cardIDs.some((cardID) => objectPathKey(document, candidate, cardID) === key),
    );
  });
  if (matches.some((items) => !items.length)) return false;
  matches.flat().forEach((match) => {
      if (match.checked === false) lines[match.lineNumber - 1] = lines[match.lineNumber - 1].replace("[ ]", "[x]");
  });
  return true;
}

function tagSectionInsertionLine(
  lines: readonly string[],
  document: ReturnType<typeof parseObjectDocument>,
  section: ObjectLine,
): number {
  const firstUntagged = section.childrenIds
    .map((id) => document.byId.get(id))
    .find((object) => object?.tag !== "section");
  return firstUntagged ? firstUntagged.lineNumber - 1 : sectionInsertionLine(lines, document, section);
}

function appendJournalTags(
  lines: string[],
  document: ReturnType<typeof parseObjectDocument>,
  section: ObjectLine,
  journal: string,
  boardLine: number,
  date: Date,
): string {
  for (const block of journalTagBlocks(journal)) {
    const blockLines = block.split("\n");
    const tag = blockLines[0].replace(/^\s*>\s*/, "").trim().toLocaleLowerCase();
    const existing = section.childrenIds
      .map((id) => document.byId.get(id))
      .find((object) => object?.tag === "section" && sectionTag(object) === tag);
    const inserted = (existing ? blockLines.slice(1) : blockLines).join("\n");
    const insertionLine = existing
      ? sectionInsertionLine(lines, document, existing)
      : tagSectionInsertionLine(lines, document, section);
    lines = insertLines(lines, insertionLine, inserted).split("\n");
    document = parseObjectDocument(lines.join("\n"));
    const nextSection = document.roots.find(
      (object) => (boardLine < 0 || object.lineNumber > boardLine + 1) && isCurrentDateSection(object, date),
    );
    if (!nextSection) break;
    section = nextSection;
  }
  return lines.join("\n");
}

export function appendCardJournalToMainEditor(
  mainContent: string,
  previousBody: string,
  nextBody: string,
  metadata: CardMetadata,
  date = new Date(),
): string | null {
  const journal = journalForChangedContent(previousBody, nextBody, metadata, date);
  if (!journal) return null;
  const checked = changedCheckedObjects(previousBody, nextBody);

  const normalized = removeCardJournalMarkers(mainContent);
  let lines = normalized.split("\n");
  const boardLine = lines.findIndex((line) => {
    const board = parseBoardMarker(line);
    return board && (!metadata.boardID || board.id === metadata.boardID);
  });

  let document = parseObjectDocument(normalized);
  const firstDatedRoot = document.roots.find(isDatedRoot);
  let section = currentDateSection(document, boardLine, date);
  if (!section) {
    const insertionLine = boardLine >= 0 ? boardLine + 1 : (firstDatedRoot?.lineNumber ?? lines.length + 1) - 1;
    const source = lines.slice(insertionLine).join("\n");
    const rolled = rollFirstDatedSection(source, date);
    if (!rolled) return boardLine < 0
      ? appendBody(normalized, journal)
      : insertLines(lines, boardLine + 1, journal);
    lines = insertLines(lines, insertionLine, rolled).split("\n");
    document = parseObjectDocument(lines.join("\n"));
    section = currentDateSection(document, boardLine, date);
  }
  if (!section) return appendBody(normalized, journal);

  const tags = normalizeCardTags(metadata.tags.flatMap((tag) => tag.split(",")));
  const tagSections = tags.length ? tags : [""];
  if (checked[2] && checked[1].length) {
    const pending = tagSections.filter(
      (tag) => !syncCheckedObjects(lines, document, section, tag, metadata, checked[0], checked[1]),
    );
    if (pending.length < tagSections.length) {
      if (!pending.length) {
        const result = lines.join("\n");
        return result === normalized ? null : result;
      }
      const pendingJournal = journalForChangedContent(
        previousBody,
        nextBody,
        { ...metadata, tags: pending },
        date,
      );
      if (pendingJournal) return appendJournalTags(lines, document, section, pendingJournal, boardLine, date);
    }
  }
  return appendJournalTags(lines, document, section, journal, boardLine, date);
}
