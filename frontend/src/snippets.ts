export type Snippet = {
  trigger: string;
  description: string;
  expand: () => string;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localTime(): string {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function localDateTime(): string {
  return `${localDate()} ${localTime()}`;
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

const codeBlockTemplate = "```\n\n```";

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
  { trigger: "quote", description: "Insert a blockquote", expand: () => quoteTemplate },
  { trigger: "hr", description: "Insert a horizontal rule", expand: () => "\n---\n" },
  { trigger: "link", description: "Insert a link stub", expand: () => linkTemplate },
  { trigger: "img", description: "Insert an image stub", expand: () => imageTemplate },
  { trigger: "task", description: "Insert a single checkbox line", expand: () => taskLine },
  { trigger: "sig", description: "Insert a signature block", expand: () => signatureTemplate },
  { trigger: "lorem", description: "Insert a lorem ipsum paragraph", expand: () => loremParagraph },
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
