import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { TimeClient, TimeDashboard, TimeDashboardDay, TimeEntry, TimeEntryRangeItem, TimeProject, TimeTag, TimeTrackingCatalog } from "../bindings/cipherleaf/internal/vault/models";
import { errorText } from "./errors";
import { ClientSelect, DashboardPeriodSelect, ProjectSelect, TagMultiSelect } from "./TagMultiSelect";
import { ThemedDatePicker } from "./ThemedDatePicker";
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

type LabelAction = {
  kind: "client" | "project" | "tag";
  id: string;
  action: "archive" | "restore" | "delete";
};

type TimeLabel = TimeClient | TimeProject | TimeTag;

type TimeTrackingViewProps = {
  readonly now: Date;
  readonly onActiveEntryChange?: (entry: TimeEntry | null) => void;
};

function labelValues(
  kind: LabelAction["kind"],
  catalog: TimeTrackingCatalog | null,
): TimeLabel[] {
  if (kind === "client") return catalog?.clients ?? [];
  if (kind === "project") return catalog?.projects ?? [];
  return catalog?.tags ?? [];
}

async function performLabelAction(action: LabelAction): Promise<TimeLabel | null> {
  if (action.kind === "client") {
    if (action.action === "delete") {
      await VaultService.DeleteClient(action.id);
      return null;
    }
    if (action.action === "restore") return VaultService.RestoreClient(action.id);
    return VaultService.ArchiveClient(action.id);
  }
  if (action.kind === "project") {
    if (action.action === "delete") {
      await VaultService.DeleteProject(action.id);
      return null;
    }
    if (action.action === "restore") return VaultService.RestoreProject(action.id);
    return VaultService.ArchiveProject(action.id);
  }
  if (action.action === "delete") {
    await VaultService.DeleteTag(action.id);
    return null;
  }
  if (action.action === "restore") return VaultService.RestoreTag(action.id);
  return VaultService.ArchiveTag(action.id);
}

function updateLabelList<T extends TimeLabel>(
  values: T[] | null | undefined,
  action: LabelAction,
  value: TimeLabel | null,
): T[] {
  const remaining = (values ?? []).filter((item) => item.id !== action.id);
  if (action.action === "delete" || !value) return remaining;
  return [...remaining, value as T];
}

function updateCatalogAfterLabelAction(
  catalog: TimeTrackingCatalog | null,
  action: LabelAction,
  value: TimeLabel | null,
): TimeTrackingCatalog | null {
  if (!catalog) return catalog;
  if (action.kind === "client") {
    return { ...catalog, clients: updateLabelList(catalog.clients, action, value) };
  }
  if (action.kind === "project") {
    return { ...catalog, projects: updateLabelList(catalog.projects, action, value) };
  }
  return { ...catalog, tags: updateLabelList(catalog.tags, action, value) };
}

function labelActionName(action: LabelAction["action"]): string {
  if (action === "delete") return "Delete";
  if (action === "restore") return "Restore";
  return "Archive";
}

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

type WeekViewProps = {
  readonly now: Date;
  readonly busy: boolean;
  readonly activeEntry: TimeEntry | null;
  readonly name: string;
  readonly clients: TimeClient[];
  readonly clientID: string;
  readonly taskProjects: TimeProject[];
  readonly projectID: string;
  readonly tags: TimeTag[];
  readonly tagIDs: string[];
  readonly weekDates: Date[];
  readonly weekDays: CalendarDay[];
  readonly selectedWeekDay: string;
  readonly selectedWeekDate: CalendarDay | undefined;
  readonly selectedWeekEntries: TimeEntryRangeItem[];
  readonly todayKey: string;
  readonly onStart: () => void;
  readonly onNameChange: (value: string) => void;
  readonly onClientChange: (value: string) => void;
  readonly onProjectChange: (value: string) => void;
  readonly onTagChange: (value: string[]) => void;
  readonly onNavigate: (days: number) => void;
  readonly onWeekDayChange: (value: string) => void;
  readonly onResume: (entry: TimeEntry) => void;
  readonly onBeginEdit: (entry: TimeEntry) => void;
  readonly onDeleteRequest: (entry: TimeEntry) => void;
};

function WeekView({
  now,
  busy,
  activeEntry,
  name,
  clients,
  clientID,
  taskProjects,
  projectID,
  tags,
  tagIDs,
  weekDates,
  weekDays,
  selectedWeekDay,
  selectedWeekDate,
  selectedWeekEntries,
  todayKey,
  onStart,
  onNameChange,
  onClientChange,
  onProjectChange,
  onTagChange,
  onNavigate,
  onWeekDayChange,
  onResume,
  onBeginEdit,
  onDeleteRequest,
}: WeekViewProps) {
  return <>
    <form className="time-entry-form" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
      <input aria-label="Task name" placeholder="What are you working on?" value={name} onChange={(event) => onNameChange(event.target.value)} disabled={!!activeEntry || busy} />
      <ClientSelect clients={clients} selected={clientID} onChange={onClientChange} disabled={!!activeEntry || busy} />
      <ProjectSelect projects={taskProjects} selected={projectID} onChange={onProjectChange} disabled={!!activeEntry || busy} />
      <TagMultiSelect tags={tags} selected={tagIDs} onChange={onTagChange} disabled={!!activeEntry || busy} />
      <button type="submit" className="primary-button" disabled={!!activeEntry || busy}>{activeEntry ? "Timer already running" : "Start timer"}</button>
    </form>
    <div className="time-calendar-navigation">
      <button className="secondary-button" onClick={() => onNavigate(-7)}>Previous</button>
      <strong>{formatLocalDate(weekDates[0])} – {formatLocalDate(weekDates[6])}</strong>
      <button className="secondary-button" onClick={() => onNavigate(0)}>Current week</button>
      <button className="secondary-button" onClick={() => onNavigate(7)}>Next</button>
    </div>
    <div className="time-week-grid">
      {weekDays.map(({ date: day, end, items, key, start, total }) => {
        return <button type="button" key={key} aria-pressed={selectedWeekDay === key} className={`${key === todayKey ? "today" : ""} ${selectedWeekDay === key ? "selected" : ""}`} onClick={() => onWeekDayChange(key)}><header><strong>{day.toLocaleDateString("en-US", { weekday: "short" })}</strong><span>{day.getDate()}</span></header><div>{items.map((item) => <div key={item.entry.id}><strong>{item.entry.name}</strong><span>{formatDuration(item.entry.endedAtUtc ? item.totalSeconds : (Math.min(now.getTime(), end) - Math.max(new Date(item.entry.startedAtUtc).getTime(), start)) / 1000)}</span></div>)}{!items.length && <small>No entries</small>}</div><footer>{formatDuration(total)}</footer></button>;
      })}
    </div>
    <div className="time-entry-list">
      <h3>{selectedWeekDate && formatLocalDate(selectedWeekDate.date)}</h3>
      {selectedWeekEntries.map(({ entry }) => <article key={entry.id}>
        <div><strong>{entry.name}</strong><span>{formatLocalDateTime(new Date(entry.startedAtUtc))} – {formatLocalDateTime(new Date(entry.endedAtUtc!))} · <strong>{formatDuration((new Date(entry.endedAtUtc!).getTime() - new Date(entry.startedAtUtc).getTime()) / 1000)}</strong></span></div>
        <div><button className="secondary-button" disabled={!!activeEntry || busy} onClick={() => void onResume(entry)}>Resume</button><button className="secondary-button" onClick={() => onBeginEdit(entry)}>Edit</button><button className="secondary-button danger-button" onClick={() => onDeleteRequest(entry)}>Delete</button></div>
      </article>)}
      {!selectedWeekEntries.length && <div className="time-tracking-empty"><p>No completed entries for this day.</p></div>}
    </div>
  </>;
}

type MonthViewProps = {
  readonly busy: boolean;
  readonly monthAnchor: Date;
  readonly monthCalendarDays: CalendarDay[];
  readonly todayKey: string;
  readonly onPrevious: () => void;
  readonly onCurrent: () => void;
  readonly onNext: () => void;
};

function MonthView({ busy, monthAnchor, monthCalendarDays, todayKey, onPrevious, onCurrent, onNext }: MonthViewProps) {
  return <>
    <div className="time-calendar-navigation"><button className="secondary-button" onClick={onPrevious}>Previous</button><strong>{monthAnchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong><button className="secondary-button" onClick={onCurrent}>Current month</button><button className="secondary-button" onClick={onNext}>Next</button></div>
    {busy ? <output className="settings-loading">Loading month...</output> : <div className="time-month-grid">
      {Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + index)).map((day) => <strong key={day.getDay()}>{day.toLocaleDateString("en-US", { weekday: "short" })}</strong>)}
      {monthCalendarDays.map(({ date: day, items, key, total }) => {
        return <div key={key} className={`${day.getMonth() !== monthAnchor.getMonth() ? "outside" : ""} ${key === todayKey ? "today" : ""}`} aria-label={`${day.toLocaleDateString("en-US")}: ${formatDuration(total)}. ${items.map((item) => item.entry.name).join(", ") || "No entries"}`}><span>{day.getDate()}</span><strong>{formatDuration(total)}</strong><div className="time-month-details">{items.map((item) => <span key={item.entry.id}>{item.entry.name} · {formatDuration(item.totalSeconds)}</span>)}</div></div>;
      })}
    </div>}
  </>;
}

export default function TimeTrackingView({ now, onActiveEntryChange }: TimeTrackingViewProps) {
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
  const [labelAction, setLabelAction] = useState<LabelAction | null>(null);
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
    setError("");
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
      setEditing(null);
      await loadEntries();
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
      const value = await performLabelAction(labelAction);
      setCatalog((current) => updateCatalogAfterLabelAction(current, labelAction, value));
      setLabelAction(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const labelManager = (kind: "client" | "project" | "tag") => {
    const values = labelValues(kind, catalog);
    const projectClientID = (item: TimeLabel) => kind === "project" ? (item as TimeProject).clientId ?? "" : "";
    const beginRename = (item: TimeClient | TimeProject | TimeTag) => { setRenamingLabelID(item.id); setLabelName(item.name); setLabelClientID(projectClientID(item)); };
    return <div className="time-label-manager"><form onSubmit={(event) => { event.preventDefault(); void saveLabel(kind); }}><input aria-label={`${kind} name`} value={labelName} onChange={(event) => setLabelName(event.target.value)} placeholder={`New ${kind} name`} />{kind === "project" && <ClientSelect clients={clients} selected={labelClientID} onChange={setLabelClientID} />}<button type="submit" className="primary-button" disabled={busy}>{renamingLabelID ? "Save changes" : `Create ${kind}`}</button>{renamingLabelID && <button type="button" className="secondary-button" onClick={() => { setRenamingLabelID(""); setLabelName(""); setLabelClientID(""); }}>Cancel</button>}</form><section><h3>Active</h3>{values.filter((item) => !item.archivedAtUtc).map((item) => <article key={item.id}><span><strong>{item.name}</strong>{projectClientID(item) && <small>{(catalog?.clients ?? []).find((client) => client.id === projectClientID(item))?.name}</small>}</span><div><button className="secondary-button" onClick={() => beginRename(item)}>Edit</button><button className="secondary-button" onClick={() => setLabelAction({ kind, id: item.id, action: "archive" })}>Archive</button></div></article>)}</section><section><h3>Archived</h3>{values.filter((item) => item.archivedAtUtc).map((item) => <article key={item.id}><strong>{item.name}</strong><div><button className="secondary-button" onClick={() => beginRename(item)}>Edit</button><button className="secondary-button" onClick={() => setLabelAction({ kind, id: item.id, action: "restore" })}>Restore</button><button className="secondary-button danger-button" onClick={() => setLabelAction({ kind, id: item.id, action: "delete" })}>Delete</button></div></article>)}</section></div>;
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
        {dashboardCustom && <><ThemedDatePicker ariaLabel="Start date" value={customStart} onChange={setCustomStart} /><ThemedDatePicker ariaLabel="End date" value={customEnd} onChange={setCustomEnd} /></>}
        <ClientSelect label="Filter client" clients={catalog?.clients ?? []} selected={dashboardClient} onChange={(id) => {
          setDashboardClient(id);
          if (id && dashboardProject && (catalog?.projects ?? []).find((project) => project.id === dashboardProject)?.clientId !== id) setDashboardProject("");
        }} />
        <ProjectSelect label="Filter project" projects={(catalog?.projects ?? []).filter((project) => !dashboardClient || project.clientId === dashboardClient)} selected={dashboardProject} onChange={setDashboardProject} />
        <TagMultiSelect label="Filter tags" tags={catalog?.tags ?? []} selected={dashboardTags} onChange={setDashboardTags} />
      </div>
      {busy ? <output className="settings-loading">Loading dashboard...</output> : dashboard && <>
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
          <section><header><h3>Tasks</h3></header><div className="dashboard-group-rows">{(dashboard.tasks ?? []).map((item) => <div key={item.name}><button onClick={() => void expandDashboardTask(item.name)} aria-expanded={!!dashboardDetails[item.name]}><span>{item.name}</span><strong>{formatDurationWithPercentage(item.totalSeconds, tasksTotal)}</strong></button>{dashboardDetails[item.name]?.map((entry) => <p key={entry.entry.id}><span>{formatLocalDateTime(new Date(entry.startedAtUtc))} – {formatLocalDateTime(new Date(entry.endedAtUtc!))}</span><strong>{formatDurationWithPercentage(entry.totalSeconds, item.totalSeconds)}</strong></p>)}</div>)}</div></section>
        </div>
      </>}
    </div>;
  };

  const tabRenderers: Record<TimeTrackingTab, () => ReactNode> = {
    week: () => <WeekView
      now={now}
      busy={busy}
      activeEntry={activeEntry}
      name={name}
      clients={clients}
      clientID={clientID}
      taskProjects={taskProjects}
      projectID={projectID}
      tags={tags}
      tagIDs={tagIDs}
      weekDates={weekDates}
      weekDays={weekDays}
      selectedWeekDay={selectedWeekDay}
      selectedWeekDate={selectedWeekDate}
      selectedWeekEntries={selectedWeekEntries}
      todayKey={todayKey}
      onStart={startEntry}
      onNameChange={setName}
      onClientChange={(id) => { setClientID(id); if (projectID && projects.find((project) => project.id === projectID)?.clientId !== id) setProjectID(""); }}
      onProjectChange={(id) => { setProjectID(id); if (!clientID) setClientID(projects.find((project) => project.id === id)?.clientId ?? ""); }}
      onTagChange={setTagIDs}
      onNavigate={navigateWeek}
      onWeekDayChange={setSelectedWeekDay}
      onResume={resumeEntry}
      onBeginEdit={beginEdit}
      onDeleteRequest={(entry) => { setDeleting(entry); setConfirmAction("delete"); }}
    />,
    month: () => <MonthView
      busy={busy}
      monthAnchor={monthAnchor}
      monthCalendarDays={monthCalendarDays}
      todayKey={todayKey}
      onPrevious={() => setMonthAnchor((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))}
      onCurrent={() => setMonthAnchor(new Date())}
      onNext={() => setMonthAnchor((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))}
    />,
    dashboard: dashboardView,
    clients: () => labelManager("client"),
    projects: () => labelManager("project"),
    tags: () => labelManager("tag"),
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
        {loading ? <output className="settings-loading">Loading time tracking...</output> : <>
          {error && <div className="time-tracking-error" role="alert">{error}</div>}
          {tabRenderers[tab]()}
        </>}
      </div>
      {editing && <dialog open className="time-tracking-dialog" aria-modal="true" aria-label="Correct time entry"><form onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}><h3>Correct time entry</h3>{error && <div className="time-tracking-error" role="alert">{error}</div>}<label>Task name<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label><ClientSelect clients={catalog?.clients ?? []} selected={editClientID} onChange={(id) => { setEditClientID(id); if (editProjectID && (catalog?.projects ?? []).find((project) => project.id === editProjectID)?.clientId !== id) setEditProjectID(""); }} /><ProjectSelect projects={(catalog?.projects ?? []).filter((project) => !editClientID || project.clientId === editClientID)} selected={editProjectID} onChange={(id) => { setEditProjectID(id); if (!editClientID) setEditClientID((catalog?.projects ?? []).find((project) => project.id === id)?.clientId ?? ""); }} /><TagMultiSelect tags={catalog?.tags ?? []} selected={editTagIDs} onChange={setEditTagIDs} /><div className="time-tracking-date-time"><label>Started date<ThemedDatePicker ariaLabel="Started date" value={editStartedAt.slice(0, 10)} onChange={(date) => setEditStartedAt(`${date}T${editStartedAt.slice(11, 16)}`)} /></label><label>Started time<input aria-label="Started time" type="text" inputMode="numeric" maxLength={5} pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" placeholder="HH:MM" required value={editStartedAt.slice(11, 16)} onChange={(event) => setEditStartedAt(`${editStartedAt.slice(0, 10)}T${event.target.value}`)} /></label></div><div className="time-tracking-date-time"><label>Ended date<ThemedDatePicker ariaLabel="Ended date" value={editEndedAt.slice(0, 10)} onChange={(date) => setEditEndedAt(`${date}T${editEndedAt.slice(11, 16)}`)} /></label><label>Ended time<input aria-label="Ended time" type="text" inputMode="numeric" maxLength={5} pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" placeholder="HH:MM" required value={editEndedAt.slice(11, 16)} onChange={(event) => setEditEndedAt(`${editEndedAt.slice(0, 10)}T${event.target.value}`)} /></label></div><div className="settings-actions"><button type="button" className="secondary-button" onClick={() => { setEditing(null); setError(""); }}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>Save correction</button></div></form></dialog>}
      {confirmAction && <dialog open className="time-tracking-dialog" aria-modal="true" aria-label={confirmAction === "finish" ? "Finish timer" : "Delete time entry"}><div><h3>{confirmAction === "finish" ? "Finish active timer?" : "Delete this entry?"}</h3><p>{confirmAction === "finish" ? activeEntry?.name : deleting?.name}</p><div className="settings-actions"><button type="button" className="secondary-button" onClick={() => { setConfirmAction(null); setDeleting(null); }}>Cancel</button><button type="button" className="primary-button" disabled={busy} onClick={() => confirmAction === "finish" ? void finishEntry() : void deleteEntry()}>{confirmAction === "finish" ? "Finish timer" : "Delete entry"}</button></div></div></dialog>}
      {labelAction && <dialog open className="time-tracking-dialog" aria-modal="true" aria-label={labelActionName(labelAction.action) + " " + labelAction.kind}><div><h3>{labelActionName(labelAction.action)} this {labelAction.kind}?</h3>{labelAction.action === "delete" && <p>Historical time entries will not be changed.</p>}<div className="settings-actions"><button type="button" className="secondary-button" onClick={() => setLabelAction(null)}>Cancel</button><button type="button" className={labelAction.action === "delete" ? "danger-button" : "primary-button"} disabled={busy} onClick={() => void applyLabelAction()}>Confirm</button></div></div></dialog>}
    </section>
  );
}
