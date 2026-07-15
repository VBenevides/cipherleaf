import { parseAttachmentMarkdown, parseAttachmentReferenceMarkdown, type AttachmentKind } from "./markdown.ts";

export type ObjectTag = "section" | "bulletpoint" | "checkbox" | "text" | "image" | "code" | "attachment";
export type ObjectDropMode = "before" | "child" | "after";

export type ParsedObjectLine = {
  tag: ObjectTag;
  tags: ObjectTag[];
  indent: number;
  contentIndent: number;
  text: string;
  checked?: boolean;
  language?: string;
  sourcePrefix: string;
  sectionPrefixSize: number;
  barePrefixSize: number;
  listMarker?: string;
  attachmentId?: string;
  attachmentKind?: AttachmentKind;
};

export type ObjectLine = {
  id: string;
  uuid: string;
  lineNumber: number;
  lineStart: number;
  lineEnd: number;
  textLineEnd: number;
  from: number;
  to: number;
  textFrom: number;
  textTo: number;
  tag: ObjectTag;
  tags: ObjectTag[];
  indent: number;
  contentIndent: number;
  parentId: string | null;
  parentSectionId: string | null;
  childrenIds: string[];
  sourcePrefix: string;
  sectionPrefixSize: number;
  barePrefixSize: number;
  listMarker?: string;
  attachmentId?: string;
  attachmentKind?: AttachmentKind;
  text: string;
  checked?: boolean;
  language?: string;
  closed?: boolean;
  children: ObjectLine[];
};

export type ObjectDocument = {
  objects: ObjectLine[];
  roots: ObjectLine[];
  byId: Map<string, ObjectLine>;
  byLine: Map<number, ObjectLine>;
};

export type CanonicalObjectNode = {
  id: string;
  tag: ObjectTag;
  tags: ObjectTag[];
  text: string;
  checked?: boolean;
  language?: string;
  closed?: boolean;
  indent: number;
  contentIndent: number;
  parentId: string | null;
  parentSectionId: string | null;
  childrenIds: string[];
  sourcePrefix?: string;
  attachmentId?: string;
  attachmentKind?: AttachmentKind;
};

export type CanonicalObjectDocument = {
  format: "cipherleaf.object-document";
  version: 1;
  objects: CanonicalObjectNode[];
};

export type PreparedNoteContent = {
  markdown: string;
  canonical: CanonicalObjectDocument;
  canonicalText: string;
  migrated: boolean;
};

const canonicalFormat = "cipherleaf.object-document";

export function visualIndent(text: string): number {
  return text.replace(/\t/g, "  ").length;
}

export function lineIndent(text: string): number {
  return visualIndent(text.match(/^[ \t]*/)?.[0] ?? "");
}

type ExclusiveObjectPrefix = {
  indent: number;
  kind: "bare" | "bulletpoint" | "section" | "numbering";
  marker: string;
  rest: string;
};

function exclusiveObjectPrefix(text: string): ExclusiveObjectPrefix | null {
  const bare = text.match(/^([ \t]*)<([ \t]?)(.*)$/);
  if (bare) {
    return {
      indent: visualIndent(bare[1]),
      kind: "bare",
      marker: `<${bare[2]}`,
      rest: bare[3],
    };
  }

  const section = text.match(/^([ \t]*)(>+)[ \t]?(.*)$/);
  if (section) {
    return {
      indent: visualIndent(section[1]) + (section[2].length - 1) * 2,
      kind: "section",
      marker: `${section[2]} `,
      rest: section[3],
    };
  }

  const list = text.match(/^([ \t]*)(?:(\d+)([.)])|([-*]))[ \t]+(.*)$/);
  if (!list) return null;
  return {
    indent: visualIndent(list[1]),
    kind: list[2] ? "numbering" : "bulletpoint",
    marker: list[2] ? `${list[2]}${list[3]} ` : `${list[4]} `,
    rest: list[5],
  };
}

function numberedMarker(previousLine: string | undefined, indent: number, fallback: string) {
  if (!previousLine) return fallback;
  const previous = exclusiveObjectPrefix(previousLine);
  if (!previous || previous.kind !== "numbering" || previous.indent !== indent) return fallback;
  const number = Number.parseInt(previous.marker, 10);
  const punctuation = fallback.match(/[.)]/)?.[0] ?? ".";
  return `${number + 1}${punctuation} `;
}

export function replaceExclusiveObjectPrefix(
  line: string,
  marker: string,
  previousLine?: string,
): string {
  const current = exclusiveObjectPrefix(line);
  if (!current) {
    const indentation = line.match(/^[ \t]*/)?.[0] ?? "";
    return `${indentation}${marker}${line.slice(indentation.length)}`;
  }
  const nextMarker = /^\d+[.)] $/.test(marker)
    ? numberedMarker(previousLine, current.indent, marker)
    : marker;
  return `${" ".repeat(current.indent)}${nextMarker}${current.rest}`;
}

export function normalizeStackedExclusiveObjectPrefix(line: string, previousLine?: string): string {
  const current = exclusiveObjectPrefix(line);
  if (!current) return line;
  const next = exclusiveObjectPrefix(current.rest);
  if (!next || /^\s/.test(current.rest)) return line;
  const marker = next.kind === "numbering"
    ? numberedMarker(previousLine, current.indent, next.marker)
    : next.marker;
  return `${" ".repeat(current.indent)}${marker}${next.rest}`;
}

function stableUuid(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;

  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second ^= code + index;
    second = Math.imul(second, 0x811c9dc5) >>> 0;
  }

  const hex = `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}` +
    `${(first ^ second).toString(16).padStart(8, "0")}${Math.imul(first, second).toString(16).slice(-8).padStart(8, "0")}`;

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export function classifyObjectLine(raw: string): ParsedObjectLine {
  const fence = raw.match(/^([ \t]*)```([^\s`]*)[ \t]*$/);
  if (fence) {
    const indent = visualIndent(fence[1]);
    return {
      tag: "code",
      tags: ["code"],
      indent,
      contentIndent: indent,
      text: "",
      language: fence[2] || undefined,
      sourcePrefix: `${fence[1]}` + "```" + fence[2],
      sectionPrefixSize: 0,
      barePrefixSize: 0,
    };
  }

  const outline = raw.match(/^([ \t]*)(>+)([ \t]?)(.*)$/);
  const bare = !outline && raw.match(/^([ \t]*)<([ \t]?)(.*)$/);
  const source = outline ? outline[4] : bare ? bare[3] : raw.trimStart();
  const tags: ObjectTag[] = outline ? ["section"] : [];
  const indent = outline
    ? visualIndent(outline[1]) + (outline[2].length - 1) * 2
    : lineIndent(raw);
  let contentIndent = outline
    ? visualIndent(outline[1]) + outline[2].length + visualIndent(outline[3])
    : indent;
  const sourcePrefix = (text: string) => {
    if (!text) return raw;
    const index = raw.indexOf(text);
    return index >= 0 ? raw.slice(0, index) : raw.slice(0, Math.min(raw.length, contentIndent));
  };
  const sectionPrefixSize = outline
    ? outline[1].length + outline[2].length + outline[3].length
    : 0;
  const barePrefixSize = bare ? bare[1].length + 1 + bare[2].length : 0;
  const objectPrefix = { sectionPrefixSize, barePrefixSize };

  const attachment = parseAttachmentReferenceMarkdown(source);
  if (parseAttachmentMarkdown(source) || attachment?.kind === "image" || /^!\[[^\]]*]\([^)]+\)\s*$/.test(source.trim())) {
    tags.push("image");
    if (attachment) tags.push("attachment");
    const text = source.trim();
    return {
      tag: "image", tags, indent, contentIndent, text,
      sourcePrefix: sourcePrefix(text), attachmentId: attachment?.id,
      attachmentKind: attachment?.kind, ...objectPrefix,
    };
  }

  if (attachment) {
    tags.push("attachment", "text");
    const text = source.trim();
    return {
      tag: "text", tags, indent, contentIndent, text,
      sourcePrefix: sourcePrefix(text), attachmentId: attachment.id,
      attachmentKind: attachment.kind, ...objectPrefix,
    };
  }

  const bullet = source.match(/^([-*])(?:\s+(.*)|\s*)$/);
  if (bullet) {
    const checked = bullet[2]?.match(/^\[([ xX])\]\s*(.*)$/);
    const text = checked ? checked[2].trim() : bullet[2]?.trim() ?? "";
    tags.push("bulletpoint");
    return {
      tag: "bulletpoint",
      tags,
      indent,
      contentIndent: contentIndent + source.length - text.length,
      text,
      checked: checked ? checked[1].toLowerCase() === "x" : undefined,
      sourcePrefix: sourcePrefix(text),
      listMarker: bullet[1],
      ...objectPrefix,
    };
  }

  const ordered = source.match(/^(\d+[.)])(?:\s+(.*)|\s*)$/);
  if (ordered) {
    const checked = ordered[2]?.match(/^\[([ xX])\]\s*(.*)$/);
    const text = checked ? checked[2].trim() : ordered[2]?.trim() ?? "";
    tags.push("bulletpoint");
    return {
      tag: "bulletpoint",
      tags,
      indent,
      contentIndent: contentIndent + source.length - text.length,
      text,
      checked: checked ? checked[1].toLowerCase() === "x" : undefined,
      sourcePrefix: sourcePrefix(text),
      listMarker: ordered[1],
      ...objectPrefix,
    };
  }

  if (/^#{1,6}\s+/.test(source)) {
    tags.push("text");
    return {
      tag: outline ? "section" : "text",
      tags,
      indent,
      contentIndent,
      text: source.trim(),
      sourcePrefix: sourcePrefix(source.trim()),
      ...objectPrefix,
    };
  }

  tags.push("text");
  const checkbox = source.match(/^\[([ xX])\]\s*(.*)$/);
  const text = checkbox ? checkbox[2].trim() : source.trim();
  const checkboxContentIndent = checkbox ? contentIndent + source.length - checkbox[2].length : null;
  if (!outline && !checkbox) contentIndent = indent + 2;
  return {
    tag: outline ? "section" : "text",
    tags,
    indent,
    contentIndent: checkboxContentIndent ?? contentIndent,
    text,
    checked: checkbox ? checkbox[1].toLowerCase() === "x" : undefined,
    sourcePrefix: sourcePrefix(text),
    ...objectPrefix,
  };
}

function lineStartsExplicitObject(raw: string): boolean {
  const outline = raw.match(/^([ \t]*)(>+)([ \t]?)(.*)$/);
  const bare = !outline && raw.match(/^([ \t]*)<([ \t]?)(.*)$/);
  const source = outline ? outline[4] : bare ? bare[3] : raw.trimStart();

  return Boolean(
      outline ||
      bare ||
      parseAttachmentMarkdown(source) ||
      parseAttachmentReferenceMarkdown(source) ||
      /^!\[[^\]]*]\([^)]+\)\s*$/.test(source.trim()) ||
      /^\[([ xX])\]\s*(.*)$/.test(source) ||
      /^[-*](?:\s+.*|\s*)$/.test(source) ||
      /^\d+[.)](?:\s+.*|\s*)$/.test(source) ||
      /^#{1,6}\s+/.test(source) ||
      /^```[^\s`]*[ \t]*$/.test(source),
  );
}

export function objectContentIndent(raw: string): number {
  return classifyObjectLine(raw).contentIndent;
}

export function repeatedObjectPrefix(raw: string): string | null {
  const quote = raw.match(/^([ \t]*)(>+)([ \t]?)/);
  if (quote) return `${quote[1]}${quote[2]} `;

  const bare = raw.match(/^([ \t]*)<([ \t]?)/);
  if (bare) return `${bare[1]}< `;

  const task = raw.match(/^([ \t]*)([-+*][ \t]+)?\[([ xX])\][ \t]+/);
  if (task) return `${task[1]}${task[2] ?? ""}[ ] `;

  const unordered = raw.match(/^([ \t]*)([-+*])[ \t]+/);
  if (unordered) return `${unordered[1]}${unordered[2]} `;

  const ordered = raw.match(/^([ \t]*)(\d+)([.)])[ \t]+/);
  if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]} `;

  return raw.match(/^[ \t]+/)?.[0] ?? null;
}

export function continuationPrefix(raw: string): string | null {
  const classified = classifyObjectLine(raw);
  return " ".repeat(Math.max(0, classified.contentIndent));
}

function continuationText(raw: string, parent: ParsedObjectLine): string {
  const leading = raw.match(/^[ \t]*/)?.[0] ?? "";
  let offset = 0;
  let column = 0;

  while (offset < leading.length && column < parent.contentIndent) {
    column += leading[offset] === "\t" ? 2 : 1;
    offset++;
  }

  return raw.slice(offset).trimEnd();
}

export function isContinuationLine(lines: readonly string[], lineNumber: number): boolean {
  if (lineNumber <= 1) return false;
  const raw = lines[lineNumber - 1] ?? "";
  if (!/^[ \t]/.test(raw)) return false;
  if (raw.trim() !== "" && lineStartsExplicitObject(raw)) return false;

  if (raw.trim() === "") {
    const next = lines[lineNumber] ?? "";
    if (next.trim() === "" || !/^[ \t]/.test(next) || lineStartsExplicitObject(next)) return false;
  }

  for (let previousNumber = lineNumber - 1; previousNumber >= 1; previousNumber--) {
    const previous = lines[previousNumber - 1] ?? "";
    if (previous.trim() === "") continue;
    if (isContinuationLine(lines, previousNumber)) continue;
    const parsed = classifyObjectLine(previous);
    if (raw.trim() === "") {
      const next = lines[lineNumber] ?? "";
      return lineIndent(next) >= parsed.contentIndent;
    }
    return lineIndent(raw) >= parsed.contentIndent;
  }

  return false;
}

export function isSeparatorLine(lines: readonly string[], lineNumber: number): boolean {
  const raw = lines[lineNumber - 1] ?? "";
  return raw.trim() === "" && !isContinuationLine(lines, lineNumber);
}

export function objectOwnerLineNumber(lines: readonly string[], lineNumber: number): number {
  if (lineNumber <= 1 || !isContinuationLine(lines, lineNumber)) return lineNumber;

  for (let previousNumber = lineNumber - 1; previousNumber >= 1; previousNumber--) {
    if (isContinuationLine(lines, previousNumber)) continue;
    return previousNumber;
  }

  return lineNumber;
}

export function objectTextBlockEnd(lines: readonly string[], startLineNumber: number): number {
  let endLineNumber = startLineNumber;
  for (let lineNumber = startLineNumber + 1; lineNumber <= lines.length; lineNumber++) {
    if (!isContinuationLine(lines, lineNumber)) break;
    endLineNumber = lineNumber;
  }
  return endLineNumber;
}

export function objectBlockEnd(lines: readonly string[], startLineNumber: number): number {
  if (classifyObjectLine(lines[startLineNumber - 1] ?? "").tag === "code") {
    for (let lineNumber = startLineNumber + 1; lineNumber <= lines.length; lineNumber++) {
      if (/^[ \t]*```[ \t]*$/.test(lines[lineNumber - 1] ?? "")) return lineNumber;
    }
    return lines.length;
  }

  const startIndent = classifyObjectLine(lines[startLineNumber - 1] ?? "").indent;
  let endLineNumber = startLineNumber;

  for (let lineNumber = startLineNumber + 1; lineNumber <= lines.length; lineNumber++) {
    const raw = lines[lineNumber - 1] ?? "";
    if (isSeparatorLine(lines, lineNumber)) break;
    const object = classifyObjectLine(raw);
    if (raw.trim() !== "" && object.indent <= startIndent) break;
    if (object.tag === "code") {
      endLineNumber = objectBlockEnd(lines, lineNumber);
      lineNumber = endLineNumber;
      continue;
    }
    endLineNumber = lineNumber;
  }

  return endLineNumber;
}

function reindentLine(text: string, delta: number): string {
  if (text.trim() === "" || delta === 0) return text;
  if (delta > 0) return `${" ".repeat(delta)}${text}`;
  const removable = Math.min(text.match(/^ */)?.[0].length ?? 0, Math.abs(delta));
  return text.slice(removable);
}

function reindentLines(lines: readonly string[], fromIndent: number, toIndent: number): string[] {
  const delta = Math.max(0, toIndent) - fromIndent;
  let inCode = false;
  return lines.map((line) => {
    if (!inCode && classifyObjectLine(line).tag === "code") {
      inCode = true;
      return reindentLine(line, delta);
    }
    if (inCode) {
      if (/^[ \t]*```[ \t]*$/.test(line)) {
        inCode = false;
        return reindentLine(line, delta);
      }
      return line;
    }
    return reindentLine(line, delta);
  });
}

export function moveObjectInMarkdown(
  markdown: string,
  sourceLineNumber: number,
  targetLineNumber: number,
  mode: ObjectDropMode,
): string {
  if (sourceLineNumber === targetLineNumber) return markdown;

  const lines = markdown.split("\n");
  if (
    sourceLineNumber < 1 ||
    targetLineNumber < 1 ||
    sourceLineNumber > lines.length ||
    targetLineNumber > lines.length
  ) {
    return markdown;
  }

  const sourceEndLineNumber = objectBlockEnd(lines, sourceLineNumber);
  if (targetLineNumber >= sourceLineNumber && targetLineNumber <= sourceEndLineNumber) return markdown;

  const targetLine = lines[targetLineNumber - 1] ?? "";
  const targetIndent = classifyObjectLine(targetLine).indent;
  const newIndent = mode === "child" ? targetIndent + 2 : targetIndent;
  const targetEndLineNumber = mode === "after"
    ? objectBlockEnd(lines, targetLineNumber)
    : mode === "child"
      ? objectTextBlockEnd(lines, targetLineNumber)
      : targetLineNumber;

  const sourceStartIndex = sourceLineNumber - 1;
  const sourceEndIndex = sourceEndLineNumber;
  const movingLines = lines.slice(sourceStartIndex, sourceEndIndex);
  const remaining = lines.slice(0, sourceStartIndex).concat(lines.slice(sourceEndIndex));
  const rawInsertionIndex = mode === "before" ? targetLineNumber - 1 : targetEndLineNumber;
  const insertionIndex = sourceStartIndex < rawInsertionIndex
    ? rawInsertionIndex - (sourceEndIndex - sourceStartIndex)
    : rawInsertionIndex;
  const source = classifyObjectLine(lines[sourceStartIndex] ?? "");
  const reindented = reindentLines(movingLines, source.indent, newIndent);

  remaining.splice(Math.max(0, insertionIndex), 0, ...reindented);
  return remaining.join("\n");
}

export function moveObject(
  markdown: string,
  sourceId: string,
  targetId: string,
  mode: ObjectDropMode,
): string {
  if (sourceId === targetId) return markdown;
  const document = parseObjectDocument(markdown);
  const source = document.byId.get(sourceId);
  const target = document.byId.get(targetId);
  if (!source || !target) return markdown;
  return moveObjectInMarkdown(markdown, source.lineNumber, target.lineNumber, mode);
}

export function parseObjectDocument(markdown: string): ObjectDocument {
  const roots: ObjectLine[] = [];
  const objects: ObjectLine[] = [];
  const stack: ObjectLine[] = [];
  const sectionStack: ObjectLine[] = [];
  const parsedById = new Map<string, ParsedObjectLine>();
  const byId = new Map<string, ObjectLine>();
  const byLine = new Map<number, ObjectLine>();
  let activeCode: ObjectLine | null = null;
  let activeCodeLines: string[] = [];
  const lines = markdown.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;

  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    if (activeCode) {
      activeCode.lineEnd = lineNumber;
      activeCode.to = lineStarts[index] + raw.length;
      byLine.set(lineNumber, activeCode);
      if (/^[ \t]*```[ \t]*$/.test(raw)) {
        activeCode.closed = true;
        activeCode = null;
        activeCodeLines = [];
      } else {
        activeCodeLines.push(raw);
        activeCode.text = activeCodeLines.join("\n");
        activeCode.textLineEnd = lineNumber;
        activeCode.textTo = lineStarts[index] + raw.length;
      }
      return;
    }

    if (raw !== "" && raw.trim() === "") {
      const previous = stack[stack.length - 1] ?? null;
      const previousParsed = previous ? parsedById.get(previous.id) : null;
      const next = lines[index + 1] ?? "";
      let usedAsContinuation = false;

      if (
        previous &&
        previousParsed &&
        next.trim() !== "" &&
        /^[ \t]/.test(next) &&
        !lineStartsExplicitObject(next) &&
        lineIndent(next) >= previousParsed.contentIndent
      ) {
        previous.text = `${previous.text}\n`;
        previous.lineEnd = lineNumber;
        previous.textLineEnd = lineNumber;
        previous.to = lineStarts[index] + raw.length;
        previous.textTo = previous.to;
        byLine.set(lineNumber, previous);
        usedAsContinuation = true;
      }

      if (raw !== "" || usedAsContinuation) return;
    }

    const classified = classifyObjectLine(raw);
    const previous = stack[stack.length - 1] ?? null;
    const previousParsed = previous ? parsedById.get(previous.id) : null;

    if (
      previous &&
      previousParsed &&
      previous.text !== "" &&
      /^[ \t]/.test(raw) &&
      !lineStartsExplicitObject(raw) &&
      classified.indent >= previousParsed.contentIndent
    ) {
      previous.text = `${previous.text}\n${continuationText(raw, previousParsed)}`;
      previous.lineEnd = lineNumber;
      previous.textLineEnd = lineNumber;
      previous.to = lineStarts[index] + raw.length;
      previous.textTo = previous.to;
      byLine.set(lineNumber, previous);
      return;
    }

    while (stack.length && stack[stack.length - 1].indent >= classified.indent) stack.pop();
    while (sectionStack.length && sectionStack[sectionStack.length - 1].indent >= classified.indent) {
      sectionStack.pop();
    }

    const parent = stack[stack.length - 1] ?? null;
    const parentSection = sectionStack[sectionStack.length - 1] ?? null;
    const parentPath = parent ? `${parent.id}/` : "";
    const id = stableUuid(`${parentPath}${classified.tag}:${classified.indent}:${classified.text}:${lineNumber}`);
    const from = lineStarts[index];
    const to = from + raw.length;
    const item: ObjectLine = {
      id,
      uuid: id,
      lineNumber,
      lineStart: lineNumber,
      lineEnd: lineNumber,
      textLineEnd: lineNumber,
      from,
      to,
      textFrom: from + Math.min(raw.length, classified.contentIndent),
      textTo: to,
      tag: classified.tag,
      tags: classified.tags,
      indent: classified.indent,
      contentIndent: classified.contentIndent,
      parentId: parent?.uuid ?? null,
      parentSectionId: parentSection?.uuid ?? null,
      childrenIds: [],
      sourcePrefix: classified.sourcePrefix,
      sectionPrefixSize: classified.sectionPrefixSize,
      barePrefixSize: classified.barePrefixSize,
      listMarker: classified.listMarker,
      attachmentId: classified.attachmentId,
      attachmentKind: classified.attachmentKind,
      text: classified.text,
      checked: classified.checked,
      language: classified.language,
      closed: classified.tag === "code" ? false : undefined,
      children: [],
    };

    if (parent) {
      parent.children.push(item);
      parent.childrenIds.push(item.id);
    } else {
      roots.push(item);
    }

    objects.push(item);
    byId.set(item.id, item);
    byLine.set(lineNumber, item);
    stack.push(item);
    parsedById.set(item.id, classified);
    if (item.tag === "section") sectionStack.push(item);
    if (item.tag === "code") {
      activeCode = item;
      activeCodeLines = [];
    }
  });

  return { objects, roots, byId, byLine };
}

export function remapObjectKeysByLine(
  keys: ReadonlySet<string>,
  previous: ObjectDocument,
  next: ObjectDocument,
  mapLine: (lineNumber: number) => number,
): Set<string> {
  const remapped = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith("object:")) {
      remapped.add(key);
      continue;
    }
    const object = previous.byId.get(key.slice(7));
    const mapped = object && next.byLine.get(mapLine(object.lineNumber));
    if (mapped) remapped.add(`object:${mapped.id}`);
  }
  return remapped;
}

export function markdownObjectTree(markdown: string): ObjectLine[] {
  return parseObjectDocument(markdown).roots;
}

export function removeAttachmentReferences(markdown: string, attachmentId: string): string {
  const references = parseObjectDocument(markdown).objects
    .filter((object) => object.attachmentId === attachmentId)
    .map((object) => ({
      from: markdown[object.to] !== "\n" && markdown[object.from - 1] === "\n" ? object.from - 1 : object.from,
      to: markdown[object.to] === "\n" ? object.to + 1 : object.to,
    }))
    .sort((left, right) => right.from - left.from);

  return references.reduce(
    (content, range) => content.slice(0, range.from) + content.slice(range.to),
    markdown,
  );
}

export function portableMarkdown(markdown: string): string {
  const document = parseObjectDocument(markdown);
  let firstSection = true;

  return document.objects.map((object) => {
    const indent = " ".repeat(Math.max(0, object.indent));
    if (object.tag === "code") {
      return ["```" + (object.language ?? "text"), object.text, object.closed === false ? "" : "```"]
        .filter((line, index) => line !== "" || index === 1)
        .map((line) => line ? `${indent}${line}` : "")
        .join("\n");
    }
    if (object.tag === "section") {
      const lines = object.text.split("\n");
      const checked = object.checked === undefined ? "" : `[${object.checked ? "x" : " "}] `;
      if (firstSection) {
        firstSection = false;
        return [
          `# ${checked}${lines[0] ?? ""}`.trimEnd(),
          ...lines.slice(1).map((line) => line.trimEnd()),
        ].join("\n");
      }
      return [
        `${indent}> ${checked}${lines[0] ?? ""}`.trimEnd(),
        ...lines.slice(1).map((line) => `${indent}  ${line}`.trimEnd()),
      ].join("\n");
    }
    if (object.checked !== undefined) {
      const lines = object.text.split("\n");
      return [
        `${indent}- [${object.checked ? "x" : " "}] ${lines[0] ?? ""}`.trimEnd(),
        ...lines.slice(1).map((line) => `${indent}  ${line}`.trimEnd()),
      ].join("\n");
    }
    if (object.tag === "bulletpoint") {
      const ordered = object.sourcePrefix.trimStart().match(/^\d+[.)]/)?.[0];
      const marker = ordered ?? "-";
      const lines = object.text.split("\n");
      return [
        `${indent}${marker} ${lines[0] ?? ""}`.trimEnd(),
        ...lines.slice(1).map((line) => `${indent}  ${line}`.trimEnd()),
      ].join("\n");
    }
    return object.text.split("\n").map((line) => line ? `${indent}${line}` : "").join("\n");
  }).join("\n");
}

function objectDepth(object: Pick<ObjectLine, "parentId">, byId: ReadonlyMap<string, Pick<ObjectLine, "parentId">>): number {
  let depth = 0;
  let parentId = object.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentId;
  }
  return depth;
}

export function objectDepthByLine(document: ObjectDocument): Map<number, number> {
  const depths = new Map<number, number>();
  for (const object of document.objects) {
    const depth = objectDepth(object, document.byId);
    for (let lineNumber = object.lineStart; lineNumber <= object.lineEnd; lineNumber++) {
      depths.set(lineNumber, depth);
    }
  }
  return depths;
}

export function canonicalObjectDocumentFromMarkdown(markdown: string): CanonicalObjectDocument {
  const document = parseObjectDocument(markdown);
  return {
    format: canonicalFormat,
    version: 1,
    objects: document.objects.map((object) => ({
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
    })),
  };
}

export function stringifyCanonicalObjectDocument(document: CanonicalObjectDocument): string {
  return JSON.stringify(document, null, 2);
}

function isObjectTag(value: unknown): value is ObjectTag {
  return value === "section" || value === "bulletpoint" || value === "checkbox" || value === "text" || value === "image" || value === "code" || value === "attachment";
}

function validCanonicalObjectDocument(value: unknown): value is CanonicalObjectDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<CanonicalObjectDocument>;
  if (document.format !== canonicalFormat || document.version !== 1 || !Array.isArray(document.objects)) return false;
  return document.objects.every((object) =>
    object &&
    typeof object === "object" &&
    typeof object.id === "string" &&
    isObjectTag(object.tag) &&
    Array.isArray(object.tags) &&
    object.tags.every(isObjectTag) &&
    typeof object.text === "string" &&
    typeof object.indent === "number" &&
    typeof object.contentIndent === "number" &&
    (object.parentId === null || typeof object.parentId === "string") &&
    (object.parentSectionId === null || typeof object.parentSectionId === "string") &&
    Array.isArray(object.childrenIds) &&
    object.childrenIds.every((id) => typeof id === "string") &&
    (object.sourcePrefix === undefined || typeof object.sourcePrefix === "string") &&
    (object.attachmentId === undefined || typeof object.attachmentId === "string") &&
    (object.attachmentKind === undefined || object.attachmentKind === "image" || object.attachmentKind === "file") &&
    (object.checked === undefined || typeof object.checked === "boolean")
    && (object.language === undefined || typeof object.language === "string")
    && (object.closed === undefined || typeof object.closed === "boolean")
  );
}

export function parseCanonicalObjectDocumentText(content: string): CanonicalObjectDocument | null {
  try {
    const parsed = JSON.parse(content);
    return validCanonicalObjectDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function objectDocumentFromCanonicalObjectDocument(document: CanonicalObjectDocument): ObjectDocument {
  const objects: ObjectLine[] = [];
  const roots: ObjectLine[] = [];
  const byId = new Map<string, ObjectLine>();
  const byLine = new Map<number, ObjectLine>();
  let offset = 0;

  document.objects.forEach((node, index) => {
    const textLines = Math.max(1, node.text.split("\n").length);
    const lineNumber = index + 1;
    const lineText = node.text.split("\n")[0] ?? "";
    const item: ObjectLine = {
      id: node.id,
      uuid: node.id,
      lineNumber,
      lineStart: lineNumber,
      lineEnd: lineNumber + textLines - 1,
      textLineEnd: lineNumber + textLines - 1,
      from: offset,
      to: offset + lineText.length,
      textFrom: offset,
      textTo: offset + lineText.length,
      tag: node.tag,
      tags: [...node.tags],
      indent: node.indent,
      contentIndent: node.contentIndent,
      parentId: node.parentId,
      parentSectionId: node.parentSectionId,
      childrenIds: [...node.childrenIds],
      sourcePrefix: node.sourcePrefix ?? "",
      sectionPrefixSize: 0,
      barePrefixSize: 0,
      attachmentId: node.attachmentId,
      attachmentKind: node.attachmentKind,
      text: node.text,
      checked: node.checked,
      language: node.language,
      closed: node.closed,
      children: [],
    };
    objects.push(item);
    byId.set(item.id, item);
    for (let line = item.lineStart; line <= item.lineEnd; line++) byLine.set(line, item);
    offset += lineText.length + 1;
  });

  for (const object of objects) {
    const parent = object.parentId ? byId.get(object.parentId) : null;
    if (parent) parent.children.push(object);
    else roots.push(object);
  }

  return { objects, roots, byId, byLine };
}

export function parseCanonicalObjectDocument(content: string): ObjectDocument {
  const prepared = prepareNoteContent(content);
  return objectDocumentFromCanonicalObjectDocument(prepared.canonical);
}

function markdownLineForObject(object: CanonicalObjectNode): string {
  if (object.tag === "code") {
    const indent = object.sourcePrefix?.match(/^[ \t]*/)?.[0] ?? " ".repeat(Math.max(0, object.indent));
    const lines = [
      `${indent}` + "```" + (object.language ?? ""),
      ...(object.text ? object.text.split("\n") : []),
    ];
    if (object.closed !== false) lines.push(`${indent}` + "```");
    return lines.join("\n");
  }

  const textLines = object.text.split("\n");
  const prefix = object.sourcePrefix || (object.tags.includes("section")
    ? `${">".repeat(Math.max(1, Math.floor(object.indent / 2) + 1))} `
    : `${" ".repeat(Math.max(0, object.indent))}${object.tag === "bulletpoint" ? "- " : ""}`);
  const prefixHasCheckbox = /\[[ xX]\]\s*$/.test(prefix);
  const firstText = object.checked !== undefined && !prefixHasCheckbox
    ? `[${object.checked ? "x" : " "}] ${textLines[0] ?? ""}`.trimEnd()
    : textLines[0] ?? "";
  const first = `${prefix}${firstText}`;
  const continuationPrefix = " ".repeat(Math.max(0, object.contentIndent));
  const continuation = textLines.slice(1).map((line) => line ? `${continuationPrefix}${line}` : "");
  return [first, ...continuation].join("\n");
}

export function markdownFromCanonicalObjectDocument(document: CanonicalObjectDocument): string {
  const byId = new Map(document.objects.map((object) => [object.id, object]));
  const roots = document.objects.filter((object) => object.parentId === null);
  const lines: string[] = [];

  const appendObject = (object: CanonicalObjectNode) => {
    lines.push(markdownLineForObject(object));
    for (const childId of object.childrenIds) {
      const child = byId.get(childId);
      if (child) appendObject(child);
    }
  };

  for (const root of roots) appendObject(root);
  return lines.join("\n");
}

export function prepareNoteContent(content: string): PreparedNoteContent {
  const canonical = parseCanonicalObjectDocumentText(content);
  if (canonical) {
    return {
      markdown: markdownFromCanonicalObjectDocument(canonical),
      canonical,
      canonicalText: stringifyCanonicalObjectDocument(canonical),
      migrated: false,
    };
  }

  const migratedCanonical = canonicalObjectDocumentFromMarkdown(content);
  return {
    markdown: content,
    canonical: migratedCanonical,
    canonicalText: stringifyCanonicalObjectDocument(migratedCanonical),
    migrated: content.trim() !== "",
  };
}
