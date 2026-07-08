import { parseAttachmentMarkdown } from "./markdown.ts";

export type ObjectTag = "section" | "bulletpoint" | "checkbox" | "text" | "image";
export type ObjectDropMode = "before" | "child" | "after";

export type ParsedObjectLine = {
  tag: ObjectTag;
  tags: ObjectTag[];
  indent: number;
  contentIndent: number;
  text: string;
  checked?: boolean;
  startsObject: boolean;
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
  text: string;
  checked?: boolean;
  children: ObjectLine[];
};

export type ObjectDocument = {
  objects: ObjectLine[];
  roots: ObjectLine[];
  byId: Map<string, ObjectLine>;
  byLine: Map<number, ObjectLine>;
};

export function visualIndent(text: string): number {
  return text.replace(/\t/g, "  ").length;
}

export function lineIndent(text: string): number {
  return visualIndent(text.match(/^[ \t]*/)?.[0] ?? "");
}

export function objectHierarchyIndent(text: string): number {
  const quote = text.match(/^([ \t]*)(>+)/);
  return quote ? visualIndent(quote[1]) + (quote[2].length - 1) * 2 : lineIndent(text);
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
  const outline = raw.match(/^([ \t]*)(>+)([ \t]?)(.*)$/);
  const source = outline ? outline[4] : raw.trimStart();
  const tags: ObjectTag[] = outline ? ["section"] : [];
  const indent = outline
    ? visualIndent(outline[1]) + (outline[2].length - 1) * 2
    : lineIndent(raw);
  const contentIndent = outline
    ? visualIndent(outline[1]) + outline[2].length + visualIndent(outline[3])
    : indent;

  if (parseAttachmentMarkdown(source) || /^!\[[^\]]*]\([^)]+\)\s*$/.test(source.trim())) {
    tags.push("image");
    return { tag: "image", tags, indent, contentIndent, text: source.trim(), startsObject: true };
  }

  const checkbox = source.match(/^(?:[-+*]\s+)?\[([ xX])\]\s*(.*)$/);
  if (checkbox) {
    tags.push("checkbox");
    return {
      tag: "checkbox",
      tags,
      indent,
      contentIndent: contentIndent + source.length - checkbox[2].length,
      text: checkbox[2].trim(),
      checked: checkbox[1].toLowerCase() === "x",
      startsObject: true,
    };
  }

  const bullet = source.match(/^([-*])\s+(.*)$/);
  if (bullet) {
    tags.push("bulletpoint");
    return {
      tag: "bulletpoint",
      tags,
      indent,
      contentIndent: contentIndent + bullet[0].length - bullet[2].length,
      text: bullet[2].trim(),
      startsObject: true,
    };
  }

  const ordered = source.match(/^(\d+[.)])\s+(.*)$/);
  if (ordered) {
    tags.push("bulletpoint");
    return {
      tag: "bulletpoint",
      tags,
      indent,
      contentIndent: contentIndent + ordered[0].length - ordered[2].length,
      text: ordered[2].trim(),
      startsObject: true,
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
      startsObject: true,
    };
  }

  tags.push("text");
  return {
    tag: outline ? "section" : "text",
    tags,
    indent,
    contentIndent,
    text: source.trim(),
    startsObject: Boolean(outline),
  };
}

export function lineStartsObject(raw: string): boolean {
  return classifyObjectLine(raw).startsObject;
}

export function objectContentIndent(raw: string): number {
  return classifyObjectLine(raw).contentIndent;
}

export function repeatedObjectPrefix(raw: string): string | null {
  const quote = raw.match(/^([ \t]*)(>+)([ \t]?)/);
  if (quote) return `${quote[1]}${quote[2]} `;

  const task = raw.match(/^([ \t]*)([-+*][ \t]+)?\[([ xX])\][ \t]+/);
  if (task) return `${task[1]}${task[2] ?? ""}[ ] `;

  const unordered = raw.match(/^([ \t]*)([-+*])[ \t]+/);
  if (unordered) return `${unordered[1]}${unordered[2]} `;

  const ordered = raw.match(/^([ \t]*)(\d+)([.)])[ \t]+/);
  if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]} `;

  return raw.match(/^[ \t]+/)?.[0] ?? null;
}

export function continuationPrefix(raw: string): string | null {
  const toggle = raw.match(/^([ \t]*)>([ \t]?)/);
  if (toggle) return `${toggle[1]}${" ".repeat(1 + toggle[2].length)}`;

  const task = raw.match(/^([ \t]*)(?:[-+*][ \t]+)?\[([ xX])\][ \t]+/);
  if (task) return `${task[1]}${" ".repeat(task[0].length - task[1].length)}`;

  const unordered = raw.match(/^([ \t]*)([-+*])[ \t]+/);
  if (unordered) return `${unordered[1]}${" ".repeat(unordered[0].length - unordered[1].length)}`;

  const ordered = raw.match(/^([ \t]*)(\d+[.)])[ \t]+/);
  if (ordered) return `${ordered[1]}${" ".repeat(ordered[0].length - ordered[1].length)}`;

  return raw.match(/^[ \t]+/)?.[0] ?? null;
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
  if (lineStartsObject(raw)) return false;

  if (raw.trim() === "") {
    const next = lines[lineNumber] ?? "";
    if (next.trim() === "" || lineStartsObject(next)) return false;
  }

  for (let previousNumber = lineNumber - 1; previousNumber >= 1; previousNumber--) {
    const previous = lines[previousNumber - 1] ?? "";
    if (previous.trim() === "") continue;
    const parsed = classifyObjectLine(previous);
    if (!parsed.startsObject) continue;
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
    const previous = lines[previousNumber - 1] ?? "";
    if (lineStartsObject(previous)) return previousNumber;
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
  const startIndent = classifyObjectLine(lines[startLineNumber - 1] ?? "").indent;
  let endLineNumber = startLineNumber;

  for (let lineNumber = startLineNumber + 1; lineNumber <= lines.length; lineNumber++) {
    const raw = lines[lineNumber - 1] ?? "";
    if (isSeparatorLine(lines, lineNumber)) break;
    if (raw.trim() !== "" && lineStartsObject(raw) && classifyObjectLine(raw).indent <= startIndent) break;
    endLineNumber = lineNumber;
  }

  return endLineNumber;
}

export function reindentLine(text: string, delta: number): string {
  if (text.trim() === "" || delta === 0) return text;
  if (delta > 0) return `${" ".repeat(delta)}${text}`;
  const removable = Math.min(text.match(/^ */)?.[0].length ?? 0, Math.abs(delta));
  return text.slice(removable);
}

export function reindentLines(lines: readonly string[], fromIndent: number, toIndent: number): string[] {
  const delta = Math.max(0, toIndent) - fromIndent;
  return lines.map((line) => reindentLine(line, delta));
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
  const reindented = reindentLines(
    movingLines,
    classifyObjectLine(lines[sourceStartIndex] ?? "").indent,
    newIndent,
  );

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
  const lines = markdown.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;

  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    if (raw.trim() === "") {
      const previous = stack[stack.length - 1] ?? null;
      const previousParsed = previous ? parsedById.get(previous.id) : null;
      const next = lines[index + 1] ?? "";

      if (
        previous &&
        previousParsed &&
        next.trim() !== "" &&
        lineIndent(next) >= previousParsed.contentIndent &&
        !classifyObjectLine(next).startsObject
      ) {
        previous.text = `${previous.text}\n`;
        previous.lineEnd = lineNumber;
        previous.textLineEnd = lineNumber;
        previous.to = lineStarts[index] + raw.length;
        previous.textTo = previous.to;
        byLine.set(lineNumber, previous);
      }

      return;
    }

    const classified = classifyObjectLine(raw);
    const previous = stack[stack.length - 1] ?? null;
    const previousParsed = previous ? parsedById.get(previous.id) : null;

    if (
      previous &&
      previousParsed &&
      !classified.startsObject &&
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
      text: classified.text,
      checked: classified.tag === "checkbox" ? classified.checked : undefined,
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
  });

  return { objects, roots, byId, byLine };
}

export function markdownObjectTree(markdown: string): ObjectLine[] {
  return parseObjectDocument(markdown).roots;
}
