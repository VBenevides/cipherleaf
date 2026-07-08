import { useMemo, useRef, useState, type PointerEvent } from "react";
import {
  markdownObjectTree,
  moveObject,
  type ObjectDropMode,
  type ObjectLine,
} from "./objectTree";

type Props = {
  value: string;
  onChange: (value: string) => void;
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
  draggedId,
  dropTarget,
  onPointerDragStart,
}: {
  node: ObjectLine;
  draggedId: string | null;
  dropTarget: { id: string; mode: ObjectDropMode } | null;
  onPointerDragStart: (event: PointerEvent<HTMLElement>, id: string) => void;
}) {
  const currentDrop = dropTarget?.id === node.id ? dropTarget.mode : null;

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
      >
        <span
          className="object-tree-handle"
          aria-hidden="true"
          onPointerDown={(event) => onPointerDragStart(event, node.id)}
        >
          ⋮⋮
        </span>
        <span className="object-tree-tags">
          {node.tags.map((tag) => (
            <span className={`object-tree-tag tag-${tag}`} key={tag}>{tag}</span>
          ))}
        </span>
        <span className="object-tree-text">
          {node.tags.includes("checkbox") && (
            <input type="checkbox" checked={Boolean(node.checked)} readOnly aria-label="Checkbox state" />
          )}
          {node.text || "(empty)"}
        </span>
        <span className="object-tree-meta">line {node.lineNumber}</span>
        <span className="object-tree-meta">indent {node.indent}</span>
        <span className="object-tree-meta">parent {node.parentId ?? "root"}</span>
        <span className="object-tree-meta">section {node.parentSectionId ?? "root"}</span>
      </div>
      {node.children.length > 0 && (
        <ol>
          {node.children.map((child) => (
            <ObjectTreeNode
              key={child.id}
              node={child}
              draggedId={draggedId}
              dropTarget={dropTarget}
              onPointerDragStart={onPointerDragStart}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

export default function ObjectTreeView({ value, onChange }: Props) {
  const tree = useMemo(() => markdownObjectTree(value), [value]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; mode: ObjectDropMode } | null>(null);
  const draggedIdRef = useRef<string | null>(null);

  const finishDrop = (sourceId: string, targetId: string, mode: ObjectDropMode) => {
    const next = moveObject(value, sourceId, targetId, mode);
    if (next !== value) onChange(next);
    draggedIdRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
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
      setDropTarget({ id: targetId, mode: dropModeForPoint(target, moveEvent.clientY) });
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
              draggedId={draggedId}
              dropTarget={dropTarget}
              onPointerDragStart={startPointerDrag}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
