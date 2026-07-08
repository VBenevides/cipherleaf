import { useMemo } from "react";
import { markdownObjectTree, type ObjectLine } from "./objectTree";

type Props = {
  value: string;
};

function ObjectTreeNode({ node }: { node: ObjectLine }) {
  return (
    <li>
      <div className={`object-tree-row tag-${node.tag}`}>
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
          {node.children.map((child) => <ObjectTreeNode key={child.id} node={child} />)}
        </ol>
      )}
    </li>
  );
}

export default function ObjectTreeView({ value }: Props) {
  const tree = useMemo(() => markdownObjectTree(value), [value]);

  return (
    <div className="object-tree-view">
      {tree.length === 0 ? (
        <div className="object-tree-empty">No objects yet.</div>
      ) : (
        <ol className="object-tree-root">
          {tree.map((node) => <ObjectTreeNode key={node.id} node={node} />)}
        </ol>
      )}
    </div>
  );
}
