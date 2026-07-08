import { parseAttachmentMarkdown } from "./markdown.ts";

export type ObjectTag = "section" | "bulletpoint" | "checkbox" | "text" | "image";

export type ObjectLine = {
  id: string;
  uuid: string;
  lineNumber: number;
  tag: ObjectTag;
  tags: ObjectTag[];
  indent: number;
  parentId: string | null;
  parentSectionId: string | null;
  text: string;
  checked?: boolean;
  children: ObjectLine[];
};

export type ObjectDropMode = "before" | "child" | "after";

type ParsedLine = {
  tag: ObjectTag;
  tags: ObjectTag[];
  indent: number;
  contentIndent: number;
  text: string;
  checked?: boolean;
  startsObject: boolean;
};

function visualIndent(text: string): number {
  return text.replace(/\t/g, "  ").length;
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

function classifyLine(raw: string): ParsedLine {
  const outline = raw.match(/^([ \t]*)(>+)([ \t]?)(.*)$/);
  const source = outline ? outline[4] : raw.trimStart();
  const tags: ObjectTag[] = outline ? ["section"] : [];
  const indent = outline
    ? visualIndent(outline[1]) + (outline[2].length - 1) * 2
    : visualIndent(raw.match(/^[ \t]*/)?.[0] ?? "");
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
      tag: "checkbox" as const,
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

  tags.push(outline ? "text" : "text");
  return {
    tag: outline ? "section" as const : "text" as const,
    tags,
    indent,
    contentIndent,
    text: source.trim(),
    startsObject: Boolean(outline),
  };
}

function continuationText(raw: string, parent: ParsedLine): string {
  const leading = raw.match(/^[ \t]*/)?.[0] ?? "";
  let offset = 0;
  let column = 0;

  while (offset < leading.length && column < parent.contentIndent) {
    column += leading[offset] === "\t" ? 2 : 1;
    offset++;
  }

  return raw.slice(offset).trimEnd();
}

function lineStartsObject(raw: string): boolean {
  return classifyLine(raw).startsObject;
}

function movableIndent(raw: string): number {
  return classifyLine(raw).indent;
}

function isContinuationLine(lines: string[], lineNumber: number): boolean {
  if (lineNumber <= 1) return false;
  const raw = lines[lineNumber - 1];
  if (lineStartsObject(raw)) return false;

  if (raw.trim() === "") {
    const next = lines[lineNumber] ?? "";
    if (next.trim() === "" || lineStartsObject(next)) return false;
  }

  for (let previousNumber = lineNumber - 1; previousNumber >= 1; previousNumber--) {
    const previous = lines[previousNumber - 1];
    if (previous.trim() === "") continue;
    const parsed = classifyLine(previous);
    if (!parsed.startsObject) continue;
    if (raw.trim() === "") {
      const next = lines[lineNumber] ?? "";
      return visualIndent(next.match(/^[ \t]*/)?.[0] ?? "") >= parsed.contentIndent;
    }
    return visualIndent(raw.match(/^[ \t]*/)?.[0] ?? "") >= parsed.contentIndent;
  }

  return false;
}

function isSeparatorLine(lines: string[], lineNumber: number): boolean {
  const raw = lines[lineNumber - 1] ?? "";
  return raw.trim() === "" && !isContinuationLine(lines, lineNumber);
}

function objectTextBlockEnd(lines: string[], startLineNumber: number): number {
  let endLineNumber = startLineNumber;
  for (let lineNumber = startLineNumber + 1; lineNumber <= lines.length; lineNumber++) {
    if (!isContinuationLine(lines, lineNumber)) break;
    endLineNumber = lineNumber;
  }
  return endLineNumber;
}

function objectBlockEnd(lines: string[], startLineNumber: number): number {
  const startIndent = movableIndent(lines[startLineNumber - 1] ?? "");
  let endLineNumber = startLineNumber;

  for (let lineNumber = startLineNumber + 1; lineNumber <= lines.length; lineNumber++) {
    const raw = lines[lineNumber - 1] ?? "";
    if (isSeparatorLine(lines, lineNumber)) break;
    if (raw.trim() !== "" && lineStartsObject(raw) && movableIndent(raw) <= startIndent) break;
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

function reindentBlock(lines: string[], fromIndent: number, toIndent: number): string[] {
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
  const targetIndent = movableIndent(targetLine);
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
  const reindented = reindentBlock(movingLines, movableIndent(lines[sourceStartIndex] ?? ""), newIndent);

  remaining.splice(Math.max(0, insertionIndex), 0, ...reindented);
  return remaining.join("\n");
}

export function markdownObjectTree(markdown: string): ObjectLine[] {
  const roots: ObjectLine[] = [];
  const stack: ObjectLine[] = [];
  const sectionStack: ObjectLine[] = [];
  const parsedById = new Map<string, ParsedLine>();

  const lines = markdown.split("\n");

  lines.forEach((raw, index) => {
    if (raw.trim() === "") {
      const previous = stack[stack.length - 1] ?? null;
      const previousParsed = previous ? parsedById.get(previous.id) : null;
      const next = lines[index + 1] ?? "";
      const nextIndent = visualIndent(next.match(/^[ \t]*/)?.[0] ?? "");

      if (
        previous &&
        previousParsed &&
        next.trim() !== "" &&
        nextIndent >= previousParsed.contentIndent &&
        !classifyLine(next).startsObject
      ) {
        previous.text = `${previous.text}\n`;
      }

      return;
    }

    const classified = classifyLine(raw);
    const previous = stack[stack.length - 1] ?? null;
    const previousParsed = previous ? parsedById.get(previous.id) : null;

    if (
      previous &&
      previousParsed &&
      !classified.startsObject &&
      classified.indent >= previousParsed.contentIndent
    ) {
      previous.text = `${previous.text}\n${continuationText(raw, previousParsed)}`;
      return;
    }

    while (stack.length && stack[stack.length - 1].indent >= classified.indent) stack.pop();
    while (
      sectionStack.length &&
      sectionStack[sectionStack.length - 1].indent >= classified.indent
    ) {
      sectionStack.pop();
    }

    const parent = stack[stack.length - 1] ?? null;
    const parentSection = sectionStack[sectionStack.length - 1] ?? null;
    const parentPath = parent ? `${parent.id}/` : "";
    const id = stableUuid(`${parentPath}${classified.tag}:${classified.indent}:${classified.text}:${index + 1}`);
    const item: ObjectLine = {
      id,
      uuid: id,
      lineNumber: index + 1,
      tag: classified.tag,
      tags: classified.tags,
      indent: classified.indent,
      parentId: parent?.uuid ?? null,
      parentSectionId: parentSection?.uuid ?? null,
      text: classified.text,
      checked: classified.tag === "checkbox" ? classified.checked : undefined,
      children: [],
    };

    if (parent) parent.children.push(item);
    else roots.push(item);

    stack.push(item);
    parsedById.set(item.id, classified);
    if (item.tag === "section") sectionStack.push(item);
  });

  return roots;
}
