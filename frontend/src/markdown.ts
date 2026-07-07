export type AttachmentAlignment = "left" | "center" | "right";

export function isHorizontalRule(line: string): boolean {
  return line.trim() === "---";
}

export function normalizeArrowText(text: string): string {
  return text.replace(/->/g, "→");
}

export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function isTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseAttachmentMarkdown(line: string) {
  const match = line.match(
    /^\s*!\[([^\]]*)\]\(attachment:([a-f0-9]{32})(?:#width=(\d{2,4})(?:&align=(left|center|right))?)?\)\s*$/,
  );
  if (!match) return null;
  return {
    alt: match[1],
    id: match[2],
    width: Math.max(120, Math.min(2400, Number(match[3] ?? 640))),
    align: (match[4] ?? "left") as AttachmentAlignment,
  };
}

export function attachmentMarkdown(
  id: string,
  width = 640,
  alt = "Pasted image",
  align: AttachmentAlignment = "left",
): string {
  const alignment = align === "left" ? "" : `&align=${align}`;
  return `![${alt}](attachment:${id}#width=${width}${alignment})`;
}

export function outlineSectionEnd(
  start: number,
  last: number,
  isOutlineLine: (lineNumber: number) => boolean,
): number {
  let end = start;
  while (end < last && isOutlineLine(end + 1)) end++;
  return end;
}

export function embeddedClipboardImage(value: string): string | null {
  return value.match(/data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+/)?.[0]
    .replace(/\s/g, "") ?? null;
}
