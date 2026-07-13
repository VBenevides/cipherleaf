import { useState } from "react";
import type { Folder, NoteSummary } from "../bindings/cipherleaf/internal/vault/models";
import { graphModeIsEmpty, relationshipLinks } from "./graphRelationships";

type GraphNode = {
  id: string;
  label: string;
  kind: "folder" | "note";
  depth: number;
  hue: number;
  x: number;
  y: number;
};

type GraphEdge = {
  from: GraphNode;
  to: GraphNode;
};

const BRANCH_HUES = [250, 155, 305, 65, 15, 200];
const ROW_HEIGHT = 74;
const LEVEL_WIDTH = 210;
const DEFAULT_ZOOM = 1;
const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;

function ordered<T extends { name?: string; title?: string; order: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return (left.name ?? left.title ?? "").localeCompare(right.name ?? right.title ?? "", undefined, {
      sensitivity: "base",
    });
  });
}

function nodeFill(node: GraphNode): string {
  const lightness = Math.min(0.48 + (node.depth - 1) * 0.075, 0.88);
  const chroma = Math.max(0.16 - (node.depth - 1) * 0.012, 0.06);
  return `oklch(${lightness} ${chroma} ${node.hue})`;
}

function GraphFolderIcon() {
  return <path d="M-10-6a3 3 0 0 1 3-3h5l2 2h7a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H-7a3 3 0 0 1-3-3Z" />;
}

function GraphNoteIcon() {
  return <path d="M-4-7h5l4 4v10H-5V-7ZM1-7v4h4M-2 1h4M-2 4h4" />;
}

function EmptyGraph({ mode }: { mode: "links" | "folders" }) {
  return (
    <div className="graph-empty-state">
      <p>{mode === "links" ? "Create notes and connect them with [[wikilinks]] to see their relationships." : "Create a folder to see the vault hierarchy."}</p>
    </div>
  );
}

function RelationshipGraph({ notes, zoom, onSelectNote }: { notes: NoteSummary[]; zoom: number; onSelectNote: (id: string) => void }) {
  const width = 900;
  const height = 620;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.38;
  const nodes = notes.map((note, index) => ({
    id: note.id,
    label: note.title || "Untitled",
    resolved: true,
    x: centerX + Math.cos(index * Math.PI * 2 / Math.max(notes.length, 1)) * radius,
    y: centerY + Math.sin(index * Math.PI * 2 / Math.max(notes.length, 1)) * radius,
  }));
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const unresolved = new Map<string, (typeof nodes)[number]>();
  const edges: { from: (typeof nodes)[number]; to: (typeof nodes)[number] }[] = [];
  for (const link of relationshipLinks(notes)) {
      let targetNode = link.to ? nodeByID.get(link.to) : undefined;
      if (!targetNode) {
        const key = link.label.toLocaleLowerCase();
        targetNode = unresolved.get(key);
        if (!targetNode) {
          const index = unresolved.size;
          targetNode = { id: `unresolved:${key}`, label: link.label, resolved: false, x: 90 + index * 145, y: height - 40 };
          unresolved.set(key, targetNode);
        }
      }
      const from = nodeByID.get(link.from);
      if (from) edges.push({ from, to: targetNode });
  }
  const allNodes = [...nodes, ...unresolved.values()];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width * zoom} height={height * zoom} role="img" aria-label="Note relationship graph">
      <g className="graph-edges">{edges.map((edge, index) => <line key={`${edge.from.id}-${edge.to.id}-${index}`} x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y} />)}</g>
      {allNodes.map((node) => (
        <g key={node.id} className={`graph-node graph-node--note${node.resolved ? "" : " graph-node--unresolved"}`} role={node.resolved ? "button" : undefined} tabIndex={node.resolved ? 0 : undefined} onClick={() => node.resolved && onSelectNote(node.id)} onKeyDown={(event) => {
          if (node.resolved && (event.key === "Enter" || event.key === " ")) onSelectNote(node.id);
        }}>
          <circle cx={node.x} cy={node.y} r="22" fill={node.resolved ? "var(--green)" : "var(--paper)"} stroke="var(--red)" strokeDasharray={node.resolved ? undefined : "4 3"} />
          <text x={node.x + 30} y={node.y + 4} fill="currentColor">{node.label}</text>
        </g>
      ))}
    </svg>
  );
}

export function GraphView({
  folders,
  notes,
  onSelectFolder,
  onSelectNote,
}: {
  folders: Folder[];
  notes: NoteSummary[];
  onSelectFolder: (folder: Folder) => void;
  onSelectNote: (noteID: string) => void;
}) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [mode, setMode] = useState<"links" | "folders">("links");
  const foldersByParent = new Map<string, Folder[]>();
  const foldersByID = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    const parentID = folder.parentId ?? "";
    foldersByParent.set(parentID, [...(foldersByParent.get(parentID) ?? []), folder]);
  }
  const notesByFolder = new Map<string, NoteSummary[]>();
  for (const note of notes) {
    if (!foldersByID.has(note.folderId)) continue;
    notesByFolder.set(note.folderId, [...(notesByFolder.get(note.folderId) ?? []), note]);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let row = 0;
  let maxDepth = 1;
  const walkFolder = (folder: Folder, depth: number, hue: number): GraphNode => {
    const graphNode: GraphNode = {
      id: folder.id,
      label: folder.name,
      kind: "folder",
      depth,
      hue,
      x: 90 + (depth - 1) * LEVEL_WIDTH,
      y: 0,
    };
    nodes.push(graphNode);
    maxDepth = Math.max(maxDepth, depth);
    const childNodes = ordered(foldersByParent.get(folder.id) ?? []).map((child) => {
      const next = walkFolder(child, depth + 1, hue);
      edges.push({ from: graphNode, to: next });
      return next;
    });
    for (const note of ordered(notesByFolder.get(folder.id) ?? [])) {
      const graphNote: GraphNode = {
        id: note.id,
        label: note.title || "Untitled",
        kind: "note",
        depth: depth + 1,
        hue,
        x: 90 + depth * LEVEL_WIDTH,
        y: 50 + row++ * ROW_HEIGHT,
      };
      nodes.push(graphNote);
      edges.push({ from: graphNode, to: graphNote });
      maxDepth = Math.max(maxDepth, graphNote.depth);
      childNodes.push(graphNote);
    }
    graphNode.y = childNodes.length
      ? childNodes.reduce((total, child) => total + child.y, 0) / childNodes.length
      : 50 + row++ * ROW_HEIGHT;
    return graphNode;
  };

  ordered(foldersByParent.get("") ?? []).forEach((folder, index) => {
    walkFolder(folder, 1, BRANCH_HUES[index % BRANCH_HUES.length]);
  });

  const width = 180 + maxDepth * LEVEL_WIDTH;
  const height = Math.max(360, row * ROW_HEIGHT + 100);
  const activate = (node: GraphNode) => {
    if (node.kind === "folder") {
      const folder = foldersByID.get(node.id);
      if (folder) onSelectFolder(folder);
      return;
    }
    onSelectNote(node.id);
  };

  return (
    <section className="graph-view" aria-label="Graph view">
      <header className="graph-view-header">
        <div>
          <p className="eyebrow">{mode === "links" ? "Knowledge links" : "Vault structure"}</p>
          <h2>Graph view</h2>
        </div>
        <div className="graph-view-actions">
          <div className="graph-zoom-controls graph-mode-controls" aria-label="Graph mode">
            <button type="button" className={mode === "links" ? "active" : ""} onClick={() => setMode("links")}>Links</button>
            <button type="button" className={mode === "folders" ? "active" : ""} onClick={() => setMode("folders")}>Folders</button>
          </div>
          <div className="graph-zoom-controls" aria-label="Graph zoom controls">
            <button type="button" onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">−</button>
            <button type="button" onClick={() => setZoom(DEFAULT_ZOOM)} aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">+</button>
          </div>
        </div>
      </header>
      <div className="graph-canvas">
        {mode === "links" ? (!graphModeIsEmpty(mode, notes.length, nodes.length) ? <RelationshipGraph notes={notes} zoom={zoom} onSelectNote={onSelectNote} /> : <EmptyGraph mode={mode} />) : graphModeIsEmpty(mode, notes.length, nodes.length) ? <EmptyGraph mode={mode} /> : <svg viewBox={`0 0 ${width} ${height}`} width={width * zoom} height={height * zoom} role="img" aria-label="Folder and note hierarchy">
          <g className="graph-edges">
            {edges.map(({ from, to }) => (
              <path
                key={`${from.kind}-${from.id}-${to.kind}-${to.id}`}
                d={`M ${from.x + (from.kind === "folder" ? 75 : 20)} ${from.y} C ${from.x + 112} ${from.y}, ${to.x - 54} ${to.y}, ${to.x - (to.kind === "folder" ? 75 : 20)} ${to.y}`}
                stroke={nodeFill(from)}
              />
            ))}
          </g>
          {nodes.map((node) => {
            const fill = nodeFill(node);
            const textFill = node.depth >= 3 ? "#1f2937" : "#ffffff";
            return (
              <g
                key={`${node.kind}-${node.id}`}
                className={`graph-node graph-node--${node.kind}`}
                role="button"
                tabIndex={0}
                aria-label={`Open ${node.kind} ${node.label}`}
                onClick={() => activate(node)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activate(node);
                  }
                }}
              >
                {node.kind === "folder" ? (
                  <>
                    <rect x={node.x - 75} y={node.y - 22} width="150" height="44" rx="11" fill={fill} />
                    <g transform={`translate(${node.x - 55} ${node.y})`} stroke={textFill} fill="none" strokeWidth="1.7">
                      <GraphFolderIcon />
                    </g>
                    <text x={node.x - 36} y={node.y + 4} fill={textFill}>{node.label}</text>
                  </>
                ) : (
                  <>
                    <circle cx={node.x} cy={node.y} r="21" fill={fill} />
                    <g transform={`translate(${node.x} ${node.y})`} stroke={textFill} fill="none" strokeWidth="1.5">
                      <GraphNoteIcon />
                    </g>
                    <text x={node.x + 30} y={node.y + 4} fill="currentColor">{node.label}</text>
                  </>
                )}
              </g>
            );
          })}
        </svg>}
      </div>
    </section>
  );
}
