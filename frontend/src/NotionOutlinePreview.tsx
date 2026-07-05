import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Browser } from "@wailsio/runtime";
import { classifyMarkdownURL } from "./markdownSecurity";

type OutlineNode = {
  lineIndex: number;
  depth: number;
  text: string;
  children: OutlineNode[];
};

type PreviewBlock =
  | { kind: "markdown"; key: number; content: string }
  | { kind: "outline"; key: number; nodes: OutlineNode[] };

type NotionOutlinePreviewProps = {
  content: string;
  onChange: (content: string) => void;
  onOpenWikilink: (title: string) => void;
};

function parseOutlineLine(line: string) {
  const match = line.match(/^(\s*)((?:>\s*)+)(.*)$/);
  if (!match) return null;
  return {
    depth: (match[2].match(/>/g) ?? []).length,
    text: match[3],
  };
}

function parsePreviewBlocks(content: string): PreviewBlock[] {
  const lines = content.split("\n");
  const blocks: PreviewBlock[] = [];
  let blockKey = 0;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    if (!parseOutlineLine(lines[lineIndex])) {
      const markdown: string[] = [];
      while (lineIndex < lines.length && !parseOutlineLine(lines[lineIndex])) {
        markdown.push(lines[lineIndex]);
        lineIndex++;
      }
      blocks.push({
        kind: "markdown",
        key: blockKey++,
        content: markdown.join("\n"),
      });
      continue;
    }

    const roots: OutlineNode[] = [];
    const stack: OutlineNode[] = [];
    while (lineIndex < lines.length) {
      const parsed = parseOutlineLine(lines[lineIndex]);
      if (!parsed) break;
      const node: OutlineNode = {
        lineIndex,
        depth: parsed.depth,
        text: parsed.text,
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
      lineIndex++;
    }
    blocks.push({ kind: "outline", key: blockKey++, nodes: roots });
  }

  return blocks;
}

function withRenderedWikilinks(markdown: string) {
  return markdown.replace(
    /\[\[([^\]]+)\]\]/g,
    (_, title: string) => `[${title}](#wikilink-${encodeURIComponent(title)})`,
  );
}

function SafeMarkdownLink({
  href = "",
  children,
  onOpenWikilink,
}: {
  href?: string;
  children: ReactNode;
  onOpenWikilink: (title: string) => void;
}) {
  const target = classifyMarkdownURL(href);
  if (target.kind === "blocked") {
    return <span title="Blocked unsafe or unsupported link">{children}</span>;
  }
  return (
    <a
      href={target.kind === "wikilink" ? "#" : target.href}
      onClick={(event) => {
        if (target.kind === "anchor") return;
        event.preventDefault();
        if (target.kind === "wikilink") {
          onOpenWikilink(target.title);
          return;
        }
        if (window.confirm(`Open this link in your default browser?\n\n${target.href}`)) {
          void Browser.OpenURL(target.href);
        }
      }}
    >
      {children}
    </a>
  );
}

function BlockedMarkdownImage({ alt = "" }: { alt?: string }) {
  return (
    <span className="blocked-markdown-image" title="Remote images are blocked for privacy">
      [Image blocked{alt ? `: ${alt}` : ""}]
    </span>
  );
}

function InlineMarkdown({
  content,
  onOpenWikilink,
}: {
  content: string;
  onOpenWikilink: (title: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <>{children}</>,
        a: ({ href, children }) => (
          <SafeMarkdownLink href={href} onOpenWikilink={onOpenWikilink}>
            {children}
          </SafeMarkdownLink>
        ),
        img: ({ alt }) => <BlockedMarkdownImage alt={alt} />,
      }}
    >
      {withRenderedWikilinks(content)}
    </ReactMarkdown>
  );
}

function OutlineNodeView({
  node,
  onToggleTask,
  onOpenWikilink,
}: {
  node: OutlineNode;
  onToggleTask: (lineIndex: number, checked: boolean) => void;
  onOpenWikilink: (title: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const task = node.text.match(/^(?:[-+*]\s+)?\[([ xX])\]\s*(.*)$/);
  const checked = task?.[1].toLowerCase() === "x";
  const displayText = task ? task[2] : node.text;
  const hasChildren = node.children.length > 0;

  return (
    <div className={`notion-outline-node ${checked ? "is-complete" : ""}`}>
      <div className="notion-outline-row">
        {hasChildren ? (
          <button
            type="button"
            className={`notion-outline-toggle ${expanded ? "" : "is-collapsed"}`}
            aria-label={expanded ? "Collapse section" : "Expand section"}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            ▾
          </button>
        ) : (
          <span className="notion-outline-toggle-spacer" />
        )}
        {task && (
          <input
            type="checkbox"
            checked={checked}
            aria-label={checked ? "Mark task incomplete" : "Mark task complete"}
            onChange={(event) => onToggleTask(node.lineIndex, event.target.checked)}
          />
        )}
        <span className="notion-outline-text">
          <InlineMarkdown
            content={displayText || "Untitled section"}
            onOpenWikilink={onOpenWikilink}
          />
        </span>
      </div>
      {hasChildren && expanded && (
        <div className="notion-outline-children">
          {node.children.map((child) => (
            <OutlineNodeView
              key={child.lineIndex}
              node={child}
              onToggleTask={onToggleTask}
              onOpenWikilink={onOpenWikilink}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function NotionOutlinePreview({
  content,
  onChange,
  onOpenWikilink,
}: NotionOutlinePreviewProps) {
  const blocks = useMemo(() => parsePreviewBlocks(content), [content]);

  const toggleTask = (lineIndex: number, checked: boolean) => {
    const lines = content.split("\n");
    lines[lineIndex] = lines[lineIndex].replace(
      /\[([ xX])\]/,
      checked ? "[x]" : "[ ]",
    );
    onChange(lines.join("\n"));
  };

  return (
    <>
      {blocks.map((block) =>
        block.kind === "markdown" ? (
          <ReactMarkdown
            key={block.key}
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <SafeMarkdownLink href={href} onOpenWikilink={onOpenWikilink}>
                  {children}
                </SafeMarkdownLink>
              ),
              img: ({ alt }) => <BlockedMarkdownImage alt={alt} />,
            }}
          >
            {withRenderedWikilinks(block.content)}
          </ReactMarkdown>
        ) : (
          <section className="notion-outline" key={block.key}>
            {block.nodes.map((node) => (
              <OutlineNodeView
                key={node.lineIndex}
                node={node}
                onToggleTask={toggleTask}
                onOpenWikilink={onOpenWikilink}
              />
            ))}
          </section>
        ),
      )}
    </>
  );
}
