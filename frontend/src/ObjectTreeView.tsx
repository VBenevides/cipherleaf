import { useMemo, useRef, useState, type PointerEvent } from "react";
import {
  markdownObjectTree,
  moveObjectInMarkdown,
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
    if (element instanceof HTMLElement && element.matches(".object-tree-row[data-object-line]")) return element;
    if (element instanceof HTMLElement) {
      const row = element.closest<HTMLElement>(".object-tree-row[data-object-line]");
      if (row) return row;
    }
  }
  return null;
}

function ObjectTreeNode({
  node,
  draggedLine,
  dropTarget,
  onPointerDragStart,
}: {
  node: ObjectLine;
  draggedLine: number | null;
  dropTarget: { lineNumber: number; mode: ObjectDropMode } | null;
  onPointerDragStart: (event: PointerEvent<HTMLElement>, lineNumber: number) => void;
}) {
  const currentDrop = dropTarget?.lineNumber === node.lineNumber ? dropTarget.mode : null;

  return (
    <li>
      <div
        className={[
          "object-tree-row",
          `tag-${node.tag}`,
          draggedLine === node.lineNumber ? "is-dragging" : "",
          currentDrop ? `is-drop-${currentDrop}` : "",
        ].filter(Boolean).join(" ")}
        data-object-line={node.lineNumber}
        data-drop-mode={currentDrop ?? undefined}
      >
        <span
          className="object-tree-handle"
          aria-hidden="true"
          onPointerDown={(event) => onPointerDragStart(event, node.lineNumber)}
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
              draggedLine={draggedLine}
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
  const [draggedLine, setDraggedLine] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ lineNumber: number; mode: ObjectDropMode } | null>(null);
  const draggedLineRef = useRef<number | null>(null);

  const finishDrop = (sourceLineNumber: number, targetLineNumber: number, mode: ObjectDropMode) => {
    const next = moveObjectInMarkdown(value, sourceLineNumber, targetLineNumber, mode);
    if (next !== value) onChange(next);
    draggedLineRef.current = null;
    setDraggedLine(null);
    setDropTarget(null);
  };

  const startPointerDrag = (event: PointerEvent<HTMLElement>, lineNumber: number) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    draggedLineRef.current = lineNumber;
    setDraggedLine(lineNumber);
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: globalThis.PointerEvent) => {
      const target = objectTreeRowAt(moveEvent.clientX, moveEvent.clientY);
      const targetLine = Number(target?.dataset.objectLine);
      if (!target || !Number.isFinite(targetLine)) {
        setDropTarget(null);
        return;
      }
      setDropTarget({ lineNumber: targetLine, mode: dropModeForPoint(target, moveEvent.clientY) });
    };

    function cleanup() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
    }

    function finish(upEvent: globalThis.PointerEvent) {
      handle.releasePointerCapture(upEvent.pointerId);
      cleanup();
      const sourceLine = draggedLineRef.current;
      const target = objectTreeRowAt(upEvent.clientX, upEvent.clientY);
      const targetLine = Number(target?.dataset.objectLine);
      if (sourceLine !== null && target && Number.isFinite(targetLine)) {
        finishDrop(sourceLine, targetLine, dropModeForPoint(target, upEvent.clientY));
        return;
      }

      draggedLineRef.current = null;
      setDraggedLine(null);
      setDropTarget(null);
    }

    function cancel() {
      cleanup();
      draggedLineRef.current = null;
      setDraggedLine(null);
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
              draggedLine={draggedLine}
              dropTarget={dropTarget}
              onPointerDragStart={startPointerDrag}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
