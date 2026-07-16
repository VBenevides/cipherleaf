import { useCallback, useEffect, useMemo, useState } from "react";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { TimeDashboardDay, TimeEntry, TimeEntryRangeItem, TimeTrackingCatalog } from "../bindings/cipherleaf/internal/vault/models";
import { errorText } from "./errors";
import {
  formatDuration,
  initialTimeTrackingTab,
  localDateTimeToUTC,
  localDateTimeValue,
  localDateKey,
  localWeekDates,
  localWeekRange,
  TIME_TRACKING_TABS,
  type TimeTrackingTab,
} from "./timeTracking";

const TAB_LABELS: Record<TimeTrackingTab, string> = {
  week: "Week", month: "Month", dashboard: "Dashboard", projects: "Projects", tags: "Tags",
};

export default function TimeTrackingView() {
  const [tab, setTab] = useState<TimeTrackingTab>(initialTimeTrackingTab);
  const [catalog, setCatalog] = useState<TimeTrackingCatalog | null>(null);
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [rangeEntries, setRangeEntries] = useState<TimeEntryRangeItem[]>([]);
  const [dayTotals, setDayTotals] = useState<TimeDashboardDay[]>([]);
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  const [name, setName] = useState("");
  const [projectID, setProjectID] = useState("");
  const [tagIDs, setTagIDs] = useState<string[]>([]);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [editName, setEditName] = useState("");
  const [editProjectID, setEditProjectID] = useState("");
  const [editTagIDs, setEditTagIDs] = useState<string[]>([]);
  const [editStartedAt, setEditStartedAt] = useState("");
  const [editEndedAt, setEditEndedAt] = useState("");
  const [confirmAction, setConfirmAction] = useState<"finish" | "delete" | null>(null);
  const [deleting, setDeleting] = useState<TimeEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadEntries = useCallback(async () => {
    const range = localWeekRange(weekAnchor);
    const result = await VaultService.ListTimeEntries(range.startUTC, range.endUTC, { projectIds: [], tagIds: [] });
    setEntries((result.entries ?? []).map((item) => item.entry));
    setRangeEntries(result.entries ?? []);
    setDayTotals(result.days ?? []);
  }, [weekAnchor]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([VaultService.GetTimeTrackingCatalog(), VaultService.GetActiveTimeEntry(), loadEntries()])
      .then(([nextCatalog, nextActiveEntry]) => {
        if (!cancelled) { setCatalog(nextCatalog); setActiveEntry(nextActiveEntry); }
      })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadEntries]);

  useEffect(() => {
    if (!activeEntry) return;
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [activeEntry]);

  const projects = useMemo(() => (catalog?.projects ?? []).filter((item) => !item.archivedAtUtc), [catalog]);
  const tags = useMemo(() => (catalog?.tags ?? []).filter((item) => !item.archivedAtUtc), [catalog]);

  const startEntry = async () => {
    if (!name.trim()) { setError("Task name is required"); return; }
    setBusy(true); setError("");
    try {
      const started = await VaultService.StartTimeEntry(name, projectID, tagIDs);
      setActiveEntry(started); setEntries((current) => [started, ...current]);
      setName(""); setProjectID(""); setTagIDs([]);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const finishEntry = async () => {
    setBusy(true); setError("");
    try {
      const finished = await VaultService.FinishActiveTimeEntry();
      setActiveEntry(null); setEntries((current) => current.map((item) => item.id === finished.id ? finished : item));
      setConfirmAction(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const beginEdit = (entry: TimeEntry) => {
    setEditing(entry); setEditName(entry.name); setEditProjectID(entry.projectId ?? "");
    setEditTagIDs(entry.tagIds ?? []); setEditStartedAt(localDateTimeValue(entry.startedAtUtc));
    setEditEndedAt(localDateTimeValue(entry.endedAtUtc ?? ""));
  };

  const saveEdit = async () => {
    if (!editing || !editName.trim()) { setError("Task name is required"); return; }
    setBusy(true); setError("");
    try {
      const updated = await VaultService.UpdateTimeEntry(
        editing.id, editName, editProjectID, editTagIDs,
        localDateTimeToUTC(editStartedAt), localDateTimeToUTC(editEndedAt),
      );
      setEntries((current) => current.map((item) => item.id === updated.id ? updated : item)); setEditing(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const deleteEntry = async () => {
    if (!deleting) return;
    setBusy(true); setError("");
    try {
      await VaultService.DeleteTimeEntry(deleting.id);
      setEntries((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(null); setConfirmAction(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  return (
    <section className="time-tracking-view">
      <header className="time-tracking-header">
        <div><p className="eyebrow">Local-first activity</p><h2>Time tracking</h2></div>
        {activeEntry && <button className="secondary-button" onClick={() => setConfirmAction("finish")}>Finish “{activeEntry.name}”</button>}
      </header>
      <nav className="time-tracking-tabs" aria-label="Time tracking views" role="tablist">
        {TIME_TRACKING_TABS.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{TAB_LABELS[item]}</button>)}
      </nav>
      <div className="time-tracking-panel" role="tabpanel">
        {loading ? <div className="settings-loading" role="status">Loading time tracking...</div> : <>
          {error && <div className="time-tracking-error" role="alert">{error}</div>}
          {tab === "week" ? <>
            <form className="time-entry-form" onSubmit={(event) => { event.preventDefault(); void startEntry(); }}>
              <input aria-label="Task name" placeholder="What are you working on?" value={name} onChange={(event) => setName(event.target.value)} disabled={!!activeEntry || busy} />
              <select aria-label="Project" value={projectID} onChange={(event) => setProjectID(event.target.value)} disabled={!!activeEntry || busy}><option value="">No project</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
              <fieldset disabled={!!activeEntry || busy}><legend>Tags</legend>{tags.length ? tags.map((item) => <label key={item.id}><input type="checkbox" checked={tagIDs.includes(item.id)} onChange={() => setTagIDs((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} />{item.name}</label>) : <span>No tags</span>}</fieldset>
              <button className="primary-button" disabled={!!activeEntry || busy}>{activeEntry ? "Timer already running" : "Start timer"}</button>
            </form>
            <div className="time-calendar-navigation">
              <button className="secondary-button" onClick={() => setWeekAnchor((date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - 7))}>Previous</button>
              <strong>{localWeekDates(weekAnchor)[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – {localWeekDates(weekAnchor)[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</strong>
              <button className="secondary-button" onClick={() => setWeekAnchor(new Date())}>Current week</button>
              <button className="secondary-button" onClick={() => setWeekAnchor((date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7))}>Next</button>
            </div>
            <div className="time-week-grid">
              {localWeekDates(weekAnchor).map((day) => {
                const dayStart = day.getTime();
                const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
                const items = rangeEntries.filter((item) => new Date(item.startedAtUtc).getTime() < dayEnd && new Date(item.endedAtUtc).getTime() > dayStart);
                const total = dayTotals.find((item) => item.localDate === localDateKey(day))?.totalSeconds ?? 0;
                return <section key={localDateKey(day)} className={localDateKey(day) === localDateKey(new Date()) ? "today" : ""}><header><strong>{day.toLocaleDateString(undefined, { weekday: "short" })}</strong><span>{day.getDate()}</span></header><div>{items.map((item) => <div key={item.entry.id}><strong>{item.entry.name}</strong><span>{formatDuration(item.entry.endedAtUtc ? item.totalSeconds : (Math.min(now.getTime(), dayEnd) - Math.max(new Date(item.entry.startedAtUtc).getTime(), dayStart)) / 1000)}</span></div>)}{!items.length && <small>No entries</small>}</div><footer>{formatDuration(total)}</footer></section>;
              })}
            </div>
            <div className="time-entry-list">
              {entries.filter((item) => item.endedAtUtc).map((entry) => <article key={entry.id}>
                <div><strong>{entry.name}</strong><span>{new Date(entry.startedAtUtc).toLocaleString()} · {formatDuration((new Date(entry.endedAtUtc!).getTime() - new Date(entry.startedAtUtc).getTime()) / 1000)}</span></div>
                <div><button className="secondary-button" onClick={() => beginEdit(entry)}>Edit</button><button className="secondary-button danger-button" onClick={() => { setDeleting(entry); setConfirmAction("delete"); }}>Delete</button></div>
              </article>)}
              {!entries.some((item) => item.endedAtUtc) && <div className="time-tracking-empty"><h3>Week</h3><p>No completed entries this week.</p></div>}
            </div>
          </> : <div className="time-tracking-empty"><h3>{TAB_LABELS[tab]}</h3><p>{tab === "projects" ? `${catalog?.projects?.length ?? 0} projects` : tab === "tags" ? `${catalog?.tags?.length ?? 0} tags` : "No time tracked for this view."}</p></div>}
        </>}
      </div>
      {editing && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label="Correct time entry"><form onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}><h3>Correct time entry</h3><label>Task name<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label><label>Project<select value={editProjectID} onChange={(event) => setEditProjectID(event.target.value)}><option value="">No project</option>{(catalog?.projects ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><fieldset><legend>Tags</legend>{(catalog?.tags ?? []).map((item) => <label key={item.id}><input type="checkbox" checked={editTagIDs.includes(item.id)} onChange={() => setEditTagIDs((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} />{item.name}</label>)}</fieldset><label>Started<input type="datetime-local" value={editStartedAt} onChange={(event) => setEditStartedAt(event.target.value)} /></label><label>Ended<input type="datetime-local" value={editEndedAt} onChange={(event) => setEditEndedAt(event.target.value)} /></label><div className="settings-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" disabled={busy}>Save correction</button></div></form></div>}
      {confirmAction && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label={confirmAction === "finish" ? "Finish timer" : "Delete time entry"}><div><h3>{confirmAction === "finish" ? "Finish active timer?" : "Delete this entry?"}</h3><p>{confirmAction === "finish" ? activeEntry?.name : deleting?.name}</p><div className="settings-actions"><button className="secondary-button" onClick={() => { setConfirmAction(null); setDeleting(null); }}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => confirmAction === "finish" ? void finishEntry() : void deleteEntry()}>{confirmAction === "finish" ? "Finish timer" : "Delete entry"}</button></div></div></div>}
    </section>
  );
}
