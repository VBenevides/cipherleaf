import type { TimeTag } from "../bindings/cipherleaf/internal/vault/models";

export function TagMultiSelect({ tags, selected, onChange, label = "Tags", disabled = false }: {
  tags: TimeTag[];
  selected: string[];
  onChange: (ids: string[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  const names = tags.filter((tag) => selected.includes(tag.id)).map((tag) => tag.name);
  return <details className={`tag-multi-select ${disabled ? "disabled" : ""}`} onToggle={(event) => { if (disabled) event.currentTarget.open = false; }}>
    <summary aria-disabled={disabled}>{label}: {names.length ? names.join(", ") : "None"}</summary>
    <div className="tag-multi-select-options" role="group" aria-label={label}>
      {tags.length ? tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={selected.includes(tag.id)} onChange={() => onChange(selected.includes(tag.id) ? selected.filter((id) => id !== tag.id) : [...selected, tag.id])} /> <span>{tag.name}</span></label>) : <span className="tag-multi-select-empty">No tags available</span>}
    </div>
  </details>;
}
