import { useRef } from "react";
import type { TimeClient, TimeProject, TimeTag } from "../bindings/cipherleaf/internal/vault/models";
import type { DashboardPreset } from "./timeTracking";

const DASHBOARD_PERIOD_LABELS: Record<DashboardPreset | "custom", string> = {
  "current-week": "Current week",
  "last-week": "Last week",
  "current-month": "Current month",
  "last-month": "Last month",
  custom: "Custom",
};

export function DashboardPeriodSelect({ value, onChange }: { readonly value: DashboardPreset | "custom"; readonly onChange: (value: DashboardPreset | "custom") => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const choose = (next: DashboardPreset | "custom") => { onChange(next); if (details.current) details.current.open = false; };
  return <details ref={details} className="tag-multi-select tracking-period-select">
    <summary aria-label="Period">{DASHBOARD_PERIOD_LABELS[value]}</summary>
    <div className="tag-multi-select-options" role="listbox" aria-label="Period">
      {(Object.keys(DASHBOARD_PERIOD_LABELS) as (DashboardPreset | "custom")[]).map((option) => <button type="button" role="option" aria-selected={value === option} key={option} onClick={() => choose(option)}>{DASHBOARD_PERIOD_LABELS[option]}</button>)}
    </div>
  </details>;
}

export function ClientSelect({ clients, selected, onChange, label = "Client", disabled = false }: {
  readonly clients: TimeClient[];
  readonly selected: string;
  readonly onChange: (id: string) => void;
  readonly label?: string;
  readonly disabled?: boolean;
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
  readonly projects: TimeProject[];
  readonly selected: string;
  readonly onChange: (id: string) => void;
  readonly label?: string;
  readonly disabled?: boolean;
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
  readonly tags: TimeTag[];
  readonly selected: string[];
  readonly onChange: (ids: string[]) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}) {
  const names = tags.filter((tag) => selected.includes(tag.id)).map((tag) => tag.name);
  return <details className={`tag-multi-select ${disabled ? "disabled" : ""}`} onToggle={(event) => { if (disabled) event.currentTarget.open = false; }}>
    <summary aria-disabled={disabled}>{label}: {names.length ? names.join(", ") : "None"}</summary>
    <div className="tag-multi-select-options" role="group" aria-label={label}>
      {tags.length ? tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={selected.includes(tag.id)} onChange={() => onChange(selected.includes(tag.id) ? selected.filter((id) => id !== tag.id) : [...selected, tag.id])} /> <span>{tag.name}</span></label>) : <span className="tag-multi-select-empty">No tags available</span>}
    </div>
  </details>;
}
