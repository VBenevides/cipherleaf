import { classifyObjectLine, type ObjectLine, parseObjectDocument } from "./objectDocument.ts";

export type Snippet = {
  trigger: string;
  description: string;
  expand: () => string;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localTime(now = new Date()): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function localDateTime(): string {
  const now = new Date();
  return `${localDate(now)} ${localTime(now)}`;
}

function utcDateTime(): string {
  const now = new Date();
  const utc = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}`;
}

function epochSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function uuidV4(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

const meetingTemplate = `# Meeting — ${localDate()}

**Attendees:**

**Agenda:**

1.

**Notes:**

-

**Action items:**

- [ ] @ —
`;

const todoTemplate = `- [ ] 
- [ ] 
- [ ] 
- [ ] 
`;

const codeBlockTemplate = "```txt\n\n```";

export function completeCodeFenceElement(raw: string): string | null {
  const object = classifyObjectLine(raw);
  const content = raw.slice(object.tag === "code" ? raw.indexOf("```") : object.sourcePrefix.length);
  if (!content.startsWith("```")) return null;
  const indent = " ".repeat(object.indent);
  return `${indent}` + "```txt\n" + `${content.slice(3)}\n${indent}` + "```";
}

const tableTemplate = `| Column 1 | Column 2 | Column 3 |
| --- | --- | --- |
|  |  |  |
|  |  |  |
`;

const quoteTemplate = "> ";

const linkTemplate = "[text](https://)";

const imageTemplate = "![alt](https://)";

const taskLine = "- [ ] ";

const signatureTemplate = `-- 
Your name
`;

const loremParagraph =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

function isDatedSection(section: ObjectLine): boolean {
  return section.tag === "section" && /^\s*\d{4}-\d{2}-\d{2}\b/.test(section.text);
}

function copyRolledObject(markdown: string, object: ObjectLine, hasUncheckedAncestor = false): string[] {
  if (object.checked === true) return [];

  const unchecked = object.checked === false;
  const children = object.children.flatMap((child) =>
    copyRolledObject(markdown, child, hasUncheckedAncestor || unchecked),
  );
  if (!hasUncheckedAncestor && !unchecked && children.length === 0) return [];

  return [markdown.slice(object.from, object.to), ...children];
}

function rollDatedSection(markdown: string, now: Date, backward: boolean): string | null {
  const document = parseObjectDocument(markdown);
  const objects = backward ? [...document.objects].reverse() : document.objects;
  const section = objects.find(isDatedSection);
  if (!section) return null;

  return [
    `> ${localDate(now)}`,
    ...section.children.flatMap((child) => copyRolledObject(markdown, child)),
  ].join("\n");
}

export function rollLastDatedSection(markdown: string, now = new Date()): string | null {
  return rollDatedSection(markdown, now, true);
}

function rollFirstDatedSection(markdown: string, now = new Date()): string | null {
  return rollDatedSection(markdown, now, false);
}

export const SNIPPETS: Snippet[] = [
  { trigger: "today", description: "Insert the current date (local timezone)", expand: localDate },
  { trigger: "date", description: "Insert the current date (local timezone)", expand: localDate },
  { trigger: "now", description: "Insert the current date and time (local timezone)", expand: localDateTime },
  { trigger: "time", description: "Insert the current time (local timezone)", expand: localTime },
  { trigger: "datetime", description: "Insert the current date and time (local timezone)", expand: localDateTime },
  { trigger: "utc", description: "Insert the current UTC date and time", expand: utcDateTime },
  { trigger: "epoch", description: "Insert the current Unix epoch in seconds", expand: epochSeconds },
  { trigger: "uuid", description: "Insert a random UUID", expand: uuidV4 },
  { trigger: "todo", description: "Insert a checklist template", expand: () => todoTemplate },
  { trigger: "meeting", description: "Insert a meeting notes template", expand: () => meetingTemplate },
  { trigger: "code", description: "Insert a fenced code block", expand: () => codeBlockTemplate },
  { trigger: "table", description: "Insert a 3-column markdown table", expand: () => tableTemplate },
  { trigger: "quote", description: "Insert a collapsible section line", expand: () => quoteTemplate },
  { trigger: "hr", description: "Insert a horizontal rule", expand: () => "\n---\n" },
  { trigger: "link", description: "Insert a link stub", expand: () => linkTemplate },
  { trigger: "img", description: "Insert an image stub", expand: () => imageTemplate },
  { trigger: "task", description: "Insert a single checkbox line", expand: () => taskLine },
  { trigger: "sig", description: "Insert a signature block", expand: () => signatureTemplate },
  { trigger: "lorem", description: "Insert a lorem ipsum paragraph", expand: () => loremParagraph },
  { trigger: "rollb", description: "Roll the previous dated outline section", expand: () => "/rollb" },
  { trigger: "rollf", description: "Roll the next dated outline section", expand: () => "/rollf" },
];

const SNIPPETS_BY_TRIGGER: Record<string, Snippet> = {};
for (const snippet of SNIPPETS) {
  SNIPPETS_BY_TRIGGER[snippet.trigger] = snippet;
}

export function expandSnippet(trigger: string): string {
  const snippet = SNIPPETS_BY_TRIGGER[trigger];
  if (!snippet) {
    return `/${trigger}`;
  }
  return snippet.expand();
}

export function expandSnippetWithContext(
  trigger: string,
  markdownBeforeTrigger: string,
  markdownAfterTrigger = "",
  now = new Date(),
): string {
  if (trigger === "rollb") {
    return rollLastDatedSection(markdownBeforeTrigger, now) ?? `/${trigger}`;
  }
  if (trigger === "rollf") {
    return rollFirstDatedSection(markdownAfterTrigger, now) ?? "/rollf";
  }
  return expandSnippet(trigger);
}
