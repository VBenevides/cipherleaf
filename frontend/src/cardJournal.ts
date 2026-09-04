import { cardReference, normalizeCardTags, parseBoardMarker, type CardMetadata } from "./cards.ts";
import {
  markdownFromCanonicalObjectDocument,
  parseObjectDocument,
  type CanonicalObjectDocument,
  type ObjectLine,
} from "./objectDocument.ts";

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
  for (const id of changedIDs) {
    let object = document.byId.get(id);
    while (object) {
      included.add(object.id);
      if (object.id === root.id) break;
      object = object.parentId ? document.byId.get(object.parentId) : undefined;
    }
  }
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
  const tagSections = tags.length ? tags : ["Untagged"];
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
  const next = document.objects.find(
    (object) => object.lineNumber > section.lineNumber && object.indent <= section.indent,
  );
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

function objectPositionKey(
  document: ReturnType<typeof parseObjectDocument>,
  object: ObjectLine,
  stopID: string | null = null,
): string | null {
  if (object.id === stopID) return null;
  const parent = object.parentId ? document.byId.get(object.parentId) : undefined;
  if (stopID && !parent) return null;
  const parentPath = parent && parent.id !== stopID ? objectPathKey(document, parent, stopID) : "[]";
  if (parentPath === null) return null;
  const siblings = parent ? parent.childrenIds : document.roots.map((root) => root.id);
  return JSON.stringify([parentPath, object.tag, siblings.indexOf(object.id)]);
}

function mergeDailyCard(
  document: ReturnType<typeof parseObjectDocument>,
  card: ObjectLine,
  inserted: string,
  previousBody: string,
  nextBody: string,
): string {
  const previous = stripCardJournalEntries(previousBody);
  const next = stripCardJournalEntries(nextBody);
  const previousDocument = parseObjectDocument(previous);
  const nextDocument = parseObjectDocument(next);
  const deltaDocument = parseObjectDocument(inserted);
  const deltaCard = deltaDocument.roots.find((object) => object.text === card.text);
  if (!deltaCard) return inserted;

  // ponytail: path lookup is quadratic for journal-sized cards; add indexes if profiling shows this is hot.
  const included = new Set<string>();
  document.objects.forEach((object) => {
    const path = object.id === card.id ? null : objectPathKey(document, object, card.id);
    if (!path) return;
    const previousObject = previousDocument.objects.find(
      (candidate) => objectPathKey(previousDocument, candidate) === path,
    );
    if (!previousObject) return;
    const previousPath = objectPathKey(previousDocument, previousObject);
    const previousPosition = objectPositionKey(previousDocument, previousObject);
    const current = nextDocument.objects.find((candidate) =>
      objectPathKey(nextDocument, candidate) === previousPath
      || objectPositionKey(nextDocument, candidate) === previousPosition,
    );
    if (current) included.add(current.id);
  });
  deltaDocument.objects.forEach((object) => {
    const path = object.id === deltaCard.id ? null : objectPathKey(deltaDocument, object, deltaCard.id);
    if (!path) return;
    const current = nextDocument.objects.find((candidate) => objectPathKey(nextDocument, candidate) === path);
    if (current) included.add(current.id);
  });

  [...included].forEach((id) => {
    let object = nextDocument.byId.get(id);
    while (object) {
      included.add(object.id);
      object = object.parentId ? nextDocument.byId.get(object.parentId) : undefined;
    }
  });
  const body = markdownFromCanonicalObjectDocument({
    format: "cipherleaf.object-document",
    version: 1,
    objects: nextDocument.objects.filter((object) => included.has(object.id)).map(canonicalNode),
  });
  const cardLine = inserted.split("\n", 1)[0];
  return body ? `${cardLine}\n${body.split("\n").map((line) => `      ${line}`).join("\n")}` : cardLine;
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
  cardID: string,
  previousBody: string,
  nextBody: string,
  boardLine: number,
  date: Date,
): string {
  for (const block of journalTagBlocks(journal)) {
    const blockLines = block.split("\n");
    const tag = blockLines[0].replace(/^\s*>\s*/, "").trim().toLocaleLowerCase();
    const existing = section.childrenIds
      .map((id) => document.byId.get(id))
      .find((object) => object?.tag === "section" && sectionTag(object) === tag);
    const cards = existing
      ? existing.childrenIds
        .map((id) => document.byId.get(id))
        .filter((object): object is ObjectLine => object?.text === cardReference(cardID))
      : [];
    let inserted = (existing ? blockLines.slice(1) : blockLines).join("\n");
    let insertionLine = existing
      ? sectionInsertionLine(lines, document, existing)
      : tagSectionInsertionLine(lines, document, section);
    if (cards.length) {
      inserted = mergeDailyCard(document, cards[0], inserted, previousBody, nextBody);
      const ranges = cards.map((card) => ({
        start: card.lineNumber - 1,
        end: sectionInsertionLine(lines, document, card),
      }));
      insertionLine = Math.min(...ranges.map(({ start }) => start));
      ranges.sort((left, right) => right.start - left.start)
        .forEach(({ start, end }) => lines.splice(start, end - start));
    }
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

  const normalized = removeCardJournalMarkers(mainContent);
  const lines = normalized.split("\n");
  const boardLine = lines.findIndex((line) => {
    const board = parseBoardMarker(line);
    return board && (!metadata.boardID || board.id === metadata.boardID);
  });

  const document = parseObjectDocument(normalized);
  const firstDatedRoot = document.roots.find(isDatedRoot);
  const section = currentDateSection(document, boardLine, date);
  if (!section) {
    if (boardLine < 0 && !firstDatedRoot) return appendBody(normalized, journal);
    const insertionLine = boardLine >= 0 ? boardLine + 1 : (firstDatedRoot?.lineNumber ?? lines.length + 1) - 1;
    return insertLines(lines, insertionLine, journal);
  }

  const result = appendJournalTags(lines, document, section, journal, metadata.id, previousBody, nextBody, boardLine, date);
  return result === normalized ? null : result;
}
