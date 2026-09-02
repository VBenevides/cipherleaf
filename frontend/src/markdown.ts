export type AttachmentAlignment = "left" | "center" | "right";
export type AttachmentKind = "image" | "file";

export function isHorizontalRule(line: string): boolean {
  return line.trim() === "---";
}

export function normalizeArrowText(text: string): string {
  let activeFence: string | null = null;
  let activeFenceLength = 0;

  return text.split(/(\r\n|\n|\r)/).map((part) => {
    if (part === "\n" || part === "\r" || part === "\r\n") return part;

    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(part);
    if (activeFence) {
      const fenceValue = fence?.[1];
      if (fenceValue?.startsWith(activeFence) && fenceValue.length >= activeFenceLength) {
        activeFence = null;
      }
      return part;
    }
    if (fence) {
      activeFence = fence[1][0];
      activeFenceLength = fence[1].length;
      return part;
    }

    let result = "";
    let cursor = 0;
    for (const link of part.matchAll(/\]\((<[^>\r\n]*>|[^)\r\n]*)\)/g)) {
      const start = link.index ?? 0;
      result += part.slice(cursor, start).replace(/(^|[^-])->/g, "$1→").replace(/<-/g, "←");
      result += link[0];
      cursor = start + link[0].length;
    }
    return result + part.slice(cursor).replace(/(^|[^-])->/g, "$1→").replace(/<-/g, "←");
  }).join("");
}

export function markdownCitations(text: string) {
  return [...text.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)/gi)]
    .filter((match) => isMarkdownLinkTarget(match[2]))
    .map((match) => ({
      label: match[1],
      url: match[2],
      index: match.index,
      length: match[0].length,
    }));
}

export function markdownCitation(label: string, url: string): string | null {
  const name = label.trim();
  const link = url.trim();
  if (!name || /[\]\n]/.test(name) || !isMarkdownLinkTarget(link)) return null;
  return `[${name}](${link})`;
}

function isMarkdownLinkTarget(link: string): boolean {
  if (!link || /[\s)]/.test(link)) return false;
  if (/^[a-z]:[\\/]/i.test(link)) return true;
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(link)?.[1].toLowerCase();
  return !protocol || protocol === "http" || protocol === "https" || protocol === "file";
}

export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function isTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseAttachmentMarkdown(line: string) {
  const match = /^\s*!\[([^\]]*)\]\(attachment:([a-f0-9]{32})(?:#width=(\d{2,4})(?:&align=(left|center|right))?)?\)\s*$/.exec(line);
  if (!match) return null;
  return {
    alt: match[1],
    id: match[2],
    width: Math.max(120, Math.min(2400, Number(match[3] ?? 640))),
    align: (match[4] ?? "left") as AttachmentAlignment,
  };
}

export function parseAttachmentReferenceMarkdown(line: string): { id: string; kind: AttachmentKind } | null {
  const match = /^\s*(!?)\[[^\]]*\]\(attachment:([a-f0-9]{32})(?:#[^)]*)?\)\s*$/.exec(line);
  return match ? { id: match[2], kind: match[1] ? "image" : "file" } : null;
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

export function insertAttachmentMarkdown(
  markdown: string,
  offset: number,
  attachment: string,
  prefix = "",
): { from: number; to: number; insert: string } {
  const position = Math.max(0, Math.min(offset, markdown.length));
  let from = position;
  let to = position;
  while (from > 0 && markdown[from - 1] === "\n") from--;
  while (to < markdown.length && markdown[to] === "\n") to++;
  return {
    from,
    to,
    insert: `${from > 0 ? "\n" : ""}${prefix}${attachment}${to < markdown.length ? "\n" : ""}`,
  };
}

export function embeddedClipboardImage(value: string): string | null {
  return /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+/.exec(value)?.[0]
    .replace(/\s/g, "") ?? null;
}
