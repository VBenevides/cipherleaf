export type MarkdownURL =
  | { kind: "wikilink"; title: string }
  | { kind: "anchor"; href: string }
  | { kind: "external"; href: string }
  | { kind: "blocked" };

const WIKILINK_PREFIX = "#wikilink-";

export function classifyMarkdownURL(value: string): MarkdownURL {
  if (value.startsWith(WIKILINK_PREFIX)) {
    try {
      return {
        kind: "wikilink",
        title: decodeURIComponent(value.slice(WIKILINK_PREFIX.length)),
      };
    } catch {
      return { kind: "blocked" };
    }
  }
  if (value.startsWith("#") && !value.startsWith("#//")) {
    return { kind: "anchor", href: value };
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return { kind: "external", href: parsed.toString() };
    }
  } catch {
    // Relative, malformed, and unsupported URLs stay inside the blocked path.
  }
  return { kind: "blocked" };
}
