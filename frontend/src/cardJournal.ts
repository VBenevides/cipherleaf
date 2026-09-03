import { cardReference, normalizeCardTags, type CardMetadata } from "./cards.ts";
import {
  markdownFromCanonicalObjectDocument,
  parseObjectDocument,
  type CanonicalObjectDocument,
  type ObjectLine,
} from "./objectDocument.ts";

export const CARD_JOURNAL_START = "<!-- cipherleaf-card-journal:start -->";
export const CARD_JOURNAL_END = "<!-- cipherleaf-card-journal:end -->";

const journalBlock = new RegExp(
  `(?:^|\\n)${escapeRegExp(CARD_JOURNAL_START)}\\n[\\s\\S]*?\\n${escapeRegExp(CARD_JOURNAL_END)}(?=\\n|$)`,
  "g",
);

type ObjectEntry = {
  object: ObjectLine;
  key: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// ponytail: LCS is O(n²) per save; use keyed diffing if unusually large cards make saves slow.
function longestCommonSubsequence(left: readonly string[], right: readonly string[]): [number, number][] {
  const lengths = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex--) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex--) {
      lengths[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? lengths[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(lengths[leftIndex + 1][rightIndex], lengths[leftIndex][rightIndex + 1]);
    }
  }

  const pairs: [number, number][] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      pairs.push([leftIndex, rightIndex]);
      leftIndex++;
      rightIndex++;
    } else if (lengths[leftIndex + 1][rightIndex] >= lengths[leftIndex][rightIndex + 1]) {
      leftIndex++;
    } else {
      rightIndex++;
    }
  }
  return pairs;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function changedObjects(previous: ObjectEntry[], next: ObjectEntry[]): ObjectLine[] {
  const previousKeys = previous.map(({ key }) => key);
  const nextKeys = next.map(({ key }) => key);
  const pairs = longestCommonSubsequence(previousKeys, nextKeys);
  const matchedNext = new Set(pairs.map(([, nextIndex]) => nextIndex));
  const previousKeySet = new Set(previousKeys);
  const nextKeySet = new Set(nextKeys);
  const commonPrevious = previousKeys.filter((key) => nextKeySet.has(key));
  const commonNext = nextKeys.filter((key) => previousKeySet.has(key));
  const orderChanged = !sameValues(commonPrevious, commonNext);

  const changed = next
    .filter((_, index) => !matchedNext.has(index))
    .map(({ object }) => object);
  if (orderChanged) {
    next.forEach(({ object, key }) => {
      if (previousKeySet.has(key) && !changed.includes(object)) changed.push(object);
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

function copiedElement(document: ReturnType<typeof parseObjectDocument>, root: ObjectLine): string {
  const included = new Set<string>();
  const collect = (object: ObjectLine) => {
    if (included.has(object.id)) return;
    included.add(object.id);
    object.childrenIds.forEach((id) => {
      const child = document.byId.get(id);
      if (child) collect(child);
    });
  };
  collect(root);

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

function stripJournalEntries(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(journalBlock, "");
}

function journalBlockFor(
  metadata: CardMetadata,
  elements: readonly string[],
  date: Date,
): string {
  const checked = metadata.status === "finished" ? "x" : " ";
  const tags = normalizeCardTags(metadata.tags).join(", ");
  const title = metadata.title.trim() || "Untitled";
  return [
    CARD_JOURNAL_START,
    `> ${localDate(date)}`,
    `> > ${tags}`,
    `> > > [${checked}] ${cardReference(metadata.id)} ${title}`,
    ...elements.flatMap((element) => element.split("\n").map((line) => `> > > > ${line}`)),
    CARD_JOURNAL_END,
  ].join("\n");
}

function appendBody(body: string, block: string): string {
  if (!body) return block;
  const separator = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${block}`;
}

export function appendCardContentJournal(
  previousBody: string,
  nextBody: string,
  metadata: CardMetadata,
  date = new Date(),
): string | null {
  const previous = stripJournalEntries(previousBody);
  const next = stripJournalEntries(nextBody);
  const previousEntries = objectEntries(previous);
  const nextDocument = parseObjectDocument(next);
  const nextEntries = objectEntries(next);
  const changed = changedObjects(previousEntries, nextEntries);
  if (changed.length === 0) return null;

  const elements = changedRoots(nextDocument, changed)
    .map((root) => copiedElement(nextDocument, root));
  if (elements.length === 0) return null;
  return appendBody(nextBody, journalBlockFor(metadata, elements, date));
}
