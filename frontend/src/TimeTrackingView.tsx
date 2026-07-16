import { useCallback, useEffect, useMemo, useState } from "react";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { TimeDashboard, TimeDashboardDay, TimeEntry, TimeEntryRangeItem, TimeTrackingCatalog } from "../bindings/cipherleaf/internal/vault/models";
import { errorText } from "./errors";
import { TagMultiSelect } from "./TagMultiSelect";
import {
  formatDuration,
  dashboardPresetRange,
  inclusiveLocalDateRange,
  initialTimeTrackingTab,
  localDateTimeToUTC,
  localDateTimeValue,
  localDateKey,
  localMonthGrid,
  localMonthRange,
  localWeekDates,
  localWeekRange,
  TIME_TRACKING_TABS,
  type TimeTrackingTab,
  type DashboardPreset,
} from "./timeTracking";

const TAB_LABELS: Record<TimeTrackingTab, string> = {
  week: "Week", month: "Month", dashboard: "Dashboard", projects: "Projects", tags: "Tags",
};

export default function TimeTrackingView({ onActiveEntryChange }: { onActiveEntryChange?: (entry: TimeEntry | null) => void }) {
  const [tab, setTab] = useState<TimeTrackingTab>(initialTimeTrackingTab);
  const [catalog, setCatalog] = useState<TimeTrackingCatalog | null>(null);
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
  const [rangeEntries, setRangeEntries] = useState<TimeEntryRangeItem[]>([]);
  const [dayTotals, setDayTotals] = useState<TimeDashboardDay[]>([]);
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [selectedWeekDay, setSelectedWeekDay] = useState(() => localDateKey(new Date()));
  const [monthAnchor, setMonthAnchor] = useState(() => new Date());
  const [monthEntries, setMonthEntries] = useState<TimeEntryRangeItem[]>([]);
  const [monthDays, setMonthDays] = useState<TimeDashboardDay[]>([]);
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
  const [labelName, setLabelName] = useState("");
  const [renamingLabelID, setRenamingLabelID] = useState("");
  const [labelAction, setLabelAction] = useState<{ kind: "project" | "tag"; id: string; restore: boolean } | null>(null);
  const [dashboard, setDashboard] = useState<TimeDashboard | null>(null);
  const [dashboardPreset, setDashboardPreset] = useState<DashboardPreset>("current-week");
  const [customStart, setCustomStart] = useState(localDateKey(new Date()));
  const [customEnd, setCustomEnd] = useState(localDateKey(new Date()));
  const [dashboardCustom, setDashboardCustom] = useState(false);
  const [dashboardProject, setDashboardProject] = useState("");
  const [dashboardTags, setDashboardTags] = useState<string[]>([]);
  const [dashboardDetails, setDashboardDetails] = useState<Record<string, TimeEntryRangeItem[]>>({});

  const loadEntries = useCallback(async () => {
    const range = localWeekRange(weekAnchor);
    const result = await VaultService.ListTimeEntries(range.startUTC, range.endUTC, { projectIds: [], tagIds: [] });
    setRangeEntries(result.entries ?? []);
    setDayTotals(result.days ?? []);
  }, [weekAnchor]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([VaultService.GetTimeTrackingCatalog(), VaultService.GetActiveTimeEntry(), loadEntries()])
      .then(([nextCatalog, nextActiveEntry]) => {
        if (!cancelled) { setCatalog(nextCatalog); setActiveEntry(nextActiveEntry); onActiveEntryChange?.(nextActiveEntry); }
      })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadEntries, onActiveEntryChange]);


  useEffect(() => {
    if (!activeEntry) return;
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [activeEntry]);

  useEffect(() => {
    if (tab !== "month") return;
    const range = localMonthRange(monthAnchor);
    setBusy(true);
    VaultService.ListTimeEntries(range.startUTC, range.endUTC, { projectIds: [], tagIds: [] })
      .then((result) => { setMonthEntries(result.entries ?? []); setMonthDays(result.days ?? []); })
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  }, [monthAnchor, tab]);

  const projects = useMemo(() => (catalog?.projects ?? []).filter((item) => !item.archivedAtUtc), [catalog]);
  const tags = useMemo(() => (catalog?.tags ?? []).filter((item) => !item.archivedAtUtc), [catalog]);
  const selectedWeekEntries = useMemo(() => {
    const day = localWeekDates(weekAnchor).find((item) => localDateKey(item) === selectedWeekDay);
    if (!day) return [];
    const start = day.getTime();
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    return rangeEntries.filter((item) => item.entry.endedAtUtc && new Date(item.startedAtUtc).getTime() < end && new Date(item.endedAtUtc).getTime() > start);
  }, [rangeEntries, selectedWeekDay, weekAnchor]);

  const navigateWeek = (days: number) => {
    const next = days === 0 ? new Date() : new Date(weekAnchor.getFullYear(), weekAnchor.getMonth(), weekAnchor.getDate() + days);
    setWeekAnchor(next);
    setSelectedWeekDay(days === 0 ? localDateKey(next) : localDateKey(localWeekDates(next)[0]));
  };

  const startEntry = async () => {
    if (!name.trim()) { setError("Task name is required"); return; }
    setBusy(true); setError("");
    try {
      const started = await VaultService.StartTimeEntry(name, projectID, tagIDs);
      setActiveEntry(started); onActiveEntryChange?.(started); await loadEntries();
      setName(""); setProjectID(""); setTagIDs([]);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const finishEntry = async () => {
    setBusy(true); setError("");
    try {
      await VaultService.FinishActiveTimeEntry();
      setActiveEntry(null); onActiveEntryChange?.(null); await loadEntries();
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
      await VaultService.UpdateTimeEntry(
        editing.id, editName, editProjectID, editTagIDs,
        localDateTimeToUTC(editStartedAt), localDateTimeToUTC(editEndedAt),
      );
      await loadEntries(); setEditing(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const deleteEntry = async () => {
    if (!deleting) return;
    setBusy(true); setError("");
    try {
      await VaultService.DeleteTimeEntry(deleting.id);
      await loadEntries();
      setDeleting(null); setConfirmAction(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const saveLabel = async (kind: "project" | "tag") => {
    if (!labelName.trim()) { setError("Name is required"); return; }
    setBusy(true); setError("");
    try {
      const value = kind === "project"
        ? renamingLabelID ? await VaultService.RenameProject(renamingLabelID, labelName) : await VaultService.CreateProject(labelName)
        : renamingLabelID ? await VaultService.RenameTag(renamingLabelID, labelName) : await VaultService.CreateTag(labelName);
      setCatalog((current) => current && ({ ...current, [kind === "project" ? "projects" : "tags"]: [...(current[kind === "project" ? "projects" : "tags"] ?? []).filter((item) => item.id !== value.id), value] }));
      setLabelName(""); setRenamingLabelID("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const applyLabelAction = async () => {
    if (!labelAction) return;
    setBusy(true); setError("");
    try {
      const value = labelAction.kind === "project"
        ? labelAction.restore ? await VaultService.RestoreProject(labelAction.id) : await VaultService.ArchiveProject(labelAction.id)
        : labelAction.restore ? await VaultService.RestoreTag(labelAction.id) : await VaultService.ArchiveTag(labelAction.id);
      const key = labelAction.kind === "project" ? "projects" : "tags";
      setCatalog((current) => current && ({ ...current, [key]: [...(current[key] ?? []).filter((item) => item.id !== value.id), value] }));
      setLabelAction(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const labelManager = (kind: "project" | "tag") => {
    const values = catalog?.[kind === "project" ? "projects" : "tags"] ?? [];
    return <div className="time-label-manager"><form onSubmit={(event) => { event.preventDefault(); void saveLabel(kind); }}><input aria-label={`${kind} name`} value={labelName} onChange={(event) => setLabelName(event.target.value)} placeholder={`New ${kind} name`} /><button className="primary-button" disabled={busy}>{renamingLabelID ? "Save rename" : `Create ${kind}`}</button>{renamingLabelID && <button type="button" className="secondary-button" onClick={() => { setRenamingLabelID(""); setLabelName(""); }}>Cancel</button>}</form><section><h3>Active</h3>{values.filter((item) => !item.archivedAtUtc).map((item) => <article key={item.id}><strong>{item.name}</strong><div><button className="secondary-button" onClick={() => { setRenamingLabelID(item.id); setLabelName(item.name); }}>Rename</button><button className="secondary-button" onClick={() => setLabelAction({ kind, id: item.id, restore: false })}>Archive</button></div></article>)}</section><section><h3>Archived</h3>{values.filter((item) => item.archivedAtUtc).map((item) => <article key={item.id}><strong>{item.name}</strong><div><button className="secondary-button" onClick={() => { setRenamingLabelID(item.id); setLabelName(item.name); }}>Rename</button><button className="secondary-button" onClick={() => setLabelAction({ kind, id: item.id, restore: true })}>Restore</button></div></article>)}</section></div>;
  };

  const dashboardRange = () => dashboardCustom ? inclusiveLocalDateRange(customStart, customEnd) : dashboardPresetRange(dashboardPreset, new Date());
  const dashboardFilters = () => ({ projectIds: dashboardProject ? [dashboardProject] : [], tagIds: dashboardTags });

  const loadDashboard = useCallback(async () => {
    if (tab !== "dashboard") return;
    setBusy(true); setError("");
    try {
      const range = dashboardCustom ? inclusiveLocalDateRange(customStart, customEnd) : dashboardPresetRange(dashboardPreset, new Date());
      setDashboard(await VaultService.GetTimeDashboard(range.startUTC, range.endUTC, { projectIds: dashboardProject ? [dashboardProject] : [], tagIds: dashboardTags }));
      setDashboardDetails({});
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }, [customEnd, customStart, dashboardCustom, dashboardPreset, dashboardProject, dashboardTags, tab]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const expandDashboardTask = async (name: string) => {
    if (dashboardDetails[name]) { setDashboardDetails((current) => { const next = { ...current }; delete next[name]; return next; }); return; }
    setError("");
    try { const range = dashboardRange(); const details = await VaultService.ListTimeDashboardGroupEntries(name, range.startUTC, range.endUTC, dashboardFilters()); setDashboardDetails((current) => ({ ...current, [name]: details ?? [] })); }
    catch (reason) { setError(errorText(reason)); }
  };

  const dashboardView = () => {
    const maxDay = Math.max(1, ...(dashboard?.days ?? []).map((day) => day.totalSeconds));
    return <div className="time-dashboard"><div className="dashboard-controls"><select aria-label="Period" value={dashboardCustom ? "custom" : dashboardPreset} onChange={(event) => { if (event.target.value === "custom") setDashboardCustom(true); else { setDashboardCustom(false); setDashboardPreset(event.target.value as DashboardPreset); } }}><option value="current-week">Current week</option><option value="last-week">Last week</option><option value="current-month">Current month</option><option value="last-month">Last month</option><option value="custom">Custom</option></select>{dashboardCustom && <><input aria-label="Start date" type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /><input aria-label="End date" type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /><button className="secondary-button" onClick={() => void loadDashboard()}>Apply</button></>}<select aria-label="Filter project" value={dashboardProject} onChange={(event) => setDashboardProject(event.target.value)}><option value="">All projects</option>{(catalog?.projects ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><TagMultiSelect label="Filter tags" tags={catalog?.tags ?? []} selected={dashboardTags} onChange={setDashboardTags} /></div>{busy ? <div className="settings-loading" role="status">Loading dashboard...</div> : dashboard && <><div className="dashboard-counters"><div><strong>{dashboard.projectCount}</strong><span>Projects used</span></div><div><strong>{dashboard.tagCount}</strong><span>Tags used</span></div><div><strong>{formatDuration(dashboard.totalSeconds)}</strong><span>Total tracked</span></div><div><strong>{formatDuration(dashboard.averageDaySeconds)}</strong><span>Average per day</span></div></div><div className="dashboard-chart" role="img" aria-label="Tracked time by local calendar day">{(dashboard.days ?? []).map((day) => <div key={day.localDate}><span style={{ height: `${Math.max(2, day.totalSeconds / maxDay * 100)}%` }} aria-label={`${day.localDate}: ${formatDuration(day.totalSeconds)}`} /><small>{day.localDate.slice(5)}</small></div>)}</div><div className="dashboard-groups"><section><h3>Projects</h3>{(dashboard.projects ?? []).map((item) => <p key={item.id}><span>{item.name}</span><strong>{formatDuration(item.totalSeconds)}</strong></p>)}</section><section><h3>Tags</h3><small>Entries with multiple tags count fully in each tag.</small>{(dashboard.tags ?? []).map((item) => <p key={item.id}><span>{item.name}</span><strong>{formatDuration(item.totalSeconds)}</strong></p>)}</section><section><h3>Tasks</h3>{(dashboard.tasks ?? []).map((item) => <div key={item.name}><button onClick={() => void expandDashboardTask(item.name)} aria-expanded={!!dashboardDetails[item.name]}><span>{item.name}</span><strong>{formatDuration(item.totalSeconds)}</strong></button>{dashboardDetails[item.name]?.map((entry) => <p key={entry.entry.id}><span>{new Date(entry.startedAtUtc).toLocaleString()}</span><strong>{formatDuration(entry.totalSeconds)}</strong></p>)}</div>)}</section></div></>}</div>;
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
              <TagMultiSelect tags={tags} selected={tagIDs} onChange={setTagIDs} disabled={!!activeEntry || busy} />
              <button className="primary-button" disabled={!!activeEntry || busy}>{activeEntry ? "Timer already running" : "Start timer"}</button>
            </form>
            <div className="time-calendar-navigation">
              <button className="secondary-button" onClick={() => navigateWeek(-7)}>Previous</button>
              <strong>{localWeekDates(weekAnchor)[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – {localWeekDates(weekAnchor)[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</strong>
              <button className="secondary-button" onClick={() => navigateWeek(0)}>Current week</button>
              <button className="secondary-button" onClick={() => navigateWeek(7)}>Next</button>
            </div>
            <div className="time-week-grid">
              {localWeekDates(weekAnchor).map((day) => {
                const dayStart = day.getTime();
                const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
                const items = rangeEntries.filter((item) => new Date(item.startedAtUtc).getTime() < dayEnd && new Date(item.endedAtUtc).getTime() > dayStart);
                const total = dayTotals.find((item) => item.localDate === localDateKey(day))?.totalSeconds ?? 0;
                const key = localDateKey(day);
                return <section key={key} role="button" tabIndex={0} aria-pressed={selectedWeekDay === key} className={`${key === localDateKey(new Date()) ? "today" : ""} ${selectedWeekDay === key ? "selected" : ""}`} onClick={() => setSelectedWeekDay(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedWeekDay(key); } }}><header><strong>{day.toLocaleDateString(undefined, { weekday: "short" })}</strong><span>{day.getDate()}</span></header><div>{items.map((item) => <div key={item.entry.id}><strong>{item.entry.name}</strong><span>{formatDuration(item.entry.endedAtUtc ? item.totalSeconds : (Math.min(now.getTime(), dayEnd) - Math.max(new Date(item.entry.startedAtUtc).getTime(), dayStart)) / 1000)}</span></div>)}{!items.length && <small>No entries</small>}</div><footer>{formatDuration(total)}</footer></section>;
              })}
            </div>
            <div className="time-entry-list">
              <h3>{localWeekDates(weekAnchor).find((day) => localDateKey(day) === selectedWeekDay)?.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h3>
              {selectedWeekEntries.map(({ entry }) => <article key={entry.id}>
                <div><strong>{entry.name}</strong><span>{new Date(entry.startedAtUtc).toLocaleString()} · {formatDuration((new Date(entry.endedAtUtc!).getTime() - new Date(entry.startedAtUtc).getTime()) / 1000)}</span></div>
                <div><button className="secondary-button" onClick={() => beginEdit(entry)}>Edit</button><button className="secondary-button danger-button" onClick={() => { setDeleting(entry); setConfirmAction("delete"); }}>Delete</button></div>
              </article>)}
              {!selectedWeekEntries.length && <div className="time-tracking-empty"><p>No completed entries for this day.</p></div>}
            </div>
          </> : tab === "month" ? <>
            <div className="time-calendar-navigation"><button className="secondary-button" onClick={() => setMonthAnchor((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))}>Previous</button><strong>{monthAnchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong><button className="secondary-button" onClick={() => setMonthAnchor(new Date())}>Current month</button><button className="secondary-button" onClick={() => setMonthAnchor((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))}>Next</button></div>
            {busy ? <div className="settings-loading" role="status">Loading month...</div> : <div className="time-month-grid">
              {Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + index)).map((day) => <strong key={day.getDay()}>{day.toLocaleDateString(undefined, { weekday: "short" })}</strong>)}
              {localMonthGrid(monthAnchor).map((day) => {
                const key = localDateKey(day); const start = day.getTime(); const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
                const items = monthEntries.filter((item) => new Date(item.startedAtUtc).getTime() < end && new Date(item.endedAtUtc).getTime() > start);
                const total = monthDays.find((item) => item.localDate === key)?.totalSeconds ?? 0;
                return <div key={key} tabIndex={0} className={`${day.getMonth() !== monthAnchor.getMonth() ? "outside" : ""} ${key === localDateKey(new Date()) ? "today" : ""}`} aria-label={`${day.toLocaleDateString()}: ${formatDuration(total)}. ${items.map((item) => item.entry.name).join(", ") || "No entries"}`}><span>{day.getDate()}</span><strong>{formatDuration(total)}</strong><div className="time-month-details">{items.map((item) => <span key={item.entry.id}>{item.entry.name} · {formatDuration(item.totalSeconds)}</span>)}</div></div>;
              })}
            </div>}
          </> : tab === "dashboard" ? dashboardView() : tab === "projects" ? labelManager("project") : labelManager("tag")}
        </>}
      </div>
      {editing && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label="Correct time entry"><form onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}><h3>Correct time entry</h3><label>Task name<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label><label>Project<select value={editProjectID} onChange={(event) => setEditProjectID(event.target.value)}><option value="">No project</option>{(catalog?.projects ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><TagMultiSelect tags={catalog?.tags ?? []} selected={editTagIDs} onChange={setEditTagIDs} /><label>Started<input type="datetime-local" value={editStartedAt} onChange={(event) => setEditStartedAt(event.target.value)} /></label><label>Ended<input type="datetime-local" value={editEndedAt} onChange={(event) => setEditEndedAt(event.target.value)} /></label><div className="settings-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" disabled={busy}>Save correction</button></div></form></div>}
      {confirmAction && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label={confirmAction === "finish" ? "Finish timer" : "Delete time entry"}><div><h3>{confirmAction === "finish" ? "Finish active timer?" : "Delete this entry?"}</h3><p>{confirmAction === "finish" ? activeEntry?.name : deleting?.name}</p><div className="settings-actions"><button className="secondary-button" onClick={() => { setConfirmAction(null); setDeleting(null); }}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => confirmAction === "finish" ? void finishEntry() : void deleteEntry()}>{confirmAction === "finish" ? "Finish timer" : "Delete entry"}</button></div></div></div>}
      {labelAction && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label={`${labelAction.restore ? "Restore" : "Archive"} ${labelAction.kind}`}><div><h3>{labelAction.restore ? "Restore" : "Archive"} this {labelAction.kind}?</h3><div className="settings-actions"><button className="secondary-button" onClick={() => setLabelAction(null)}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => void applyLabelAction()}>Confirm</button></div></div></div>}
    </section>
  );
}
