import { useRef } from "react";
import type { TimeClient, TimeProject, TimeTag } from "../bindings/cipherleaf/internal/vault/models";

export function ClientSelect({ clients, selected, onChange, label = "Client", disabled = false }: {
  clients: TimeClient[];
  selected: string;
  onChange: (id: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const choose = (id: string) => { onChange(id); if (details.current) details.current.open = false; };
  const name = clients.find((client) => client.id === selected)?.name ?? (label === "Client" ? "No client" : "All clients");
  return <details ref={details} className={`tag-multi-select tracking-client-select ${disabled ? "disabled" : ""}`} onToggle={(event) => { if (disabled) event.currentTarget.open = false; }}>
    <summary aria-disabled={disabled}>{label}: {name}</summary>
    <div className="tag-multi-select-options" role="listbox" aria-label={label}>
      <button type="button" role="option" aria-selected={!selected} onClick={() => choose("")}>{label === "Client" ? "No client" : "All clients"}</button>
      {clients.map((client) => <button type="button" role="option" aria-selected={selected === client.id} key={client.id} onClick={() => choose(client.id)}>{client.name}</button>)}
    </div>
  </details>;
}

export function ProjectSelect({ projects, selected, onChange, label = "Project", disabled = false }: {
  projects: TimeProject[];
  selected: string;
  onChange: (id: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const choose = (id: string) => { onChange(id); if (details.current) details.current.open = false; };
  const name = projects.find((project) => project.id === selected)?.name ?? (label === "Project" ? "No project" : "All projects");
  return <details ref={details} className={`tag-multi-select tracking-project-select ${disabled ? "disabled" : ""}`} onToggle={(event) => { if (disabled) event.currentTarget.open = false; }}>
    <summary aria-disabled={disabled}>{label}: {name}</summary>
    <div className="tag-multi-select-options" role="listbox" aria-label={label}>
      <button type="button" role="option" aria-selected={!selected} onClick={() => choose("")}>{label === "Project" ? "No project" : "All projects"}</button>
      {projects.map((project) => <button type="button" role="option" aria-selected={selected === project.id} key={project.id} onClick={() => choose(project.id)}>{project.name}</button>)}
    </div>
  </details>;
}

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
