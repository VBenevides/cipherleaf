export const CARD_STATUSES = ["not-started", "in-progress", "blocked", "finished"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  "not-started": "Not started",
  "in-progress": "In Progress",
  blocked: "Blocked",
  finished: "Finished",
};

export const BOARD_COLUMN_LABELS: Record<CardStatus, string> = {
  "not-started": "Backlog",
  "in-progress": "In Progress",
  blocked: "Blocked",
  finished: "Concluded",
};

export const BOARD_COLUMNS = ["not-started", "in-progress", "blocked", "finished"] as const;

export type CardMetadata = {
  id: string;
  title: string;
  status: CardStatus;
  tags: string[];
  createdAt: string;
  startedAt?: string;
  blockedOn?: string;
  finishedAt?: string;
  boardID?: string;
  columnEnteredAt?: string;
};

export type CardDocument = {
  metadata: CardMetadata;
  body: string;
};

export type CardTemplate = {
  id: string;
  name: string;
  status: CardStatus;
  tags: string[];
  body: string;
};

export function boardCardsForColumn(
  cards: ReadonlyMap<string, CardMetadata>,
  ids: readonly string[],
  status: CardStatus,
  titleQuery = "",
  requiredTags: readonly string[] = [],
): CardMetadata[] {
  const title = titleQuery.trim().toLocaleLowerCase();
  const tags = requiredTags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
  return ids
    .map((id) => cards.get(id))
    .filter((card): card is CardMetadata => !!card && card.status === status)
    .filter((card) => !title || card.title.toLocaleLowerCase().includes(title))
    .filter((card) => tags.every((tag) => card.tags.some((value) => value.toLocaleLowerCase() === tag)))
    .sort((left, right) => {
      const leftDate = status === "not-started" ? left.createdAt : left.columnEnteredAt ?? left.createdAt;
      const rightDate = status === "not-started" ? right.createdAt : right.columnEnteredAt ?? right.createdAt;
      return rightDate.localeCompare(leftDate);
    });
}

const CARD_KEYS = {
  marker: "cipherleaf-card",
  status: "cipherleaf-card-status",
  tags: "cipherleaf-card-tags",
  createdAt: "cipherleaf-card-created-at",
  startedAt: "cipherleaf-card-started-at",
  blockedOn: "cipherleaf-card-blocked-on",
  finishedAt: "cipherleaf-card-finished-at",
  boardID: "cipherleaf-card-board-id",
  columnEnteredAt: "cipherleaf-card-column-entered-at",
} as const;

const TEMPLATE_KEYS = {
  marker: "cipherleaf-card-template",
  name: "cipherleaf-card-template-name",
  status: "cipherleaf-card-template-status",
  tags: "cipherleaf-card-template-tags",
} as const;

const frontmatterLine = /^([^:\n]+):(.*)$/;

function readFrontmatter(markdown: string): { values: Map<string, string>; body: string } | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return null;
  const values = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(frontmatterLine);
    if (match) values.set(match[1].trim(), match[2].trim());
  }
  const bodyStart = end + 4;
  return { values, body: normalized.slice(bodyStart).replace(/^\n/, "") };
}

function quote(value: unknown): string {
  return JSON.stringify(value);
}

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return normalizeCardTags(parsed);
    }
  } catch {
    // Older hand-written frontmatter may use a simple comma list.
  }
  return normalizeCardTags(value.replace(/^\[|\]$/g, "").split(","));
}

export function normalizeCardTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function validStatus(value: string | undefined): value is CardStatus {
  return CARD_STATUSES.includes(value as CardStatus);
}

export function newCardMetadata(id: string, now = new Date()): CardMetadata {
  return {
    id,
    title: "Untitled",
    status: "not-started",
    tags: [],
    createdAt: now.toISOString(),
  };
}

export function transitionCard(metadata: CardMetadata, nextStatus: CardStatus, now = new Date()): CardMetadata {
  if (!validStatus(nextStatus)) throw new Error(`Unsupported card status: ${nextStatus}`);
  if (metadata.status === nextStatus) return metadata;
  const timestamp = now.toISOString();
  const next: CardMetadata = { ...metadata, status: nextStatus, columnEnteredAt: timestamp };
  if (nextStatus !== "not-started" && !next.startedAt) next.startedAt = timestamp;
  if (nextStatus === "blocked") next.blockedOn = timestamp;
  if (nextStatus === "finished") next.finishedAt = timestamp;
  return next;
}

export function parseCardDocument(markdown: string, id: string, title: string): CardDocument | null {
  const frontmatter = readFrontmatter(markdown);
  if (!frontmatter || frontmatter.values.get(CARD_KEYS.marker) !== "true") return null;
  const status = frontmatter.values.get(CARD_KEYS.status);
  const createdAt = frontmatter.values.get(CARD_KEYS.createdAt);
  if (!validStatus(status) || !createdAt) return null;
  const metadata: CardMetadata = {
    id,
    title: title.trim() || "Untitled",
    status,
    tags: parseTags(frontmatter.values.get(CARD_KEYS.tags)),
    createdAt,
  };
  for (const [key, field] of [
    [CARD_KEYS.startedAt, "startedAt"],
    [CARD_KEYS.blockedOn, "blockedOn"],
    [CARD_KEYS.finishedAt, "finishedAt"],
    [CARD_KEYS.boardID, "boardID"],
    [CARD_KEYS.columnEnteredAt, "columnEnteredAt"],
  ] as const) {
    const value = frontmatter.values.get(key);
    if (value) metadata[field] = value;
  }
  return { metadata, body: frontmatter.body };
}

export function serializeCardDocument(metadata: CardMetadata, body: string): string {
  const lines = [
    "---",
    `${CARD_KEYS.marker}: true`,
    `${CARD_KEYS.status}: ${metadata.status}`,
    `${CARD_KEYS.tags}: ${quote(normalizeCardTags(metadata.tags))}`,
    `${CARD_KEYS.createdAt}: ${metadata.createdAt}`,
    `${CARD_KEYS.startedAt}: ${metadata.startedAt ?? ""}`,
    `${CARD_KEYS.blockedOn}: ${metadata.blockedOn ?? ""}`,
    `${CARD_KEYS.finishedAt}: ${metadata.finishedAt ?? ""}`,
    `${CARD_KEYS.boardID}: ${metadata.boardID ?? ""}`,
    `${CARD_KEYS.columnEnteredAt}: ${metadata.columnEnteredAt ?? ""}`,
    "---",
  ];
  return `${lines.join("\n")}\n${body}`;
}

export function cardReference(id: string): string {
  return `[card](${id})`;
}

export function parseCardReference(value: string): string | null {
  const match = value.trim().match(/^\[card\]\(([^\s)]+)\)$/i);
  return match?.[1] ?? null;
}

export function parseTemplateDocument(markdown: string, id: string): { template: CardTemplate; body: string } | null {
  const frontmatter = readFrontmatter(markdown);
  if (!frontmatter || frontmatter.values.get(TEMPLATE_KEYS.marker) !== "true") return null;
  const status = frontmatter.values.get(TEMPLATE_KEYS.status);
  const name = frontmatter.values.get(TEMPLATE_KEYS.name)?.replace(/^"|"$/g, "").trim();
  if (!name || !validStatus(status)) return null;
  return {
    template: { id, name, status, tags: parseTags(frontmatter.values.get(TEMPLATE_KEYS.tags)), body: frontmatter.body },
    body: frontmatter.body,
  };
}

export function serializeTemplateDocument(template: CardTemplate): string {
  return [
    "---",
    `${TEMPLATE_KEYS.marker}: true`,
    `${TEMPLATE_KEYS.name}: ${quote(template.name.trim())}`,
    `${TEMPLATE_KEYS.status}: ${template.status}`,
    `${TEMPLATE_KEYS.tags}: ${quote(normalizeCardTags(template.tags))}`,
    "---",
    template.body,
  ].join("\n");
}

export type BoardMarker = { id: string; cardIDs: string[] };

export function boardMarker(boardID: string, cardIDs: readonly string[] = []): string {
  return `<!-- cipherleaf-board:${boardID}:${cardIDs.join(",")} -->`;
}

export function parseBoardMarker(line: string): BoardMarker | null {
  const match = line.trim().match(/^<!--\s*cipherleaf-board:([^:\s]+):([^>]*)\s*-->$/);
  if (!match) return null;
  return { id: match[1], cardIDs: match[2] ? match[2].split(",").map((id) => id.trim()).filter(Boolean) : [] };
}
