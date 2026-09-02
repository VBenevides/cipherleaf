import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  deleteObjectInMarkdown,
  moveObject,
  objectDocumentFromCanonicalObjectDocument,
  parseObjectDocument,
  prepareNoteContent,
  type ObjectDropMode,
  type ObjectLine,
} from "./objectDocument";

type EditableObjectTag = "section" | "bulletpoint" | "checkbox" | "text" | "code";

const editableObjectTypes: Array<{ value: EditableObjectTag; label: string }> = [
  { value: "text", label: "Text" },
  { value: "section", label: "Section" },
  { value: "bulletpoint", label: "Bullet" },
  { value: "checkbox", label: "Checklist" },
  { value: "code", label: "Code block" },
];

function objectTypeLabel(tag: ObjectLine["tag"]): string {
  return tag === "bulletpoint"
    ? "Bullet"
    : tag === "checkbox"
      ? "Checklist"
      : tag === "section"
        ? "Section"
        : tag === "code"
          ? "Code block"
          : tag === "image"
            ? "Image"
            : tag === "attachment"
              ? "Attachment"
              : "Text";
}

function editableTypeFor(node: ObjectLine): EditableObjectTag | null {
  if (node.attachmentId || node.tag === "image" || node.tag === "attachment") return null;
  if (node.checked !== undefined && node.tag !== "section") return "checkbox";
  return editableObjectTypes.some(({ value }) => value === node.tag)
    ? node.tag
    : null;
}

function canRenderAsCode(node: ObjectLine): boolean {
  return node.tag === "code" || !node.text.split("\n").some((line) => /^[ \t]*```[ \t]*$/.test(line));
}

function renderObjectBlock(node: ObjectLine, type: EditableObjectTag, text: string): string {
  const indent = " ".repeat(Math.max(0, node.indent));
  const continuationIndent = " ".repeat(Math.max(0, node.indent + 2));
  const lines = text.split("\n");

  if (type === "code") {
    return [
      `${indent}\`\`\`${node.language ?? "text"}`,
      ...(text ? lines : []),
      ...(node.closed === false ? [] : [`${indent}\`\`\``]),
    ].join("\n");
  }

  const sectionCheckmark = node.checked === undefined ? "" : `[${node.checked ? "x" : " "}] `;
  const marker = type === "section"
    ? `> ${sectionCheckmark}`
    : type === "checkbox"
      ? `- [${node.checked ? "x" : " "}] `
      : type === "bulletpoint"
        ? "- "
        : "";
  return [
    `${indent}${marker}${lines[0] ?? ""}`,
    ...lines.slice(1).map((line) => line ? `${continuationIndent}${line}` : ""),
  ].join("\n");
}

type Props = {
  readonly value: string;
  readonly onChange: (value: string) => void;
};

function dropModeForPoint(target: HTMLElement, clientY: number): ObjectDropMode {
  const rect = target.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (ratio < 0.28) return "before";
  if (ratio > 0.72) return "after";
  return "child";
}

function objectTreeRowAt(x: number, y: number): HTMLElement | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element instanceof HTMLElement && element.matches(".object-tree-row[data-object-id]")) return element;
    if (element instanceof HTMLElement) {
      const row = element.closest<HTMLElement>(".object-tree-row[data-object-id]");
      if (row) return row;
    }
  }
  return null;
}

function ObjectTreeNode({
  node,
  depth,
  draggedId,
  dropTarget,
  onPointerDragStart,
  onEdit,
  onChangeType,
  onAddChild,
  onDelete,
  onToggleCheck,
}: {
  readonly node: ObjectLine;
  readonly depth: number;
  readonly draggedId: string | null;
  readonly dropTarget: { id: string; mode: ObjectDropMode } | null;
  readonly onPointerDragStart: (event: PointerEvent<HTMLElement>, id: string) => void;
  readonly onEdit: (node: ObjectLine, text: string) => void;
  readonly onChangeType: (node: ObjectLine, type: EditableObjectTag) => void;
  readonly onAddChild: (node: ObjectLine) => void;
  readonly onDelete: (node: ObjectLine) => void;
  readonly onToggleCheck: (node: ObjectLine, checked: boolean) => void;
}) {
  const currentDrop = dropTarget?.id === node.id ? dropTarget.mode : null;
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(node.text);
  const editableType = editableTypeFor(node);
  const canEdit = editableType !== null;
  const canAddChild = node.tag !== "code" && node.tag !== "image";

  const saveEdit = () => {
    onEdit(node, draftText);
    setEditing(false);
  };

  return (
    <li>
      <div
        className={[
          "object-tree-row",
          `tag-${node.tag}`,
          draggedId === node.id ? "is-dragging" : "",
          currentDrop ? `is-drop-${currentDrop}` : "",
        ].filter(Boolean).join(" ")}
        data-object-id={node.id}
        data-object-line={node.lineNumber}
        data-drop-mode={currentDrop ?? undefined}
        style={{ "--object-depth": depth } as CSSProperties}
      >
        <button
          type="button"
          className="object-tree-handle"
          aria-label={`Drag ${node.text || "empty object"}`}
          title="Drag object"
          onPointerDown={(event) => onPointerDragStart(event, node.id)}
        >
          ⋮⋮
        </button>
        <span className="object-tree-tags">
          {node.tags.map((tag) => (
            <span className={`object-tree-tag tag-${tag}`} key={tag}>{tag}</span>
          ))}
        </span>
        <span className="object-tree-text">
          {node.checked !== undefined && (
            <input
              type="checkbox"
              checked={Boolean(node.checked)}
              onChange={(event) => onToggleCheck(node, event.target.checked)}
              aria-label={`Mark ${node.text || "empty object"} ${node.checked ? "incomplete" : "complete"}`}
            />
          )}
          {node.text || "(empty)"}
        </span>
        <div className="object-tree-actions" aria-label={`Actions for ${node.text || "empty object"}`}>
          {canEdit && (
            <button type="button" onClick={() => { setDraftText(node.text); setEditing((current) => !current); }}>
              {editing ? "Close editor" : "Edit"}
            </button>
          )}
          <label className="object-tree-type-control">
            <span>Type</span>
            <select
              value={editableType ?? node.tag}
              disabled={!canEdit}
              aria-label={`Change type for ${node.text || "empty object"}`}
              onChange={(event) => onChangeType(node, event.target.value as EditableObjectTag)}
            >
              {!canEdit && <option value={node.tag}>{objectTypeLabel(node.tag)}</option>}
              {editableObjectTypes.map((type) => (
                <option key={type.value} value={type.value} disabled={type.value === "code" && !canRenderAsCode(node)}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!canAddChild} onClick={() => onAddChild(node)} title={canAddChild ? "Add a child object" : "Code and image objects cannot own children here"}>
            Add child
          </button>
          <button type="button" disabled title="Include is unavailable because the document model has no include operation">
            Include
          </button>
          <button type="button" className="object-tree-delete" onClick={() => onDelete(node)}>
            Delete
          </button>
          <details className="object-tree-metadata">
            <summary>Details</summary>
            <span>line {node.lineNumber}</span>
            <span>depth {depth}</span>
            <span>parent {node.parentId ?? "root"}</span>
            <span>section {node.parentSectionId ?? "root"}</span>
            <span>id {node.id}</span>
          </details>
        </div>
        {!canEdit && <span className="object-tree-action-note" role="note">Attachment syntax is edited in Markdown view.</span>}
        {!canAddChild && <span className="object-tree-action-note" role="note">This element cannot own children in Object Tree.</span>}
        {editing && canEdit && (
          <form
            className="object-tree-editor"
            onSubmit={(event) => { event.preventDefault(); saveEdit(); }}
          >
            <textarea
              value={draftText}
              rows={Math.min(6, Math.max(2, draftText.split("\n").length))}
              aria-label={`Edit text for ${node.text || "empty object"}`}
              onChange={(event) => setDraftText(event.target.value)}
            />
            <button type="submit">Save text</button>
            <button type="button" onClick={() => { setDraftText(node.text); setEditing(false); }}>Cancel</button>
          </form>
        )}
      </div>
      {node.children.length > 0 && (
        <ol>
          {node.children.map((child) => (
            <ObjectTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              draggedId={draggedId}
              dropTarget={dropTarget}
              onPointerDragStart={onPointerDragStart}
              onEdit={onEdit}
              onChangeType={onChangeType}
              onAddChild={onAddChild}
              onDelete={onDelete}
              onToggleCheck={onToggleCheck}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

export default function ObjectTreeView({ value, onChange }: Props) {
  const { prepared, tree, sourceDocument } = useMemo(() => {
    const prepared = prepareNoteContent(value);
    return {
      prepared,
      tree: objectDocumentFromCanonicalObjectDocument(prepared.canonical).roots,
      sourceDocument: parseObjectDocument(prepared.markdown),
    };
  }, [value]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; mode: ObjectDropMode } | null>(null);
  const draggedIdRef = useRef<string | null>(null);

  const finishDrop = (sourceId: string, targetId: string, mode: ObjectDropMode) => {
    const next = moveObject(prepared.markdown, sourceId, targetId, mode);
    if (next !== prepared.markdown) onChange(next);
    draggedIdRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
  };

  const sourceNodeFor = (node: ObjectLine): ObjectLine | null => {
    const canonicalIndex = prepared.canonical.objects.findIndex((item) => item.id === node.id);
    return sourceDocument.byId.get(node.id) ?? sourceDocument.objects[canonicalIndex] ?? null;
  };

  const replaceSourceNode = (node: ObjectLine, replacement: string) => {
    const sourceNode = sourceNodeFor(node);
    if (!sourceNode) return;
    const next = prepared.markdown.slice(0, sourceNode.from) + replacement + prepared.markdown.slice(sourceNode.to);
    if (next !== prepared.markdown) onChange(next);
  };

  const editNode = (node: ObjectLine, text: string) => {
    const sourceNode = sourceNodeFor(node);
    const type = sourceNode && editableTypeFor(sourceNode);
    if (!sourceNode || !type) return;
    replaceSourceNode(node, renderObjectBlock(sourceNode, type, text));
  };

  const changeNodeType = (node: ObjectLine, type: EditableObjectTag) => {
    const sourceNode = sourceNodeFor(node);
    if (!sourceNode || !editableTypeFor(sourceNode) || type === "code" && !canRenderAsCode(sourceNode)) return;
    replaceSourceNode(node, renderObjectBlock(sourceNode, type, sourceNode.text));
  };

  const addChild = (node: ObjectLine) => {
    const sourceNode = sourceNodeFor(node);
    if (!sourceNode || sourceNode.tag === "code" || sourceNode.tag === "image") return;
    const indent = " ".repeat(Math.max(0, sourceNode.indent + 2));
    const marker = sourceNode.tag === "section" ? "> " : "- ";
    replaceSourceNode(node, `${prepared.markdown.slice(sourceNode.from, sourceNode.to)}\n${indent}${marker}New child`);
  };

  const deleteNode = (node: ObjectLine) => {
    const sourceNode = sourceNodeFor(node);
    if (!sourceNode) return;
    if (typeof window !== "undefined" && !window.confirm(`Delete ${node.text || "empty object"} and its children?`)) return;
    const next = deleteObjectInMarkdown(prepared.markdown, sourceNode.lineNumber);
    if (next !== prepared.markdown) onChange(next);
  };

  const toggleCheck = (node: ObjectLine, checked: boolean) => {
    const sourceNode = sourceNodeFor(node);
    const type = sourceNode && (sourceNode.tag === "section" ? "section" : "checkbox");
    if (!sourceNode || !type) return;
    const nextNode = { ...sourceNode, checked };
    replaceSourceNode(node, renderObjectBlock(nextNode, type, sourceNode.text));
  };

  const startPointerDrag = (event: PointerEvent<HTMLElement>, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    draggedIdRef.current = id;
    setDraggedId(id);
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: globalThis.PointerEvent) => {
      const target = objectTreeRowAt(moveEvent.clientX, moveEvent.clientY);
      const targetId = target?.dataset.objectId;
      if (!target || !targetId) {
        setDropTarget(null);
        return;
      }
      const mode = dropModeForPoint(target, moveEvent.clientY);
      setDropTarget((current) =>
        current?.id === targetId && current.mode === mode
          ? current
          : { id: targetId, mode },
      );
    };

    function cleanup() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
    }

    function finish(upEvent: globalThis.PointerEvent) {
      handle.releasePointerCapture(upEvent.pointerId);
      cleanup();
      const sourceId = draggedIdRef.current;
      const target = objectTreeRowAt(upEvent.clientX, upEvent.clientY);
      const targetId = target?.dataset.objectId;
      if (sourceId !== null && target && targetId) {
        finishDrop(sourceId, targetId, dropModeForPoint(target, upEvent.clientY));
        return;
      }

      draggedIdRef.current = null;
      setDraggedId(null);
      setDropTarget(null);
    }

    function cancel() {
      cleanup();
      draggedIdRef.current = null;
      setDraggedId(null);
      setDropTarget(null);
    }

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel);
  };

  return (
    <div className="object-tree-view">
      {tree.length === 0 ? (
        <div className="object-tree-empty">No objects yet.</div>
      ) : (
        <ol className="object-tree-root">
          {tree.map((node) => (
            <ObjectTreeNode
              key={node.id}
              node={node}
              depth={0}
              draggedId={draggedId}
              dropTarget={dropTarget}
              onPointerDragStart={startPointerDrag}
              onEdit={editNode}
              onChangeType={changeNodeType}
              onAddChild={addChild}
              onDelete={deleteNode}
              onToggleCheck={toggleCheck}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
