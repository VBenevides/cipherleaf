import { useCallback, useEffect, useMemo, useState } from "react";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { TimeClient, TimeDashboard, TimeDashboardDay, TimeEntry, TimeEntryRangeItem, TimeProject, TimeTag, TimeTrackingCatalog } from "../bindings/cipherleaf/internal/vault/models";
import { errorText } from "./errors";
import { ClientSelect, DashboardPeriodSelect, ProjectSelect, TagMultiSelect } from "./TagMultiSelect";
import {
  formatDuration,
  formatDurationWithPercentage,
  formatLocalDate,
  formatLocalDateTime,
  dashboardPresetRange,
  inclusiveLocalDateRange,
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
  week: "Week", month: "Month", dashboard: "Dashboard", clients: "Clients", projects: "Projects", tags: "Tags",
};

type CalendarDay = {
  date: Date;
  key: string;
  start: number;
  end: number;
  items: TimeEntryRangeItem[];
  total: number;
};

function buildCalendarDays(dates: Date[], entries: TimeEntryRangeItem[], totals: TimeDashboardDay[]): CalendarDay[] {
  const totalsByDate = new Map(totals.map((day) => [day.localDate, day.totalSeconds]));
  const entryRanges = entries.map((item) => ({ item, start: new Date(item.entry.startedAtUtc).getTime(), end: new Date(item.entry.endedAtUtc ?? "").getTime() }));
  return dates.map((date) => {
    const start = date.getTime();
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const key = localDateKey(date);
    return { date, key, start, end, items: entryRanges.filter((item) => item.start < end && item.end > start).map((item) => item.item), total: totalsByDate.get(key) ?? 0 };
  });
}

export default function TimeTrackingView({ now, onActiveEntryChange }: { now: Date; onActiveEntryChange?: (entry: TimeEntry | null) => void }) {
  const [tab, setTab] = useState<TimeTrackingTab>("week");
  const [catalog, setCatalog] = useState<TimeTrackingCatalog | null>(null);
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
  const [rangeEntries, setRangeEntries] = useState<TimeEntryRangeItem[]>([]);
  const [dayTotals, setDayTotals] = useState<TimeDashboardDay[]>([]);
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [selectedWeekDay, setSelectedWeekDay] = useState(() => localDateKey(new Date()));
  const [monthAnchor, setMonthAnchor] = useState(() => new Date());
  const [monthEntries, setMonthEntries] = useState<TimeEntryRangeItem[]>([]);
  const [monthDays, setMonthDays] = useState<TimeDashboardDay[]>([]);
  const [name, setName] = useState("");
  const [clientID, setClientID] = useState("");
  const [projectID, setProjectID] = useState("");
  const [tagIDs, setTagIDs] = useState<string[]>([]);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [editName, setEditName] = useState("");
  const [editClientID, setEditClientID] = useState("");
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
  const [labelClientID, setLabelClientID] = useState("");
  const [renamingLabelID, setRenamingLabelID] = useState("");
  const [labelAction, setLabelAction] = useState<{ kind: "client" | "project" | "tag"; id: string; action: "archive" | "restore" | "delete" } | null>(null);
  const [dashboard, setDashboard] = useState<TimeDashboard | null>(null);
  const [dashboardPreset, setDashboardPreset] = useState<DashboardPreset>("current-week");
  const [customStart, setCustomStart] = useState(localDateKey(new Date()));
  const [customEnd, setCustomEnd] = useState(localDateKey(new Date()));
  const [dashboardCustom, setDashboardCustom] = useState(false);
  const [dashboardProject, setDashboardProject] = useState("");
  const [dashboardClient, setDashboardClient] = useState("");
  const [dashboardTags, setDashboardTags] = useState<string[]>([]);
  const [dashboardDetails, setDashboardDetails] = useState<Record<string, TimeEntryRangeItem[]>>({});

  const loadEntries = useCallback(async () => {
    const range = localWeekRange(weekAnchor);
    const result = await VaultService.ListTimeEntries(range.startUTC, range.endUTC, { clientIds: [], projectIds: [], tagIds: [] });
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
    if (tab !== "month") return;
    const range = localMonthRange(monthAnchor);
    setBusy(true);
    VaultService.ListTimeEntries(range.startUTC, range.endUTC, { clientIds: [], projectIds: [], tagIds: [] })
      .then((result) => { setMonthEntries(result.entries ?? []); setMonthDays(result.days ?? []); })
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  }, [monthAnchor, tab]);

  const clients = useMemo(() => (catalog?.clients ?? []).filter((item) => !item.archivedAtUtc), [catalog]);
  const projects = useMemo(() => (catalog?.projects ?? []).filter((item) => !item.archivedAtUtc), [catalog]);
  const taskProjects = useMemo(() => projects.filter((project) => !clientID || project.clientId === clientID), [clientID, projects]);
  const tags = useMemo(() => (catalog?.tags ?? []).filter((item) => !item.archivedAtUtc), [catalog]);
  const weekDates = useMemo(() => localWeekDates(weekAnchor), [weekAnchor]);
  const weekDays = useMemo(() => buildCalendarDays(weekDates, rangeEntries, dayTotals), [dayTotals, rangeEntries, weekDates]);
  const selectedWeekDate = useMemo(() => weekDays.find((day) => day.key === selectedWeekDay), [selectedWeekDay, weekDays]);
  const selectedWeekEntries = useMemo(() => {
    return (selectedWeekDate?.items ?? []).filter((item) => item.entry.endedAtUtc);
  }, [selectedWeekDate]);
  const monthCalendarDays = useMemo(() => buildCalendarDays(localMonthGrid(monthAnchor), monthEntries, monthDays), [monthAnchor, monthDays, monthEntries]);
  const todayKey = localDateKey(now);

  const navigateWeek = (days: number) => {
    const next = days === 0 ? new Date() : new Date(weekAnchor.getFullYear(), weekAnchor.getMonth(), weekAnchor.getDate() + days);
    setWeekAnchor(next);
    setSelectedWeekDay(days === 0 ? localDateKey(next) : localDateKey(localWeekDates(next)[0]));
  };

  const startEntry = async () => {
    if (!name.trim()) { setError("Task name is required"); return; }
    setBusy(true); setError("");
    try {
      const started = await VaultService.StartTimeEntryForClient(name, clientID, projectID, tagIDs);
      setActiveEntry(started); onActiveEntryChange?.(started); await loadEntries();
      setName(""); setClientID(""); setProjectID(""); setTagIDs([]);
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

  const resumeEntry = async (entry: TimeEntry) => {
    setBusy(true); setError("");
    try {
      const resumedClientID = entry.clientId ?? projects.find((project) => project.id === entry.projectId)?.clientId ?? "";
      const started = await VaultService.StartTimeEntryForClient(entry.name, resumedClientID, entry.projectId ?? "", entry.tagIds ?? []);
      setActiveEntry(started); onActiveEntryChange?.(started); await loadEntries();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const beginEdit = (entry: TimeEntry) => {
    setEditing(entry); setEditName(entry.name); setEditProjectID(entry.projectId ?? "");
    setEditClientID(entry.clientId ?? (catalog?.projects ?? []).find((project) => project.id === entry.projectId)?.clientId ?? "");
    setEditTagIDs(entry.tagIds ?? []); setEditStartedAt(localDateTimeValue(entry.startedAtUtc));
    setEditEndedAt(localDateTimeValue(entry.endedAtUtc ?? ""));
  };

  const saveEdit = async () => {
    if (!editing || !editName.trim()) { setError("Task name is required"); return; }
    setBusy(true); setError("");
    try {
      await VaultService.UpdateTimeEntryForClient(
        editing.id, editName, editClientID, editProjectID, editTagIDs,
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

  const saveLabel = async (kind: "client" | "project" | "tag") => {
    if (!labelName.trim()) { setError("Name is required"); return; }
    setBusy(true); setError("");
    try {
      if (kind === "client") {
        const value = renamingLabelID ? await VaultService.RenameClient(renamingLabelID, labelName) : await VaultService.CreateClient(labelName);
        setCatalog((current) => current && ({ ...current, clients: [...(current.clients ?? []).filter((item) => item.id !== value.id), value] }));
      } else if (kind === "project") {
        const value = renamingLabelID ? await VaultService.UpdateProject(renamingLabelID, labelName, labelClientID) : await VaultService.CreateProjectForClient(labelName, labelClientID);
        setCatalog((current) => current && ({ ...current, projects: [...(current.projects ?? []).filter((item) => item.id !== value.id), value] }));
      } else {
        const value = renamingLabelID ? await VaultService.RenameTag(renamingLabelID, labelName) : await VaultService.CreateTag(labelName);
        setCatalog((current) => current && ({ ...current, tags: [...(current.tags ?? []).filter((item) => item.id !== value.id), value] }));
      }
      setLabelName(""); setLabelClientID(""); setRenamingLabelID("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const applyLabelAction = async () => {
    if (!labelAction) return;
    setBusy(true); setError("");
    try {
      if (labelAction.kind === "client") {
        if (labelAction.action === "delete") {
          await VaultService.DeleteClient(labelAction.id);
          setCatalog((current) => current && ({ ...current, clients: (current.clients ?? []).filter((item) => item.id !== labelAction.id) }));
        } else {
          const value = labelAction.action === "restore" ? await VaultService.RestoreClient(labelAction.id) : await VaultService.ArchiveClient(labelAction.id);
          setCatalog((current) => current && ({ ...current, clients: [...(current.clients ?? []).filter((item) => item.id !== value.id), value] }));
        }
      } else if (labelAction.kind === "project") {
        if (labelAction.action === "delete") {
          await VaultService.DeleteProject(labelAction.id);
          setCatalog((current) => current && ({ ...current, projects: (current.projects ?? []).filter((item) => item.id !== labelAction.id) }));
        } else {
          const value = labelAction.action === "restore" ? await VaultService.RestoreProject(labelAction.id) : await VaultService.ArchiveProject(labelAction.id);
          setCatalog((current) => current && ({ ...current, projects: [...(current.projects ?? []).filter((item) => item.id !== value.id), value] }));
        }
      } else {
        if (labelAction.action === "delete") {
          await VaultService.DeleteTag(labelAction.id);
          setCatalog((current) => current && ({ ...current, tags: (current.tags ?? []).filter((item) => item.id !== labelAction.id) }));
        } else {
          const value = labelAction.action === "restore" ? await VaultService.RestoreTag(labelAction.id) : await VaultService.ArchiveTag(labelAction.id);
          setCatalog((current) => current && ({ ...current, tags: [...(current.tags ?? []).filter((item) => item.id !== value.id), value] }));
        }
      }
      setLabelAction(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const labelManager = (kind: "client" | "project" | "tag") => {
    const values: (TimeClient | TimeProject | TimeTag)[] = kind === "client" ? catalog?.clients ?? [] : kind === "project" ? catalog?.projects ?? [] : catalog?.tags ?? [];
    const projectClientID = (item: TimeClient | TimeProject | TimeTag) => kind === "project" ? (item as TimeProject).clientId ?? "" : "";
    const beginRename = (item: TimeClient | TimeProject | TimeTag) => { setRenamingLabelID(item.id); setLabelName(item.name); setLabelClientID(projectClientID(item)); };
    return <div className="time-label-manager"><form onSubmit={(event) => { event.preventDefault(); void saveLabel(kind); }}><input aria-label={`${kind} name`} value={labelName} onChange={(event) => setLabelName(event.target.value)} placeholder={`New ${kind} name`} />{kind === "project" && <ClientSelect clients={clients} selected={labelClientID} onChange={setLabelClientID} />}<button className="primary-button" disabled={busy}>{renamingLabelID ? "Save changes" : `Create ${kind}`}</button>{renamingLabelID && <button type="button" className="secondary-button" onClick={() => { setRenamingLabelID(""); setLabelName(""); setLabelClientID(""); }}>Cancel</button>}</form><section><h3>Active</h3>{values.filter((item) => !item.archivedAtUtc).map((item) => <article key={item.id}><span><strong>{item.name}</strong>{projectClientID(item) && <small>{(catalog?.clients ?? []).find((client) => client.id === projectClientID(item))?.name}</small>}</span><div><button className="secondary-button" onClick={() => beginRename(item)}>Edit</button><button className="secondary-button" onClick={() => setLabelAction({ kind, id: item.id, action: "archive" })}>Archive</button></div></article>)}</section><section><h3>Archived</h3>{values.filter((item) => item.archivedAtUtc).map((item) => <article key={item.id}><strong>{item.name}</strong><div><button className="secondary-button" onClick={() => beginRename(item)}>Edit</button><button className="secondary-button" onClick={() => setLabelAction({ kind, id: item.id, action: "restore" })}>Restore</button><button className="secondary-button danger-button" onClick={() => setLabelAction({ kind, id: item.id, action: "delete" })}>Delete</button></div></article>)}</section></div>;
  };

  const dashboardRange = () => dashboardCustom ? inclusiveLocalDateRange(customStart, customEnd) : dashboardPresetRange(dashboardPreset, new Date());
  const dashboardFilters = () => ({ clientIds: dashboardClient ? [dashboardClient] : [], projectIds: dashboardProject ? [dashboardProject] : [], tagIds: dashboardTags });

  const loadDashboard = useCallback(async () => {
    if (tab !== "dashboard") return;
    setBusy(true); setError("");
    try {
      const range = dashboardCustom ? inclusiveLocalDateRange(customStart, customEnd) : dashboardPresetRange(dashboardPreset, new Date());
      setDashboard(await VaultService.GetTimeDashboard(range.startUTC, range.endUTC, { clientIds: dashboardClient ? [dashboardClient] : [], projectIds: dashboardProject ? [dashboardProject] : [], tagIds: dashboardTags }));
      setDashboardDetails({});
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }, [customEnd, customStart, dashboardClient, dashboardCustom, dashboardPreset, dashboardProject, dashboardTags, tab]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const expandDashboardTask = async (name: string) => {
    if (dashboardDetails[name]) { setDashboardDetails((current) => { const next = { ...current }; delete next[name]; return next; }); return; }
    setError("");
    try { const range = dashboardRange(); const details = await VaultService.ListTimeDashboardGroupEntries(name, range.startUTC, range.endUTC, dashboardFilters()); setDashboardDetails((current) => ({ ...current, [name]: details ?? [] })); }
    catch (reason) { setError(errorText(reason)); }
  };

  const dashboardView = () => {
    const maxDay = Math.max(1, ...(dashboard?.days ?? []).map((day) => day.totalSeconds));
    const sectionTotal = (items: { totalSeconds: number }[]) => items.reduce((total, item) => total + item.totalSeconds, 0);
    const clientsTotal = sectionTotal(dashboard?.clients ?? []);
    const projectsTotal = sectionTotal(dashboard?.projects ?? []);
    const tagsTotal = sectionTotal(dashboard?.tags ?? []);
    const tasksTotal = sectionTotal(dashboard?.tasks ?? []);
    return <div className="time-dashboard">
      <div className="dashboard-controls">
        <DashboardPeriodSelect value={dashboardCustom ? "custom" : dashboardPreset} onChange={(value) => {
          if (value === "custom") setDashboardCustom(true);
          else { setDashboardCustom(false); setDashboardPreset(value); }
        }} />
        {dashboardCustom && <><input aria-label="Start date" type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /><input aria-label="End date" type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></>}
        <ClientSelect label="Filter client" clients={catalog?.clients ?? []} selected={dashboardClient} onChange={(id) => {
          setDashboardClient(id);
          if (id && dashboardProject && (catalog?.projects ?? []).find((project) => project.id === dashboardProject)?.clientId !== id) setDashboardProject("");
        }} />
        <ProjectSelect label="Filter project" projects={(catalog?.projects ?? []).filter((project) => !dashboardClient || project.clientId === dashboardClient)} selected={dashboardProject} onChange={setDashboardProject} />
        <TagMultiSelect label="Filter tags" tags={catalog?.tags ?? []} selected={dashboardTags} onChange={setDashboardTags} />
      </div>
      {busy ? <div className="settings-loading" role="status">Loading dashboard...</div> : dashboard && <>
        <div className="dashboard-counters">
          <div><strong>{dashboard.projectCount}</strong><span>Projects used</span></div>
          <div><strong>{dashboard.tagCount}</strong><span>Tags used</span></div>
          <div><strong>{formatDuration(dashboard.totalSeconds)}</strong><span>Total tracked</span></div>
          <div><strong>{formatDuration(dashboard.averageDaySeconds)}</strong><span>Average per day</span></div>
        </div>
        <div className="dashboard-chart" role="img" aria-label="Tracked time by local calendar day">
          {(dashboard.days ?? []).map((day) => <div key={day.localDate}><span style={{ height: `${Math.max(2, day.totalSeconds / maxDay * 100)}%` }} aria-label={`${day.localDate}: ${formatDuration(day.totalSeconds)}`} /><small>{day.localDate.slice(5)}</small></div>)}
        </div>
        <div className="dashboard-groups">
          <section><header><h3>Clients</h3></header><div className="dashboard-group-rows">{(dashboard.clients ?? []).map((item) => <p key={item.id}><span>{item.name}</span><strong>{formatDurationWithPercentage(item.totalSeconds, clientsTotal)}</strong></p>)}</div></section>
          <section><header><h3>Projects</h3></header><div className="dashboard-group-rows">{(dashboard.projects ?? []).map((item) => <p key={item.id}><span>{item.name}</span><strong>{formatDurationWithPercentage(item.totalSeconds, projectsTotal)}</strong></p>)}</div></section>
          <section><header><h3>Tags</h3><small>Entries with multiple tags count fully in each tag.</small></header><div className="dashboard-group-rows">{(dashboard.tags ?? []).map((item) => <p key={item.id}><span>{item.name}</span><strong>{formatDurationWithPercentage(item.totalSeconds, tagsTotal)}</strong></p>)}</div></section>
          <section><header><h3>Tasks</h3></header><div className="dashboard-group-rows">{(dashboard.tasks ?? []).map((item) => <div key={item.name}><button onClick={() => void expandDashboardTask(item.name)} aria-expanded={!!dashboardDetails[item.name]}><span>{item.name}</span><strong>{formatDurationWithPercentage(item.totalSeconds, tasksTotal)}</strong></button>{dashboardDetails[item.name]?.map((entry) => <p key={entry.entry.id}><span>{formatLocalDateTime(new Date(entry.startedAtUtc))}</span><strong>{formatDurationWithPercentage(entry.totalSeconds, item.totalSeconds)}</strong></p>)}</div>)}</div></section>
        </div>
      </>}
    </div>;
  };

  return (
    <section className="time-tracking-view">
      <header className="time-tracking-header">
        <div><p className="eyebrow">Task View</p><h2>Time tracking</h2></div>
        {activeEntry && <button className="secondary-button" onClick={() => setConfirmAction("finish")}>Finish “{activeEntry.name}”</button>}
      </header>
      <nav className="time-tracking-tabs" aria-label="Time tracking views" role="tablist">
        {TIME_TRACKING_TABS.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => { setTab(item); setRenamingLabelID(""); setLabelName(""); setLabelClientID(""); }}>{TAB_LABELS[item]}</button>)}
      </nav>
      <div className="time-tracking-panel" role="tabpanel">
        {loading ? <div className="settings-loading" role="status">Loading time tracking...</div> : <>
          {error && <div className="time-tracking-error" role="alert">{error}</div>}
          {tab === "week" ? <>
            <form className="time-entry-form" onSubmit={(event) => { event.preventDefault(); void startEntry(); }}>
              <input aria-label="Task name" placeholder="What are you working on?" value={name} onChange={(event) => setName(event.target.value)} disabled={!!activeEntry || busy} />
              <ClientSelect clients={clients} selected={clientID} onChange={(id) => { setClientID(id); if (projectID && projects.find((project) => project.id === projectID)?.clientId !== id) setProjectID(""); }} disabled={!!activeEntry || busy} />
              <ProjectSelect projects={taskProjects} selected={projectID} onChange={(id) => { setProjectID(id); if (!clientID) setClientID(projects.find((project) => project.id === id)?.clientId ?? ""); }} disabled={!!activeEntry || busy} />
              <TagMultiSelect tags={tags} selected={tagIDs} onChange={setTagIDs} disabled={!!activeEntry || busy} />
              <button className="primary-button" disabled={!!activeEntry || busy}>{activeEntry ? "Timer already running" : "Start timer"}</button>
            </form>
            <div className="time-calendar-navigation">
              <button className="secondary-button" onClick={() => navigateWeek(-7)}>Previous</button>
              <strong>{formatLocalDate(weekDates[0])} – {formatLocalDate(weekDates[6])}</strong>
              <button className="secondary-button" onClick={() => navigateWeek(0)}>Current week</button>
              <button className="secondary-button" onClick={() => navigateWeek(7)}>Next</button>
            </div>
            <div className="time-week-grid">
              {weekDays.map(({ date: day, end, items, key, start, total }) => {
                return <section key={key} role="button" tabIndex={0} aria-pressed={selectedWeekDay === key} className={`${key === todayKey ? "today" : ""} ${selectedWeekDay === key ? "selected" : ""}`} onClick={() => setSelectedWeekDay(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedWeekDay(key); } }}><header><strong>{day.toLocaleDateString("en-US", { weekday: "short" })}</strong><span>{day.getDate()}</span></header><div>{items.map((item) => <div key={item.entry.id}><strong>{item.entry.name}</strong><span>{formatDuration(item.entry.endedAtUtc ? item.totalSeconds : (Math.min(now.getTime(), end) - Math.max(new Date(item.entry.startedAtUtc).getTime(), start)) / 1000)}</span></div>)}{!items.length && <small>No entries</small>}</div><footer>{formatDuration(total)}</footer></section>;
              })}
            </div>
            <div className="time-entry-list">
              <h3>{selectedWeekDate && formatLocalDate(selectedWeekDate.date)}</h3>
              {selectedWeekEntries.map(({ entry }) => <article key={entry.id}>
                <div><strong>{entry.name}</strong><span>{formatLocalDateTime(new Date(entry.startedAtUtc))} · {formatDuration((new Date(entry.endedAtUtc!).getTime() - new Date(entry.startedAtUtc).getTime()) / 1000)}</span></div>
                <div><button className="secondary-button" disabled={!!activeEntry || busy} onClick={() => void resumeEntry(entry)}>Resume</button><button className="secondary-button" onClick={() => beginEdit(entry)}>Edit</button><button className="secondary-button danger-button" onClick={() => { setDeleting(entry); setConfirmAction("delete"); }}>Delete</button></div>
              </article>)}
              {!selectedWeekEntries.length && <div className="time-tracking-empty"><p>No completed entries for this day.</p></div>}
            </div>
          </> : tab === "month" ? <>
            <div className="time-calendar-navigation"><button className="secondary-button" onClick={() => setMonthAnchor((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))}>Previous</button><strong>{monthAnchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong><button className="secondary-button" onClick={() => setMonthAnchor(new Date())}>Current month</button><button className="secondary-button" onClick={() => setMonthAnchor((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))}>Next</button></div>
            {busy ? <div className="settings-loading" role="status">Loading month...</div> : <div className="time-month-grid">
              {Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + index)).map((day) => <strong key={day.getDay()}>{day.toLocaleDateString("en-US", { weekday: "short" })}</strong>)}
              {monthCalendarDays.map(({ date: day, items, key, total }) => {
                return <div key={key} tabIndex={0} className={`${day.getMonth() !== monthAnchor.getMonth() ? "outside" : ""} ${key === todayKey ? "today" : ""}`} aria-label={`${day.toLocaleDateString("en-US")}: ${formatDuration(total)}. ${items.map((item) => item.entry.name).join(", ") || "No entries"}`}><span>{day.getDate()}</span><strong>{formatDuration(total)}</strong><div className="time-month-details">{items.map((item) => <span key={item.entry.id}>{item.entry.name} · {formatDuration(item.totalSeconds)}</span>)}</div></div>;
              })}
            </div>}
          </> : tab === "dashboard" ? dashboardView() : tab === "clients" ? labelManager("client") : tab === "projects" ? labelManager("project") : labelManager("tag")}
        </>}
      </div>
      {editing && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label="Correct time entry"><form onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}><h3>Correct time entry</h3><label>Task name<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label><ClientSelect clients={catalog?.clients ?? []} selected={editClientID} onChange={(id) => { setEditClientID(id); if (editProjectID && (catalog?.projects ?? []).find((project) => project.id === editProjectID)?.clientId !== id) setEditProjectID(""); }} /><ProjectSelect projects={(catalog?.projects ?? []).filter((project) => !editClientID || project.clientId === editClientID)} selected={editProjectID} onChange={(id) => { setEditProjectID(id); if (!editClientID) setEditClientID((catalog?.projects ?? []).find((project) => project.id === id)?.clientId ?? ""); }} /><TagMultiSelect tags={catalog?.tags ?? []} selected={editTagIDs} onChange={setEditTagIDs} /><label>Started<input type="datetime-local" value={editStartedAt} onChange={(event) => setEditStartedAt(event.target.value)} /></label><label>Ended<input type="datetime-local" value={editEndedAt} onChange={(event) => setEditEndedAt(event.target.value)} /></label><div className="settings-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" disabled={busy}>Save correction</button></div></form></div>}
      {confirmAction && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label={confirmAction === "finish" ? "Finish timer" : "Delete time entry"}><div><h3>{confirmAction === "finish" ? "Finish active timer?" : "Delete this entry?"}</h3><p>{confirmAction === "finish" ? activeEntry?.name : deleting?.name}</p><div className="settings-actions"><button className="secondary-button" onClick={() => { setConfirmAction(null); setDeleting(null); }}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => confirmAction === "finish" ? void finishEntry() : void deleteEntry()}>{confirmAction === "finish" ? "Finish timer" : "Delete entry"}</button></div></div></div>}
      {labelAction && <div className="time-tracking-dialog" role="dialog" aria-modal="true" aria-label={`${labelAction.action === "delete" ? "Delete" : labelAction.action === "restore" ? "Restore" : "Archive"} ${labelAction.kind}`}><div><h3>{labelAction.action === "delete" ? "Delete" : labelAction.action === "restore" ? "Restore" : "Archive"} this {labelAction.kind}?</h3>{labelAction.action === "delete" && <p>Historical time entries will not be changed.</p>}<div className="settings-actions"><button className="secondary-button" onClick={() => setLabelAction(null)}>Cancel</button><button className={labelAction.action === "delete" ? "danger-button" : "primary-button"} disabled={busy} onClick={() => void applyLabelAction()}>Confirm</button></div></div></div>}
    </section>
  );
}
