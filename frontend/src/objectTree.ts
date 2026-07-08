import { parseAttachmentMarkdown } from "./markdown.ts";

export type ObjectTag = "section" | "bulletpoint" | "checkbox" | "text" | "image";

export type ObjectLine = {
  id: string;
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

function visualIndent(text: string): number {
  return text.replace(/\t/g, "  ").length;
}

function classifyLine(raw: string) {
  const outline = raw.match(/^([ \t]*)(>+)([ \t]?)(.*)$/);
  const source = outline ? outline[4] : raw.trimStart();
  const tags: ObjectTag[] = outline ? ["section"] : [];
  const indent = outline
    ? visualIndent(outline[1]) + (outline[2].length - 1) * 2
    : visualIndent(raw.match(/^[ \t]*/)?.[0] ?? "");

  if (parseAttachmentMarkdown(source) || /^!\[[^\]]*]\([^)]+\)\s*$/.test(source.trim())) {
    tags.push("image");
    return { tag: "image" as const, tags, indent, text: source.trim() };
  }

  const checkbox = source.match(/^(?:[-+*]\s+)?\[([ xX])\]\s*(.*)$/);
  if (checkbox) {
    tags.push("checkbox");
    return {
      tag: "checkbox" as const,
      tags,
      indent,
      text: checkbox[2].trim(),
      checked: checkbox[1].toLowerCase() === "x",
    };
  }

  const bullet = source.match(/^([-*])\s+(.*)$/);
  if (bullet) {
    tags.push("bulletpoint");
    return { tag: "bulletpoint" as const, tags, indent, text: bullet[2].trim() };
  }

  tags.push(outline ? "text" : "text");
  return {
    tag: outline ? "section" as const : "text" as const,
    tags,
    indent,
    text: source.trim(),
  };
}

export function markdownObjectTree(markdown: string): ObjectLine[] {
  const roots: ObjectLine[] = [];
  const stack: ObjectLine[] = [];
  const sectionStack: ObjectLine[] = [];

  markdown.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;

    const classified = classifyLine(raw);
    while (stack.length && stack[stack.length - 1].indent >= classified.indent) stack.pop();
    while (
      sectionStack.length &&
      sectionStack[sectionStack.length - 1].indent >= classified.indent
    ) {
      sectionStack.pop();
    }

    const parent = stack[stack.length - 1] ?? null;
    const parentSection = sectionStack[sectionStack.length - 1] ?? null;
    const item: ObjectLine = {
      id: `line-${index + 1}`,
      lineNumber: index + 1,
      tag: classified.tag,
      tags: classified.tags,
      indent: classified.indent,
      parentId: parent?.id ?? null,
      parentSectionId: parentSection?.id ?? null,
      text: classified.text,
      checked: classified.tag === "checkbox" ? classified.checked : undefined,
      children: [],
    };

    if (parent) parent.children.push(item);
    else roots.push(item);

    stack.push(item);
    if (item.tag === "section") sectionStack.push(item);
  });

  return roots;
}
