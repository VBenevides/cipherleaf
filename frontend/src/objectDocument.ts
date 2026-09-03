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
  return visualIndent(/^[ \t]*/.exec(text)?.[0] ?? "");
}

const leadingAsteriskEmphasis = /^\*(?!\*)(?=\S)(.+?\S)\*(?![\p{L}\p{N}*])/u;

type ExclusiveObjectPrefix = {
  indent: number;
  kind: "bare" | "bulletpoint" | "section" | "numbering";
  marker: string;
  rest: string;
};

type PrefixParts = {
  indent: string;
  marker: string;
  separator: string;
  rest: string;
};

function leadingWhitespace(text: string): string {
  let end = 0;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  return text.slice(0, end);
}

function parseOutlinePrefix(text: string): PrefixParts | null {
  const indent = leadingWhitespace(text);
  let end = indent.length;
  while (text[end] === ">") end++;
  if (end === indent.length) return null;
  const separator = text[end] === " " || text[end] === "\t" ? text[end] : "";
  return { indent, marker: text.slice(indent.length, end), separator, rest: text.slice(end + separator.length) };
}

function parseBarePrefix(text: string): PrefixParts | null {
  const indent = leadingWhitespace(text);
  if (text[indent.length] !== "<") return null;
  const separator = text[indent.length + 1] === " " || text[indent.length + 1] === "\t"
    ? text[indent.length + 1]
    : "";
  return { indent, marker: "<", separator, rest: text.slice(indent.length + 1 + separator.length) };
}

function parseNumberedPrefix(text: string, requireSeparator: boolean): PrefixParts | null {
  const indent = leadingWhitespace(text);
  let end = indent.length;
  while (end < text.length && text[end] >= "0" && text[end] <= "9") end++;
  if (end === indent.length || (text[end] !== "." && text[end] !== ")")) return null;
  end++;
  const separatorStart = end;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  if (end === separatorStart && (requireSeparator || end < text.length)) return null;
  return { indent, marker: text.slice(indent.length, separatorStart), separator: text.slice(separatorStart, end), rest: text.slice(end) };
}

function parseBulletPrefix(text: string): PrefixParts | null {
  const indent = leadingWhitespace(text);
  const marker = text[indent.length];
  if (marker !== "-" && marker !== "*") return null;
  let end = indent.length + 1;
  if (text[end] === " " || text[end] === "\t") {
    while (text[end] === " " || text[end] === "\t") end++;
  } else if (text[end] === "-" || text[end] === "*") {
    return null;
  }
  return { indent, marker, separator: text.slice(indent.length + 1, end), rest: text.slice(end) };
}

function parseCheckbox(text: string): { marker: string; rest: string } | null {
  if (!text.startsWith("[")) return null;
  const marker = text[1] === "]" ? "" : text[1];
  if (marker !== "" && marker !== " " && marker !== "x" && marker !== "X") return null;
  const endMarker = marker === "" ? 1 : 2;
  if (text[endMarker] !== "]") return null;
  let end = endMarker + 1;
  while (text[end] === " " || text[end] === "\t") end++;
  return { marker, rest: text.slice(end) };
}

function stripPrefixLength(text: string): number {
  let end = 0;
  while (text[end] === "#") end++;
  if (end > 0 && end <= 6 && (text[end] === " " || text[end] === "\t")) {
    while (text[end] === " " || text[end] === "\t") end++;
    return end;
  }
  const bare = parseBarePrefix(text);
  if (bare) return text.length - bare.rest.length;
  const numbered = parseNumberedPrefix(text, true);
  if (numbered) return text.length - numbered.rest.length;
  const checkbox = parseCheckbox(text);
  if (checkbox) return text.length - checkbox.rest.length;
  const marker = text[0];
  if (marker !== "-" && marker !== "*" && marker !== "+") return 0;
  if (text[1] === " " || text[1] === "\t") {
    let position = 1;
    while (text[position] === " " || text[position] === "\t") position++;
    return position;
  }
  return text[1] === undefined || (text[1] !== "-" && text[1] !== "*" && text[1] !== "+" && text[1] !== " " && text[1] !== "\t")
    ? 1
    : 0;
}

function stackedMarker(text: string, start: number): { end: number; marker: string } | null {
  const marker = text[start];
  if (marker === "-" || marker === "*") {
    return text[start + 1] === "[" && [" ", "x", "X"].includes(text[start + 2] ?? "") && text[start + 3] === "]"
      ? { end: start + 1, marker }
      : null;
  }
  if (marker < "0" || marker > "9") return null;
  let end = start;
  while (text[end] >= "0" && text[end] <= "9") end++;
  if (text[end] !== "." && text[end] !== ")") return null;
  end++;
  return text[end] === "[" && [" ", "x", "X"].includes(text[end + 1] ?? "") && text[end + 2] === "]"
    ? { end, marker: text.slice(start, end) }
    : null;
}

function stackedPrefix(line: string): { end: number; marker: string } | null {
  const indent = leadingWhitespace(line);
  const firstStart = indent.length;
  const first = parseOutlinePrefix(line.slice(firstStart)) ??
    parseBarePrefix(line.slice(firstStart)) ??
    parseBulletPrefix(line.slice(firstStart)) ??
    parseNumberedPrefix(line.slice(firstStart), true);
  if (first) {
    const firstEnd = firstStart + first.marker.length + first.separator.length;
    const nested = stackedMarker(line, firstEnd);
    if (nested) return nested;
  }
  return firstStart === 0 ? stackedMarker(line, 0) : null;
}

function exclusiveObjectPrefix(text: string): ExclusiveObjectPrefix | null {
  const bare = parseBarePrefix(text);
  if (bare) {
    return {
      indent: visualIndent(bare.indent),
      kind: "bare",
      marker: `<${bare.separator}`,
      rest: bare.rest,
    };
  }

  const section = parseOutlinePrefix(text);
  if (section) {
    return {
      indent: visualIndent(section.indent) + (section.marker.length - 1) * 2,
      kind: "section",
      marker: `${section.marker} `,
      rest: section.rest,
    };
  }

  const numbered = parseNumberedPrefix(text, true);
  if (numbered) {
    return {
      indent: visualIndent(numbered.indent),
      kind: "numbering",
      marker: `${numbered.marker} `,
      rest: numbered.rest,
    };
  }

  const bullet = parseBulletPrefix(text);
  if (!bullet) return null;
  return {
    indent: visualIndent(bullet.indent),
    kind: "bulletpoint",
    marker: `${bullet.marker} `,
    rest: bullet.rest,
  };
}

function numberedMarker(previousLine: string | undefined, indent: number, fallback: string) {
  if (!previousLine) return fallback;
  const previous = exclusiveObjectPrefix(previousLine);
  if (previous?.kind !== "numbering" || previous.indent !== indent) return fallback;
  const number = Number.parseInt(previous.marker, 10);
  const punctuation = /[.)]/.exec(fallback)?.[0] ?? ".";
  return `${number + 1}${punctuation} `;
}

type StrippedObjectPrefix = {
  indent: number;
  rawIndent: string;
  rest: string;
  quoteDepth: number;
};

function stripObjectPrefixes(text: string): StrippedObjectPrefix {
  const rawIndent = /^[ \t]*/.exec(text)?.[0] ?? "";
  let rest = text.slice(rawIndent.length);
  let quoteDepth = 0;

  while (rest) {
    const quote = /^>+[ \t]?/.exec(rest);
    if (quote) {
      quoteDepth += quote[0].split(">").length - 1;
      rest = rest.slice(quote[0].length);
      continue;
    }

    const prefixLength = stripPrefixLength(rest);
    if (!prefixLength) break;
    rest = rest.slice(prefixLength);
  }

  return {
    indent: visualIndent(rawIndent) + Math.max(0, quoteDepth - 1) * 2,
    rawIndent,
    rest,
    quoteDepth,
  };
}

export function replaceExclusiveObjectPrefix(
  line: string,
  marker: string,
  previousLine?: string,
): string {
  const current = exclusiveObjectPrefix(line);
  const stripped = stripObjectPrefixes(line);
  const indent = current?.indent ?? stripped.indent;
  const nextMarker = /^\d+[.)] $/.test(marker)
    ? numberedMarker(previousLine, indent, marker)
    : marker;
  const indentation = current || stripped.quoteDepth > 0
    ? " ".repeat(indent)
    : stripped.rawIndent;
  return `${indentation}${nextMarker}${stripped.rest}`;
}

export function normalizeStackedExclusiveObjectPrefix(line: string, previousLine?: string): string {
  const stacked = stackedPrefix(line);
  if (stacked) line = `${line.slice(0, stacked.end)} ${line.slice(stacked.end)}`;
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
    const code = input.codePointAt(index) ?? 0;
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second ^= code + index;
    second = Math.imul(second, 0x811c9dc5) >>> 0;
  }

  const hex = `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}` +
    `${(first ^ second).toString(16).padStart(8, "0")}${Math.imul(first, second).toString(16).slice(-8).padStart(8, "0")}`;

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

type ObjectLineContext = {
  raw: string;
  source: string;
  outline: PrefixParts | null;
  tags: ObjectTag[];
  indent: number;
  contentIndent: number;
  sectionPrefixSize: number;
  barePrefixSize: number;
};

function objectLineContext(raw: string): ObjectLineContext {
  const outline = parseOutlinePrefix(raw);
  const bare = !outline ? parseBarePrefix(raw) : null;
  const source = outline?.rest ?? bare?.rest ?? raw.trimStart();
  const indent = outline
    ? visualIndent(outline.indent) + (outline.marker.length - 1) * 2
    : lineIndent(raw);
  return {
    raw,
    source,
    outline,
    tags: outline ? ["section"] : [],
    indent,
    contentIndent: outline
      ? visualIndent(outline.indent) + outline.marker.length + visualIndent(outline.separator)
      : indent,
    sectionPrefixSize: outline
      ? outline.indent.length + outline.marker.length + outline.separator.length
      : 0,
    barePrefixSize: bare ? bare.indent.length + 1 + bare.separator.length : 0,
  };
}

function objectSourcePrefix(context: ObjectLineContext, text: string): string {
  if (!text) return context.raw;
  const index = context.raw.indexOf(text);
  return index >= 0 ? context.raw.slice(0, index) : context.raw.slice(0, Math.min(context.raw.length, context.contentIndent));
}

function objectLineFields(context: ObjectLineContext, text: string) {
  return {
    tags: context.tags,
    indent: context.indent,
    contentIndent: context.contentIndent,
    text,
    sourcePrefix: objectSourcePrefix(context, text),
    sectionPrefixSize: context.sectionPrefixSize,
    barePrefixSize: context.barePrefixSize,
  };
}

function classifyImageOrAttachment(context: ObjectLineContext): ParsedObjectLine | null {
  const attachment = parseAttachmentReferenceMarkdown(context.source);
  if (parseAttachmentMarkdown(context.source) || attachment?.kind === "image" || /^!\[[^\]]*]\([^)]+\)\s*$/.test(context.source.trim())) {
    context.tags.push("image");
    if (attachment) context.tags.push("attachment");
    return {
      tag: "image",
      ...objectLineFields(context, context.source.trim()),
      attachmentId: attachment?.id,
      attachmentKind: attachment?.kind,
    };
  }
  if (!attachment) return null;
  context.tags.push("attachment", "text");
  return {
    tag: "text",
    ...objectLineFields(context, context.source.trim()),
    attachmentId: attachment.id,
    attachmentKind: attachment.kind,
  };
}

function classifyList(context: ObjectLineContext): ParsedObjectLine | null {
  const bullet = !leadingAsteriskEmphasis.test(context.source) ? parseBulletPrefix(context.source) : null;
  const list = bullet ?? parseNumberedPrefix(context.source, false);
  if (!list) return null;
  const checked = parseCheckbox(list.rest);
  const text = checked ? checked.rest.trim() : list.rest.trim();
  const prefix = objectSourcePrefix(context, text);
  context.tags.push("bulletpoint");
  return {
    tag: "bulletpoint",
    ...objectLineFields(context, text),
    contentIndent: visualIndent(prefix),
    checked: checked ? checked.marker.toLowerCase() === "x" : undefined,
    sourcePrefix: prefix,
    listMarker: list.marker,
  };
}

function classifyHeading(context: ObjectLineContext): ParsedObjectLine | null {
  if (!/^#{1,6}\s+/.test(context.source)) return null;
  context.tags.push("text");
  return {
    tag: context.outline ? "section" : "text",
    ...objectLineFields(context, context.source.trim()),
  };
}

function classifyText(context: ObjectLineContext): ParsedObjectLine {
  context.tags.push("text");
  const checkbox = parseCheckbox(context.source);
  const text = checkbox ? checkbox.rest.trim() : context.source.trim();
  const checkboxContentIndent = checkbox
    ? context.raw.indexOf(context.source) + context.source.length - checkbox.rest.length
    : null;
  if (!context.outline && !checkbox) context.contentIndent = context.indent + 2;
  return {
    tag: context.outline ? "section" : "text",
    ...objectLineFields(context, text),
    contentIndent: checkboxContentIndent ?? context.contentIndent,
    checked: checkbox ? checkbox.marker.toLowerCase() === "x" : undefined,
  };
}

export function classifyObjectLine(raw: string): ParsedObjectLine {
  const fence = /^([ \t]*)```([^\s`]*)[ \t]*$/.exec(raw);
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

  const context = objectLineContext(raw);
  return classifyImageOrAttachment(context) ?? classifyList(context) ?? classifyHeading(context) ?? classifyText(context);
}

function lineStartsExplicitObject(raw: string): boolean {
  const outline = parseOutlinePrefix(raw);
  const bare = !outline ? parseBarePrefix(raw) : null;
  const source = outline?.rest ?? bare?.rest ?? raw.trimStart();
  const checkbox = parseCheckbox(source);
  const bullet = !leadingAsteriskEmphasis.test(source) && parseBulletPrefix(source);
  const ordered = parseNumberedPrefix(source, false);

  return Boolean(
      outline ||
      bare ||
      parseAttachmentMarkdown(source) ||
      parseAttachmentReferenceMarkdown(source) ||
      /^!\[[^\]]*]\([^)]+\)\s*$/.test(source.trim()) ||
      checkbox ||
      bullet ||
      ordered ||
      /^#{1,6}\s+/.test(source) ||
      /^```[^\s`]*[ \t]*$/.test(source),
  );
}

export function objectContentIndent(raw: string): number {
  return classifyObjectLine(raw).contentIndent;
}

export function repeatedObjectPrefix(raw: string): string | null {
  const quote = /^([ \t]*)(>+)([ \t]?)/.exec(raw);
  if (quote) return `${quote[1]}${quote[2]} `;

  const bare = /^([ \t]*)<([ \t]?)/.exec(raw);
  if (bare) return `${bare[1]}< `;

  const task = /^([ \t]*)([-+*][ \t]+)?\[([ xX])\][ \t]+/.exec(raw);
  if (task) return `${task[1]}${task[2] ?? ""}[ ] `;

  const unordered = /^([ \t]*)([-+*])(?:[ \t]+|(?=[^-*\s])|$)/.exec(raw);
  if (unordered) return `${unordered[1]}${unordered[2]} `;

  const ordered = /^([ \t]*)(\d+)([.)])[ \t]+/.exec(raw);
  if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]} `;

  return /^[ \t]+/.exec(raw)?.[0] ?? null;
}

export function continuationPrefix(raw: string): string | null {
  const classified = classifyObjectLine(raw);
  return " ".repeat(Math.max(0, classified.contentIndent));
}

function continuationText(raw: string, parent: ParsedObjectLine): string {
  const leading = /^[ \t]*/.exec(raw)?.[0] ?? "";
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
      continue;
    }
    endLineNumber = lineNumber;
  }

  return endLineNumber;
}

function reindentLine(text: string, delta: number): string {
  if (text.trim() === "" || delta === 0) return text;
  if (delta > 0) return `${" ".repeat(delta)}${text}`;
  const removable = Math.min(/^( *)/.exec(text)?.[0].length ?? 0, Math.abs(delta));
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
  let targetEndLineNumber = targetLineNumber;
  if (mode === "after") targetEndLineNumber = objectBlockEnd(lines, targetLineNumber);
  else if (mode === "child") targetEndLineNumber = objectTextBlockEnd(lines, targetLineNumber);

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

export function deleteObjectInMarkdown(markdown: string, lineNumber: number): string {
  const lines = markdown.split("\n");
  if (lineNumber < 1 || lineNumber > lines.length) return markdown;
  const endLineNumber = objectBlockEnd(lines, lineNumber);
  lines.splice(lineNumber - 1, endLineNumber - lineNumber + 1);
  return lines.join("\n");
}

type ObjectParserState = {
  lines: string[];
  lineStarts: number[];
  roots: ObjectLine[];
  objects: ObjectLine[];
  stack: ObjectLine[];
  sectionStack: ObjectLine[];
  parsedById: Map<string, ParsedObjectLine>;
  byId: Map<string, ObjectLine>;
  byLine: Map<number, ObjectLine>;
  activeCode: ObjectLine | null;
  activeCodeLines: string[];
};

function createObjectParser(markdown: string): ObjectParserState {
  const lines = markdown.split("\n");
  let offset = 0;
  const lineStarts = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
  return {
    lines,
    lineStarts,
    roots: [],
    objects: [],
    stack: [],
    sectionStack: [],
    parsedById: new Map(),
    byId: new Map(),
    byLine: new Map(),
    activeCode: null,
    activeCodeLines: [],
  };
}

function appendActiveCodeLine(parser: ObjectParserState, index: number, raw: string): boolean {
  const activeCode = parser.activeCode;
  if (!activeCode) return false;
  const lineNumber = index + 1;
  activeCode.lineEnd = lineNumber;
  activeCode.to = parser.lineStarts[index] + raw.length;
  parser.byLine.set(lineNumber, activeCode);
  if (/^[ \t]*```[ \t]*$/.test(raw)) {
    activeCode.text = parser.activeCodeLines.join("\n");
    activeCode.closed = true;
    parser.activeCode = null;
    parser.activeCodeLines = [];
  } else {
    parser.activeCodeLines.push(raw);
    activeCode.textLineEnd = lineNumber;
    activeCode.textTo = parser.lineStarts[index] + raw.length;
  }
  return true;
}

function appendBlankContinuation(parser: ObjectParserState, index: number, raw: string): boolean {
  if (raw === "" || raw.trim() !== "") return false;
  const previous = parser.stack[parser.stack.length - 1];
  const previousParsed = previous ? parser.parsedById.get(previous.id) : null;
  const next = parser.lines[index + 1] ?? "";
  if (
    previous &&
    previousParsed &&
    next.trim() !== "" &&
    /^[ \t]/.test(next) &&
    !lineStartsExplicitObject(next) &&
    lineIndent(next) >= previousParsed.contentIndent
  ) {
    previous.text = `${previous.text}\n`;
    previous.lineEnd = index + 1;
    previous.textLineEnd = index + 1;
    previous.to = parser.lineStarts[index] + raw.length;
    previous.textTo = previous.to;
    parser.byLine.set(index + 1, previous);
  }
  return true;
}

function appendContinuation(parser: ObjectParserState, index: number, raw: string, classified: ParsedObjectLine): boolean {
  const previous = parser.stack[parser.stack.length - 1];
  const previousParsed = previous ? parser.parsedById.get(previous.id) : null;
  if (
    !previous ||
    !previousParsed ||
    previous.text === "" ||
    !/^[ \t]/.test(raw) ||
    lineStartsExplicitObject(raw) ||
    classified.indent < previousParsed.contentIndent
  ) return false;
  previous.text = `${previous.text}\n${continuationText(raw, previousParsed)}`;
  previous.lineEnd = index + 1;
  previous.textLineEnd = index + 1;
  previous.to = parser.lineStarts[index] + raw.length;
  previous.textTo = previous.to;
  parser.byLine.set(index + 1, previous);
  return true;
}

function addParsedObject(parser: ObjectParserState, index: number, classified: ParsedObjectLine): void {
  while (parser.stack.length && parser.stack[parser.stack.length - 1].indent >= classified.indent) parser.stack.pop();
  while (parser.sectionStack.length && parser.sectionStack[parser.sectionStack.length - 1].indent >= classified.indent) parser.sectionStack.pop();

  const parent = parser.stack[parser.stack.length - 1] ?? null;
  const parentSection = parser.sectionStack[parser.sectionStack.length - 1] ?? null;
  const parentPath = parent ? `${parent.id}/` : "";
  const lineNumber = index + 1;
  const id = stableUuid(`${parentPath}${classified.tag}:${classified.indent}:${classified.text}:${lineNumber}`);
  const from = parser.lineStarts[index];
  const to = from + parser.lines[index].length;
  const item: ObjectLine = {
    id,
    uuid: id,
    lineNumber,
    lineStart: lineNumber,
    lineEnd: lineNumber,
    textLineEnd: lineNumber,
    from,
    to,
    textFrom: from + Math.min(parser.lines[index].length, classified.contentIndent),
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
    parser.roots.push(item);
  }
  parser.objects.push(item);
  parser.byId.set(item.id, item);
  parser.byLine.set(lineNumber, item);
  parser.stack.push(item);
  parser.parsedById.set(item.id, classified);
  if (item.tag === "section") parser.sectionStack.push(item);
  if (item.tag === "code") {
    parser.activeCode = item;
    parser.activeCodeLines = [];
  }
}

export function insertLogicalObjectAfterCaret(markdown: string, pasted: string, offset: number): string {
  let source = pasted.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (source.endsWith("\n")) source = source.slice(0, -1);
  if (!source) return markdown;
  const lines = markdown.split("\n");
  const position = Math.max(0, Math.min(offset, markdown.length));
  let lineNumber = 1;
  let cursor = 0;
  for (const [index, line] of lines.entries()) {
    if (position <= cursor + line.length) { lineNumber = index + 1; break; }
    cursor += line.length + 1;
    lineNumber = index + 1;
  }
  const target = objectOwnerLineNumber(lines, lineNumber);
  const end = objectBlockEnd(lines, target);
  const before = lines.slice(0, end).join("\n");
  const after = lines.slice(end).join("\n");
  const targetIndent = classifyObjectLine(lines[target - 1] ?? "").indent;
  const sourceIndent = classifyObjectLine(source.split("\n", 1)[0] ?? "").indent;
  const inserted = reindentLines(source.split("\n"), sourceIndent, targetIndent).join("\n");
  return after ? `${before}\n${inserted}\n${after}` : `${before}\n${inserted}`;
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
  const parser = createObjectParser(markdown);
  for (const [index, raw] of parser.lines.entries()) {
    if (appendActiveCodeLine(parser, index, raw)) continue;
    if (appendBlankContinuation(parser, index, raw)) continue;
    const classified = classifyObjectLine(raw);
    if (appendContinuation(parser, index, raw, classified)) continue;
    addParsedObject(parser, index, classified);
  }
  if (parser.activeCode) parser.activeCode.text = parser.activeCodeLines.join("\n");
  return { objects: parser.objects, roots: parser.roots, byId: parser.byId, byLine: parser.byLine };
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
      return [`${indent}\`\`\`${object.language ?? "text"}`, object.text, object.closed === false ? "" : `${indent}\`\`\``]
        .filter((line, index) => line !== "" || index === 1)
        .join("\n");
    }
    if (object.tag === "section") {
      const lines = object.text.split("\n");
      const checked = object.checked === undefined ? "" : `${checkboxMarker(object.checked)} `;
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
      const ordered = /^\d+[.)]/.exec(object.sourcePrefix.trimStart())?.[0];
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

function checkboxMarker(checked: boolean): string {
  return `[${checked ? "x" : " "}]`;
}

function canonicalObjectPrefix(object: CanonicalObjectNode, indent: string, sourcePrefix: string): string {
  if (object.tag === "section") return `${indent}> ${sourcePrefix.replace(/^>+[ \t]*/, "")}`;
  if (sourcePrefix.startsWith("<")) return `${indent}${sourcePrefix}`;
  return `${indent}${sourcePrefix || (object.tag === "bulletpoint" ? "- " : "")}`;
}

function normalizeCanonicalPrefix(prefix: string, checked: boolean | undefined): string {
  if (checked === undefined) return prefix;
  const markerStart = prefix.lastIndexOf("[");
  const markerEnd = prefix.indexOf("]", markerStart + 1);
  if (markerStart < 0 || markerEnd < 0) return prefix;
  const marker = prefix.slice(markerStart, markerEnd + 1);
  if (marker !== "[]" && marker !== "[ ]" && marker !== "[x]" && marker !== "[X]") return prefix;

  let separatorEnd = markerEnd + 1;
  while (prefix[separatorEnd] === " " || prefix[separatorEnd] === "\t") separatorEnd++;
  const separator = prefix.slice(markerEnd + 1, separatorEnd);
  return `${prefix.slice(0, markerStart)}${checkboxMarker(checked)}${separator}${prefix.slice(separatorEnd)}`;
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

export function objectAncestorsByLine(document: ObjectDocument, lineNumber: number): ObjectLine[] {
  const ancestors: ObjectLine[] = [];
  let object = document.byLine.get(lineNumber);
  while (object?.parentId) {
    object = document.byId.get(object.parentId);
    if (object) ancestors.unshift(object);
  }
  return ancestors;
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
    const indent = " ".repeat(Math.max(0, object.indent));
    const lines = [
      `${indent}` + "```" + (object.language ?? ""),
      ...(object.text ? object.text.split("\n") : []),
    ];
    if (object.closed !== false) lines.push(`${indent}` + "```");
    return lines.join("\n");
  }

  const textLines = object.text.split("\n");
  const indent = " ".repeat(Math.max(0, object.indent));
  const sourcePrefix = object.sourcePrefix?.trimStart() ?? "";
  const prefix = canonicalObjectPrefix(object, indent, sourcePrefix);
  const prefixHasCheckbox = /\[[ xX]?\]\s*$/.test(prefix);
  const normalizedPrefix = normalizeCanonicalPrefix(prefix, object.checked);
  const firstText = object.checked !== undefined && !prefixHasCheckbox
    ? `${checkboxMarker(object.checked)} ${textLines[0] ?? ""}`.trimEnd()
    : textLines[0] ?? "";
  const first = `${normalizedPrefix}${firstText}`;
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
