import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Events } from "@wailsio/runtime";
import logo from "../../assets/logo_alpha_background.png";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type {
  AttachmentInfo,
  FindMatch,
  Folder,
  MergeConflict,
  Note,
  NoteVersion,
  NoteSummary,
  ReplaceResult,
  Session,
  TimeEntry,
  TimeTrackingConflict,
  TimeTrackingCatalog,
  TrashItem,
  VaultSettings,
  VaultStatistics,
} from "../bindings/cipherleaf/internal/vault/models";
import type {
  ConnectionResult,
  SyncSettings,
} from "../bindings/cipherleaf/internal/githubsync/models";
import type { ApplicationStatistics, SyncResult } from "../bindings/cipherleaf/internal/app/models";
import { syncFinishedMessage, syncTimingMessages } from "./syncTiming";
import { errorText } from "./errors";
import { createSerialTaskRunner } from "./serialTask";
import { canReplaceSearch, isAdvancedSearchQuery, searchResultsKey } from "./globalSearch";
import {
  markdownFromCanonicalObjectDocument,
  parseCanonicalObjectDocumentText,
  portableMarkdown,
  prepareNoteContent,
  removeAttachmentReferences,
} from "./objectDocument";
import { targetForMatch, type SearchTarget } from "./searchTarget";
import { rankQuickSwitcher } from "./quickSwitcher";
import { formatDailyTitle, renderNoteTemplate } from "./dailyNotes";
import { formatLocalDateTime, formatLocalTime, formatRunningDuration, millisecondsUntilNextDurationMinute } from "./timeTracking";
import { ClientSelect, ProjectSelect, TagMultiSelect } from "./TagMultiSelect";
import {
  BOARD_COLUMNS,
  CARD_STATUS_LABELS,
  newCardMetadata,
  cardReference,
  normalizeCardTags,
  parseCardDocument,
  parseCardReference,
  parseTemplateDocument,
  serializeTemplateDocument,
  serializeCardDocument,
  transitionCard,
  type CardMetadata,
  type CardStatus,
} from "./cards";

type VaultAction = "create" | "open" | "clone";
type EditorView = "live" | "object" | "markdown";
type SaveState = "idle" | "saving" | "saved" | "error";
type Theme = "light" | "dark" | "archivist";
type JournalLines = "none" | "full" | "dotted";
type SettingsTab = "general" | "appearance";
type SectionDefault = "expanded" | "collapsed";
type WindowLayer = "vaultAction" | "folderPassword" | "appearanceSettings" | "statistics" | "vaultSettings" | "recovery" | "syncConflicts" | "calendar" | "quickSwitcher" | "globalSearch" | "commandPalette" | "appDialog";
type CommandPaletteCommand = {
  id: string;
  shortcut: string;
  name: string;
  description: string;
  run: () => void;
};

const THEME_OPTIONS: { value: Theme; label: string; swatch: string }[] = [
  { value: "light", label: "Light (Nord)", swatch: "light" },
  { value: "dark", label: "Dark (Nord)", swatch: "dark" },
  { value: "archivist", label: "Archivist", swatch: "archivist" },
];
const NOTE_SORT_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "title", label: "Title" },
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
] as const;

function NoteSortSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const label = NOTE_SORT_OPTIONS.find((option) => option.value === value)?.label ?? "Manual";
  const choose = (next: string) => { onChange(next); if (details.current) details.current.open = false; };
  return <details ref={details} className="notes-sort-select">
    <summary aria-label="Sort notes">{label}</summary>
    <div className="notes-sort-options" role="listbox" aria-label="Sort notes">
      {NOTE_SORT_OPTIONS.map((option) => <button type="button" role="option" aria-selected={value === option.value} key={option.value} onClick={() => choose(option.value)}>{option.label}</button>)}
    </div>
  </details>;
}

type TitlebarMenu = "file" | "vault" | "settings";
type ContextMenuState =
  | { kind: "note"; id: string; label: string; x: number; y: number }
  | { kind: "folder"; id: string; label: string; x: number; y: number };
type ConsoleEntry = {
  id: number;
  level: "log" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
};
type FolderPasswordPrompt = {
  title: string;
  submitLabel: string;
};
type AppDialogIcon = "dots" | "file" | "folder" | "lock" | "trash";
type AppDialogState =
  | {
      kind: "prompt";
      eyebrow: string;
      title: string;
      label: string;
      submitLabel: string;
      initialValue?: string;
      icon?: AppDialogIcon;
    }
  | {
      kind: "confirm";
      eyebrow: string;
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
      icon?: AppDialogIcon;
    };

type NoteCrumb = {
  id: string;
  title: string;
};

type GlobalSearchOrigin = {
  noteID: string;
  caretOffset: number;
};

type EditorTab = {
  id: number;
  noteID: string;
  title: string;
  lastActiveAt: number;
};

type ConflictResolution = {
  conflict: MergeConflict;
  localNote: Note;
  mergedContent: string;
  cloudHighlightLines: ReadonlySet<number>;
};

type CardPanelState = {
  note: Note;
  metadata: CardMetadata;
  body: string;
};

const LiveMarkdownEditor = lazy(() => import("./LiveMarkdownEditor"));
const ObjectTreeView = lazy(() => import("./ObjectTreeView"));
const SourceMarkdownEditor = lazy(() => import("./SourceMarkdownEditor"));
const GraphView = lazy(() => import("./GraphView").then(({ GraphView }) => ({ default: GraphView })));
const TimeTrackingView = lazy(() => import("./TimeTrackingView"));

function LastSyncLabel({ timestamp }: { timestamp: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const then = timestamp * 1000;
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  let label: string;
  if (minutes < 60) {
    label = minutes < 1 ? "Last Sync just now" : `Last Sync ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  } else if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    label = `Last Sync ${hours} hour${hours === 1 ? "" : "s"} ago`;
  } else {
    const date = new Date(then);
    const pad = (value: number) => String(value).padStart(2, "0");
    label = `Last Sync at ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return <span className="last-sync-label" title="Time of the last successful sync">{label}</span>;
}

function RunningTimerText({ startedAtUtc }: { startedAtUtc: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatRunningDuration(startedAtUtc, now)}</>;
}

function EditorLoading() {
  return <div className="settings-loading">Loading editor...</div>;
}

const EDITOR_FONT_FAMILY = "CipherleafEditorFont";
const EDITOR_FONT_STORE = "appearance";
const EDITOR_FONT_KEY = "editor-font";
const EDITOR_SYSTEM_FONT_KEY = "cipherleaf-system-font";
const backupStorageKey = (vaultID: string, field: "directory" | "retention") => `cipherleaf-backup-${field}:${vaultID}`;

type StoredEditorFont = {
  name: string;
  data: ArrayBuffer;
};

function noteForEditing(note: Note): { note: Note; migrated: boolean } {
  const prepared = prepareNoteContent(note.content);
  return {
    note: { ...note, content: prepared.canonicalText },
    migrated: prepared.migrated,
  };
}

function markdownForEditing(content: string): string {
  const canonical = parseCanonicalObjectDocumentText(content);
  return canonical ? markdownFromCanonicalObjectDocument(canonical) : content;
}

function cardMetadataFromSummary(summary: NoteSummary): CardMetadata | null {
  const properties = summary.properties ?? {};
  if (properties["cipherleaf-card"] !== true && properties["cipherleaf-card"] !== "true") return null;
  const status = String(properties["cipherleaf-card-status"] ?? "not-started") as CardStatus;
  if (!BOARD_COLUMNS.includes(status as typeof BOARD_COLUMNS[number])) return null;
  const tags = Array.isArray(properties["cipherleaf-card-tags"])
    ? properties["cipherleaf-card-tags"].filter((tag): tag is string => typeof tag === "string")
    : [];
  const metadata: CardMetadata = {
    id: summary.id,
    title: summary.title || "Untitled",
    status,
    tags,
    createdAt: String(properties["cipherleaf-card-created-at"] ?? summary.createdAt),
  };
  for (const [key, field] of [
    ["cipherleaf-card-started-at", "startedAt"],
    ["cipherleaf-card-blocked-on", "blockedOn"],
    ["cipherleaf-card-finished-at", "finishedAt"],
    ["cipherleaf-card-board-id", "boardID"],
    ["cipherleaf-card-column-entered-at", "columnEnteredAt"],
  ] as const) {
    const value = properties[key];
    if (typeof value === "string" && value) metadata[field] = value;
  }
  return metadata;
}

function changedLineNumbers(left: string, right: string): ReadonlySet<number> {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const changed = new Set<number>();
  for (let index = 0; index < rightLines.length; index++) {
    if (rightLines[index] !== (leftLines[index] ?? "")) {
      changed.add(index + 1);
    }
  }
  return changed;
}

function openAppearanceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("cipherleaf-settings", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(EDITOR_FONT_STORE)) {
        request.result.createObjectStore(EDITOR_FONT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredEditorFont(): Promise<StoredEditorFont | null> {
  const database = await openAppearanceDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EDITOR_FONT_STORE, "readonly");
    const request = transaction.objectStore(EDITOR_FONT_STORE).get(EDITOR_FONT_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function writeStoredEditorFont(font: StoredEditorFont): Promise<void> {
  const database = await openAppearanceDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EDITOR_FONT_STORE, "readwrite");
    transaction.objectStore(EDITOR_FONT_STORE).put(font, EDITOR_FONT_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function removeStoredEditorFont(): Promise<void> {
  const database = await openAppearanceDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EDITOR_FONT_STORE, "readwrite");
    transaction.objectStore(EDITOR_FONT_STORE).delete(EDITOR_FONT_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

function Icon({
  name,
  size = 18,
}: {
  name: "book" | "clock" | "copy" | "dots" | "eye" | "file" | "folder" | "graph" | "lock" | "plus" | "search" | "trash" | "x" | "menu";
  size?: number;
}) {
  const paths = {
    book: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    copy: (
      <>
        <rect width="14" height="14" x="8" y="8" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    dots: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    file: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h6" />
      </>
    ),
    folder: (
      <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    ),
    graph: (
      <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="8" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="m7.7 7.1 8.5.8M7.3 7.8l3.4 8.4M16.9 9.8l-3.8 6.4" />
      </>
    ),
    lock: (
      <>
        <rect width="16" height="11" x="4" y="11" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 16H6L5 6M10 11v6M14 11v6" />
      </>
    ),
    x: <path d="M18 6 6 18M6 6l12 12" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "Encrypted vault";
}

function folderLineage(folderID: string, folderByID: ReadonlyMap<string, Folder>): Folder[] {
  const result: Folder[] = [];
  const seen = new Set<string>();
  for (let id = folderID; id; ) {
    if (seen.has(id)) break;
    seen.add(id);
    const folder = folderByID.get(id);
    if (!folder) break;
    result.unshift(folder);
    id = folder.parentId ?? "";
  }
  return result;
}

function folderIsLocked(
  folderID: string,
  folderByID: ReadonlyMap<string, Folder>,
  unlockedFolderIDs: ReadonlySet<string>,
): boolean {
  return folderLineage(folderID, folderByID).some(
    (folder) => folder.locked && !unlockedFolderIDs.has(folder.id),
  );
}

function folderIsHidden(folderID: string, folderByID: ReadonlyMap<string, Folder>): boolean {
  return folderLineage(folderID, folderByID).some((folder) => folder.hidden);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function isSameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
}

function formatStorageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [tabs, setTabs] = useState<EditorTab[]>(() => [{ id: 1, noteID: "", title: "New tab", lastActiveAt: Date.now() }]);
  const [activeTabID, setActiveTabID] = useState(1);
  const [noteTrail, setNoteTrail] = useState<NoteCrumb[]>([]);
  const [backlinks, setBacklinks] = useState<FindMatch[]>([]);
  const [fileAttachments, setFileAttachments] = useState<AttachmentInfo[]>([]);
  const [unlockedFolderIDs, setUnlockedFolderIDs] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedFolderID, setSelectedFolderID] = useState("all");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [selectedTag, setSelectedTag] = useState("");
  const [globalSortMode, setGlobalSortMode] = useState(() => window.localStorage.getItem("cipherleaf-sort-all") || "manual");
  const [unfiledSortMode, setUnfiledSortMode] = useState(() => window.localStorage.getItem("cipherleaf-sort-unfiled") || "manual");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [view, setView] = useState<EditorView>("live");
  const [vaultAction, setVaultAction] = useState<VaultAction | null>(null);
  const [vaultPath, setVaultPath] = useState("");
  const [lastVaultPath, setLastVaultPath] = useState("");
  const [recentVaultPaths, setRecentVaultPaths] = useState<string[]>([]);
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [rememberSecret, setRememberSecret] = useState(false);
  const [rememberError, setRememberError] = useState("");
  const [vaultSecret, setVaultSecret] = useState("");
  const [secretCopied, setSecretCopied] = useState(false);
  const [secretConfirmed, setSecretConfirmed] = useState(false);
  const [cloneRepository, setCloneRepository] = useState("");
  const [cloneSSHKey, setCloneSSHKey] = useState("");
  const [cloneBranch, setCloneBranch] = useState("main");
  const [cloneRepositoryPrivate, setCloneRepositoryPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncNotification, setSyncNotification] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [titleCollapsed, setTitleCollapsed] = useState(() =>
    window.localStorage.getItem("cipherleaf-title-collapsed") === "true"
  );
  const [graphOpen, setGraphOpen] = useState(false);
  const [timeTrackingOpen, setTimeTrackingOpen] = useState(false);
  const [activeTimeEntry, setActiveTimeEntry] = useState<TimeEntry | null>(null);
  const [timerNow, setTimerNow] = useState(() => new Date());
  const [timerDialog, setTimerDialog] = useState<"start" | "finish" | null>(null);
  const [timerCatalog, setTimerCatalog] = useState<TimeTrackingCatalog | null>(null);
  const [timerTaskName, setTimerTaskName] = useState("");
  const [timerClientID, setTimerClientID] = useState("");
  const [timerProjectID, setTimerProjectID] = useState("");
  const [timerTagIDs, setTimerTagIDs] = useState<string[]>([]);
  const [timerBusy, setTimerBusy] = useState(false);
  const [timerError, setTimerError] = useState("");
  const [trackingConflicts, setTrackingConflicts] = useState<TimeTrackingConflict[]>([]);
  const [titlebarMenu, setTitlebarMenu] = useState<TitlebarMenu | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const consoleEntryIDRef = useRef(0);
  const [appearanceSettingsOpen, setAppearanceSettingsOpen] = useState(false);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const [statistics, setStatistics] = useState<ApplicationStatistics | null>(null);
  const [statisticsError, setStatisticsError] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false);
  const [vaultStatistics, setVaultStatistics] = useState<VaultStatistics | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [noteVersions, setNoteVersions] = useState<NoteVersion[]>([]);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [folderPasswordPrompt, setFolderPasswordPrompt] = useState<FolderPasswordPrompt | null>(null);
  const [folderPassword, setFolderPassword] = useState("");
  const [folderPasswordVisible, setFolderPasswordVisible] = useState(false);
  const [appDialog, setAppDialog] = useState<AppDialogState | null>(null);
  const [appDialogValue, setAppDialogValue] = useState("");
  const [syncSettings, setSyncSettings] = useState<SyncSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [historySaving, setHistorySaving] = useState(false);
  const [backupDirectory, setBackupDirectory] = useState("");
  const [backupVaultID, setBackupVaultID] = useState("");
  const [backupDirectoryDraft, setBackupDirectoryDraft] = useState("");
  const [backupRetention, setBackupRetention] = useState(5);
  const [backupRetentionDraft, setBackupRetentionDraft] = useState(5);
  const [backupSaving, setBackupSaving] = useState(false);
  const [backupStatus, setBackupStatus] = useState("");
  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);
  const [syncLinked, setSyncLinked] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncConflicts, setSyncConflicts] = useState<MergeConflict[]>([]);
  const [cardPanel, setCardPanel] = useState<CardPanelState | null>(null);
  const [cardPanelSaving, setCardPanelSaving] = useState(false);
  const [selectedTemplateID, setSelectedTemplateID] = useState("");
  const cardOriginRef = useRef<{ noteID: string; offset: number } | null>(null);
  const [autosaveVersion, setAutosaveVersion] = useState(0);
  const [conflictResolution, setConflictResolution] = useState<ConflictResolution | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [quickSwitcherQuery, setQuickSwitcherQuery] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [globalSearchReplace, setGlobalSearchReplace] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchReplacement, setGlobalSearchReplacement] = useState("");
  const [globalSearchCaseSensitive, setGlobalSearchCaseSensitive] = useState(false);
  const [globalSearchWholeWord, setGlobalSearchWholeWord] = useState(false);
  const [globalSearchMatches, setGlobalSearchMatches] = useState<FindMatch[]>([]);
  const [globalSearchBusy, setGlobalSearchBusy] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState("");
  const [globalSearchTarget, setGlobalSearchTarget] = useState<SearchTarget | null>(null);
  const [globalSearchOrigin, setGlobalSearchOrigin] = useState<GlobalSearchOrigin | null>(null);
  const [caretRestoreVersion, setCaretRestoreVersion] = useState(0);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [calendarSelected, setCalendarSelected] = useState(() => new Date());
  const [dailyNoteFormat, setDailyNoteFormat] = useState(() => window.localStorage.getItem("cipherleaf-daily-format") || "YYYY-MM-DD");
  const [dailyNoteFolderID, setDailyNoteFolderID] = useState(() => window.localStorage.getItem("cipherleaf-daily-folder") || "");
  const [dailyTemplateNoteID, setDailyTemplateNoteID] = useState(() => window.localStorage.getItem("cipherleaf-daily-template") || "");
  const [autosaveIntervalSeconds, setAutosaveIntervalSeconds] = useState(() => {
    const saved = Number(window.localStorage.getItem("cipherleaf-autosave-seconds"));
    return Number.isFinite(saved) && saved >= 60 ? saved : 60;
  });
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(() => {
    const saved = Number(window.localStorage.getItem("cipherleaf-auto-sync-minutes"));
    return Number.isFinite(saved) && saved >= 1 ? saved : 15;
  });
  const [autoLockMinutes, setAutoLockMinutes] = useState(() => {
    const saved = Number(window.localStorage.getItem("cipherleaf-auto-lock-minutes"));
    return Number.isFinite(saved) && saved >= 1 ? saved : 15;
  });
  const [fileHistoryLimit, setFileHistoryLimit] = useState(10);
  const [fileHistoryLimitDraft, setFileHistoryLimitDraft] = useState(10);
  const [sectionDefault, setSectionDefault] = useState<SectionDefault>(() =>
    window.localStorage.getItem("cipherleaf-section-default") === "expanded" ? "expanded" : "collapsed"
  );
  const [today, setToday] = useState(() => new Date());
  const [windowLayers, setWindowLayers] = useState<Partial<Record<WindowLayer, number>>>({});
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = window.localStorage.getItem("cipherleaf-theme");
      if (saved && THEME_OPTIONS.some((item) => item.value === saved)) {
        return saved as Theme;
      }
    } catch {
      // A disabled localStorage should not prevent the editor from loading.
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [editorFontName, setEditorFontName] = useState("");
  const [installedFonts, setInstalledFonts] = useState<string[]>([]);
  const [installedFontsLoading, setInstalledFontsLoading] = useState(false);
  const [editorFontSize, setEditorFontSize] = useState(() => {
    const saved = Number(window.localStorage.getItem("cipherleaf-editor-font-size"));
    return Number.isFinite(saved) && saved >= 10 && saved <= 32 ? saved : 14;
  });
  const [journalLines, setJournalLines] = useState<JournalLines>(() => {
    const saved = window.localStorage.getItem("cipherleaf-journal-lines");
    return saved === "full" || saved === "dotted" ? saved : "none";
  });
  const initialThemeRef = useRef(true);
  const editorFontInputRef = useRef<HTMLInputElement | null>(null);
  const activeEditorFontRef = useRef<FontFace | null>(null);
  const editVersion = useRef(0);
  const runSerializedSave = useRef(createSerialTaskRunner()).current;
  const noteRef = useRef<Note | null>(null);
  const tabsRef = useRef(tabs);
  const activeTabIDRef = useRef(activeTabID);
  const nextTabIDRef = useRef(2);
  const tabNoteCacheRef = useRef(new Map<number, Note>());
  const noteCaretOffsetsRef = useRef(new Map<string, number>());
  const globalSearchRequestRef = useRef(0);
  const globalSearchResultsKeyRef = useRef("");
  const dirtyRef = useRef(false);
  const unlockedRef = useRef(false);
  const dragCandidateRef = useRef<{ kind: "note" | "folder"; id: string; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const folderPasswordResolverRef = useRef<((value: string | null) => void) | null>(null);
  const appDialogResolverRef = useRef<((value: string | boolean | null) => void) | null>(null);
  const nextWindowLayerRef = useRef(160);
  const vaultSettingsLoadedForRef = useRef("");
  const vaultSettingsSnapshotRef = useRef("");
  const autoSyncVaultRef = useRef<() => Promise<void>>(async () => {});

  const portableVaultSettings = useMemo<VaultSettings>(() => ({
    dailyNoteFormat,
    dailyNoteFolderId: dailyNoteFolderID,
    dailyTemplateNoteId: dailyTemplateNoteID,
    autosaveIntervalSeconds,
    autoSyncMinutes,
    autoLockMinutes,
    fileHistoryLimit,
    sectionDefault,
    revision: 0,
    modifiedAt: 0,
  }), [
    autoLockMinutes,
    autoSyncMinutes,
    autosaveIntervalSeconds,
    dailyNoteFolderID,
    dailyNoteFormat,
    dailyTemplateNoteID,
    fileHistoryLimit,
    sectionDefault,
  ]);

  const settingsSnapshot = (settings: VaultSettings) => JSON.stringify({ ...settings, revision: 0, modifiedAt: 0 });

  const applyVaultSettings = (settings: VaultSettings) => {
    vaultSettingsSnapshotRef.current = settingsSnapshot(settings);
    setDailyNoteFormat(settings.dailyNoteFormat);
    setDailyNoteFolderID(settings.dailyNoteFolderId);
    setDailyTemplateNoteID(settings.dailyTemplateNoteId);
    setAutosaveIntervalSeconds(settings.autosaveIntervalSeconds);
    setAutoSyncMinutes(settings.autoSyncMinutes);
    setAutoLockMinutes(settings.autoLockMinutes);
    setFileHistoryLimit(settings.fileHistoryLimit);
    setFileHistoryLimitDraft(settings.fileHistoryLimit);
    setSectionDefault(settings.sectionDefault as SectionDefault);
  };

  const loadVaultSettings = async (vaultID: string, seedIfMissing = true) => {
    const settings = await VaultService.GetVaultSettings();
    vaultSettingsLoadedForRef.current = vaultID;
    if (settings.modifiedAt === 0) {
      vaultSettingsSnapshotRef.current = settingsSnapshot(portableVaultSettings);
      if (!seedIfMissing) return false;
      const saved = await VaultService.SaveVaultSettings(portableVaultSettings);
      vaultSettingsSnapshotRef.current = settingsSnapshot(saved);
      return true;
    }
    applyVaultSettings(settings);
    return false;
  };

  const saveVaultSettings = async (force = false) => {
    if (!session || session.locked || vaultSettingsLoadedForRef.current !== session.vaultId) return;
    const snapshot = settingsSnapshot(portableVaultSettings);
    if (!force && snapshot === vaultSettingsSnapshotRef.current) return;
    const saved = await VaultService.SaveVaultSettings(portableVaultSettings);
    vaultSettingsSnapshotRef.current = settingsSnapshot(saved);
  };

  const bringWindowToFront = useCallback((layer: WindowLayer) => {
    nextWindowLayerRef.current += 1;
    setWindowLayers((current) => ({ ...current, [layer]: nextWindowLayerRef.current }));
  }, []);

  const openCommandPalette = useCallback(() => {
    setTitlebarMenu(null);
    bringWindowToFront("commandPalette");
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
    setCommandPaletteOpen(true);
  }, [bringWindowToFront]);

  const openSettingsSection = (tab: SettingsTab, sectionID?: string) => {
    setSettingsTab(tab);
    if (sectionID) {
      window.requestAnimationFrame(() => {
        document.getElementById(sectionID)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  useEffect(() => {
    noteRef.current = note;
  }, [note]);

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIDRef.current = activeTabID; }, [activeTabID]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const cutoff = Date.now() - 60_000;
      for (const tab of tabsRef.current) {
        if (tab.id !== activeTabIDRef.current && tab.lastActiveAt <= cutoff) {
          tabNoteCacheRef.current.delete(tab.id);
        }
      }
    }, 10_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!syncNotification) return;
    const timeout = window.setTimeout(() => setSyncNotification(""), 5_000);
    return () => window.clearTimeout(timeout);
  }, [syncNotification]);

  useEffect(() => {
    if (!statisticsOpen) return;
    const refresh = () => {
      void VaultService.GetApplicationStatistics()
        .then((value) => {
          setStatistics(value);
          setStatisticsError("");
        })
        .catch((reason) => setStatisticsError(errorText(reason)));
    };
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(interval);
  }, [statisticsOpen]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    const stringify = (value: unknown) => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const append = (level: ConsoleEntry["level"], values: unknown[]) => {
      setConsoleEntries((current) => [
        ...current.slice(-199),
        {
          id: ++consoleEntryIDRef.current,
          level,
          message: values.map(stringify).join(" "),
          timestamp: formatLocalTime(new Date()),
        },
      ]);
    };
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    (["log", "info", "warn", "error"] as const).forEach((level) => {
      console[level] = (...values: unknown[]) => {
        append(level, values);
        original[level](...values);
      };
    });
    const onError = (event: ErrorEvent) => append("error", [event.error || event.message]);
    const onUnhandledRejection = (event: PromiseRejectionEvent) => append("error", [event.reason]);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("cipherleaf-sort-all", globalSortMode);
  }, [globalSortMode]);

  useEffect(() => {
    window.localStorage.setItem("cipherleaf-sort-unfiled", unfiledSortMode);
  }, [unfiledSortMode]);

  useEffect(() => {
    window.localStorage.setItem("cipherleaf-daily-format", dailyNoteFormat);
    window.localStorage.setItem("cipherleaf-daily-folder", dailyNoteFolderID);
    window.localStorage.setItem("cipherleaf-daily-template", dailyTemplateNoteID);
  }, [dailyNoteFolderID, dailyNoteFormat, dailyTemplateNoteID]);

  useEffect(() => {
    window.localStorage.setItem("cipherleaf-autosave-seconds", String(autosaveIntervalSeconds));
    window.localStorage.setItem("cipherleaf-auto-sync-minutes", String(autoSyncMinutes));
    window.localStorage.setItem("cipherleaf-auto-lock-minutes", String(autoLockMinutes));
    window.localStorage.setItem("cipherleaf-section-default", sectionDefault);
    window.localStorage.setItem("cipherleaf-title-collapsed", String(titleCollapsed));
  }, [autoLockMinutes, autoSyncMinutes, autosaveIntervalSeconds, sectionDefault, titleCollapsed]);

  useEffect(() => {
    if (!note || session?.locked) {
      setBacklinks([]);
      setFileAttachments([]);
      return;
    }
    let active = true;
    Promise.all([VaultService.ListBacklinks(note.id), VaultService.ListFileAttachments(note.id)])
      .then(([linked, attachments]) => {
        if (active) {
          setBacklinks(linked ?? []);
          setFileAttachments(attachments ?? []);
        }
      })
      .catch(() => {
        if (active) {
          setBacklinks([]);
          setFileAttachments([]);
        }
      });
    return () => {
      active = false;
    };
  }, [note?.id, session?.locked]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("cipherleaf-theme", theme);
    } catch {
      // The selected theme still applies for this session.
    }
    if (initialThemeRef.current) {
      initialThemeRef.current = false;
      return;
    }
    void VaultService.RememberTheme(theme);
  }, [theme]);

  const activateEditorFont = useCallback(async (name: string, data: ArrayBuffer) => {
    const font = new FontFace(EDITOR_FONT_FAMILY, data);
    await font.load();
    if (activeEditorFontRef.current) {
      document.fonts.delete(activeEditorFontRef.current);
    }
    document.fonts.add(font);
    activeEditorFontRef.current = font;
    document.documentElement.style.setProperty("--selected-editor-font", JSON.stringify(EDITOR_FONT_FAMILY));
    document.documentElement.dataset.editorFont = "custom";
    setEditorFontName(name);
    window.localStorage.removeItem(EDITOR_SYSTEM_FONT_KEY);
  }, []);

  useEffect(() => {
    let active = true;
    const systemFont = window.localStorage.getItem(EDITOR_SYSTEM_FONT_KEY);
    if (systemFont) {
      document.documentElement.style.setProperty("--selected-editor-font", JSON.stringify(systemFont));
      document.documentElement.dataset.editorFont = "custom";
      setEditorFontName(systemFont);
      return;
    }
    void readStoredEditorFont()
      .then((font) => {
        if (active && font) return activateEditorFont(font.name, font.data);
      })
      .catch(() => {
        // A damaged or unavailable appearance database falls back to Georgia.
      });
    return () => {
      active = false;
    };
  }, [activateEditorFont]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${editorFontSize}px`,
    );
    window.localStorage.setItem(
      "cipherleaf-editor-font-size",
      String(editorFontSize),
    );
  }, [editorFontSize]);

  useEffect(() => {
    document.documentElement.dataset.journalLines = journalLines;
    window.localStorage.setItem("cipherleaf-journal-lines", journalLines);
  }, [journalLines]);

  const decreaseEditorFontSize = useCallback(() => {
    setEditorFontSize((current) => Math.max(10, current - 1));
  }, []);

  const increaseEditorFontSize = useCallback(() => {
    setEditorFontSize((current) => Math.min(32, current + 1));
  }, []);

  useEffect(() => {
    let active = true;
    VaultService.GetLastSession()
      .then((session) => {
        if (!active) return;
        if (session.theme && THEME_OPTIONS.some((item) => item.value === session.theme)) {
          setTheme(session.theme as Theme);
        }
      })
      .catch(() => {
        // no stored session, keep default
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!session || session.locked) {
      vaultSettingsLoadedForRef.current = "";
      vaultSettingsSnapshotRef.current = "";
      setSyncLinked(false);
      setLastSyncedAt(0);
      return;
    }
    let active = true;
    VaultService.GetSyncSettings()
      .then((settings) => {
        if (active) {
          setSyncLinked(settings.linked);
          setLastSyncedAt(settings.lastSyncedAt);
          void loadVaultSettings(session.vaultId, !settings.linked).catch((reason) => {
            console.error(`Could not load synced settings: ${errorText(reason)}`);
          });
        }
      })
      .catch(() => {
        if (active) {
          setSyncLinked(false);
          setLastSyncedAt(0);
        }
      });
    return () => {
      active = false;
    };
  }, [session?.locked, session?.vaultId]);

  useEffect(() => {
    if (!session || session.locked || vaultSettingsLoadedForRef.current !== session.vaultId) return;
    const timer = window.setTimeout(() => {
      void saveVaultSettings().catch((reason) => {
        console.error(`Could not save synced settings: ${errorText(reason)}`);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [portableVaultSettings, session?.locked, session?.vaultId]);

  useEffect(() => {
    if (globalSearchOpen) return;
    globalSearchRequestRef.current++;
    globalSearchResultsKeyRef.current = "";
    setGlobalSearchMatches([]);
    setGlobalSearchBusy(false);
  }, [globalSearchOpen]);

  const runGlobalSearch = useCallback(async (query: string) => {
    const request = ++globalSearchRequestRef.current;
    const trimmed = query.trim();
    if (!trimmed) {
      globalSearchResultsKeyRef.current = "";
      setGlobalSearchMatches([]);
      setGlobalSearchBusy(false);
      return;
    }
    setGlobalSearchBusy(true);
    setGlobalSearchError("");
    try {
      const results = await VaultService.FindInNotes(trimmed, globalSearchCaseSensitive, globalSearchWholeWord);
      const folderByID = new Map(folders.map((folder) => [folder.id, folder]));
      if (request !== globalSearchRequestRef.current) return;
      globalSearchResultsKeyRef.current = searchResultsKey(trimmed, globalSearchCaseSensitive, globalSearchWholeWord);
      setGlobalSearchMatches(
        (results ?? []).filter(
          (match) => !folderIsLocked(match.folderId, folderByID, unlockedFolderIDs),
        ),
      );
    } catch (reason) {
      if (request !== globalSearchRequestRef.current) return;
      globalSearchResultsKeyRef.current = "";
      setGlobalSearchError(errorText(reason));
      setGlobalSearchMatches([]);
    } finally {
      if (request === globalSearchRequestRef.current) setGlobalSearchBusy(false);
    }
  }, [folders, globalSearchCaseSensitive, globalSearchWholeWord, unlockedFolderIDs]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isQuickSearch =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k";
      const isFind = (event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "F" || event.key === "f");
      const isReplace = (event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "H" || event.key === "h");
      if (!isFind && !isReplace && !isQuickSearch) return;
      if (session?.locked) return;
      event.preventDefault();
      if (isQuickSearch) {
        bringWindowToFront("quickSwitcher");
        setQuickSwitcherQuery("");
        setQuickSwitcherOpen(true);
        return;
      }
      bringWindowToFront("globalSearch");
      setGlobalSearchReplace(isReplace);
      setGlobalSearchOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bringWindowToFront, session?.locked]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (session?.locked || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "p") return;
      if ((event.target as HTMLElement | null)?.closest("[role=dialog]")) return;
      event.preventDefault();
      openCommandPalette();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openCommandPalette, session?.locked]);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const id = window.setTimeout(() => {
      void runGlobalSearch(globalSearchQuery);
    }, 200);
    return () => window.clearTimeout(id);
  }, [globalSearchOpen, globalSearchQuery, runGlobalSearch]);

  const openGlobalSearchResult = async (match: FindMatch) => {
    const origin = noteRef.current;
    if (origin) {
      setGlobalSearchOrigin({
        noteID: origin.id,
        caretOffset: noteCaretOffsetsRef.current.get(origin.id) ?? 0,
      });
    }
    setGlobalSearchOpen(false);
    const sameNote = noteRef.current?.id === match.noteId;
    try {
      if (!sameNote) {
        await selectNote(match.noteId);
      }
      if (match.field === "content" && noteRef.current?.id === match.noteId) {
        const target = targetForMatch(match, globalSearchQuery);
        if (target) {
          setEditorView("live");
          setGlobalSearchTarget(target);
        }
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const returnToGlobalSearchOrigin = async () => {
    const origin = globalSearchOrigin;
    if (!origin) return;
    setGlobalSearchOrigin(null);
    noteCaretOffsetsRef.current.set(origin.noteID, origin.caretOffset);
    setCaretRestoreVersion((current) => current + 1);
    setEditorView("live");
    if (noteRef.current?.id !== origin.noteID) await selectNote(origin.noteID);
  };

  const closeAppDialog = (value: string | boolean | null) => {
    appDialogResolverRef.current?.(value);
    appDialogResolverRef.current = null;
    setAppDialog(null);
    setAppDialogValue("");
  };

  const requestAppPrompt = (dialog: Extract<AppDialogState, { kind: "prompt" }>) => {
    bringWindowToFront("appDialog");
    setAppDialogValue(dialog.initialValue ?? "");
    setAppDialog(dialog);
    return new Promise<string | null>((resolve) => {
      appDialogResolverRef.current = (value) => resolve(typeof value === "string" ? value : null);
    });
  };

  const requestAppConfirm = (dialog: Extract<AppDialogState, { kind: "confirm" }>) => {
    bringWindowToFront("appDialog");
    setAppDialogValue("");
    setAppDialog(dialog);
    return new Promise<boolean>((resolve) => {
      appDialogResolverRef.current = (value) => resolve(value === true);
    });
  };

  const saveHistorySettings = async () => {
    if (!(await requestAppConfirm({
      kind: "confirm",
      eyebrow: "File history",
      title: "Save file history limit?",
      message: `Change versions kept per file from ${fileHistoryLimit} to ${fileHistoryLimitDraft}. Any versions older than the newest ${fileHistoryLimitDraft} will be permanently deleted.`,
      confirmLabel: "Save",
      danger: true,
      icon: "file",
    }))) return;
    setHistorySaving(true);
    try {
      const saved = await VaultService.SaveVaultSettings({
        ...portableVaultSettings,
        fileHistoryLimit: fileHistoryLimitDraft,
      });
      applyVaultSettings(saved);
      await VaultService.CleanHistory();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setHistorySaving(false);
    }
  };

  const saveBackupSettings = () => {
    if (!session || session.locked) return;
    setBackupSaving(true);
    try {
      if (backupDirectoryDraft) {
        window.localStorage.setItem(backupStorageKey(session.vaultId, "directory"), backupDirectoryDraft);
        window.localStorage.setItem(backupStorageKey(session.vaultId, "retention"), String(backupRetentionDraft));
      } else {
        window.localStorage.removeItem(backupStorageKey(session.vaultId, "directory"));
        window.localStorage.removeItem(backupStorageKey(session.vaultId, "retention"));
      }
      setBackupDirectory(backupDirectoryDraft);
      setBackupVaultID(session.vaultId);
      setBackupRetention(backupRetentionDraft);
      setBackupStatus(backupDirectoryDraft ? "Scheduled encrypted backups enabled." : "Scheduled encrypted backups disabled.");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBackupSaving(false);
    }
  };

  const chooseBackupDestination = async () => {
    try {
      const path = await VaultService.SelectMarkdownFolder("Select encrypted backup destination");
      if (path) setBackupDirectoryDraft(path);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const runGlobalReplace = async () => {
    if (!canReplaceSearch(
      globalSearchQuery,
      globalSearchResultsKeyRef.current,
      globalSearchBusy,
      globalSearchCaseSensitive,
      globalSearchWholeWord,
    )) {
      if (isAdvancedSearchQuery(globalSearchQuery)) {
        setGlobalSearchError("Replace All supports plain-text searches only.");
      }
      return;
    }
    const noteIDs = Array.from(new Set(globalSearchMatches.map((m) => m.noteId)));
    const confirmMessage =
      noteIDs.length === 0
        ? `Replace "${globalSearchQuery}" with "${globalSearchReplacement}" across every note?`
        : `Replace "${globalSearchQuery}" with "${globalSearchReplacement}" in ${noteIDs.length} note${noteIDs.length === 1 ? "" : "s"}?`;
    if (
      !(await requestAppConfirm({
        kind: "confirm",
        eyebrow: "Global replace",
        title: "Replace matches",
        message: confirmMessage,
        confirmLabel: "Replace",
        icon: "dots",
      }))
    ) {
      return;
    }
    setGlobalSearchBusy(true);
    setGlobalSearchError("");
    console.info(`Global replace triggered for ${noteIDs.length || "all"} note(s)`);
    try {
      const result: ReplaceResult = await VaultService.ReplaceAcrossNotes(
        globalSearchQuery,
        globalSearchReplacement,
        noteIDs,
        globalSearchCaseSensitive,
        globalSearchWholeWord,
      );
      await refreshNotes();
      await refreshFolders();
      if (noteRef.current) {
        try {
          const fresh = await VaultService.GetNote(noteRef.current.id);
          applyLoadedNote(fresh);
        } catch {
          // note may have been removed
        }
      }
      void runGlobalSearch(globalSearchQuery);
      setError(
        `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in ${result.replacedNotes} note${result.replacedNotes === 1 ? "" : "s"}.`,
      );
      console.info(`Global replace completed: ${result.replacements} replacement(s) in ${result.replacedNotes} note(s)`);
    } catch (reason) {
      setGlobalSearchError(errorText(reason));
      console.error(`Global replace failed: ${errorText(reason)}`);
    } finally {
      setGlobalSearchBusy(false);
    }
  };

  useEffect(() => {
    VaultService.GetSession()
      .then(async (current) => {
        unlockedRef.current = !current.locked;
        setSession(current);
        if (!current.locked) {
          await syncVaultOnOpen();
          await refreshFolders();
          await refreshNotes();
          return;
        }
        try {
          const autoUnlocked = await VaultService.TryUnlockRemembered();
          unlockedRef.current = !autoUnlocked.locked;
          setSession(autoUnlocked);
          setLastVaultPath(autoUnlocked.path);
          await syncVaultOnOpen();
          await refreshFolders();
          await refreshNotes();
          return;
        } catch {
          // No remembered secret, expired, wrong, or keychain unavailable.
          // Fall through to the manual unlock prompt.
        }
        const lastVaultPath = await VaultService.GetLastVaultPath();
        if (lastVaultPath) {
          setVaultPath(lastVaultPath);
          setLastVaultPath(lastVaultPath);
        }
      })
      .catch((reason) => {
        setError(errorText(reason));
        setSession({ locked: true, path: "", vaultId: "", noteCount: 0 });
      });
  }, []);

  useEffect(() => {
    VaultService.ListRecentVaultPaths()
      .then((paths) => setRecentVaultPaths(paths ?? []))
      .catch(() => setRecentVaultPaths([]));
  }, [session?.path]);

  useEffect(() => {
    if (!vaultMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".vault-selector")) {
        setVaultMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [vaultMenuOpen]);

  const refreshNotes = async (preferredID?: string, preferredNote?: Note) => {
    const result = (await VaultService.ListNotes()) ?? [];
    setNotes(result);
    const targetID = preferredID ?? noteRef.current?.id ?? result[0]?.id;
    if (targetID && result.some((item) => item.id === targetID)) {
      const loaded = preferredNote?.id === targetID
        ? preferredNote
        : await VaultService.GetNote(targetID);
      applyLoadedNote(loaded);
    } else {
      applyLoadedNote(null);
    }
  };

  const refreshFolders = async () => {
    setFolders((await VaultService.ListFolders()) ?? []);
  };

  const syncVaultOnOpen = async () => {
    let linked = false;
    try {
      const settings = await VaultService.GetSyncSettings();
      linked = settings.linked;
      setSyncLinked(linked);
      setLastSyncedAt(settings.lastSyncedAt);
    } catch {
      setSyncLinked(false);
      setLastSyncedAt(0);
      return false;
    }
    if (!linked) return false;
    setSyncing(true);
    setSyncNotification("");
    try {
      console.info(">>>>> Cloud Sync Triggered");
      const syncStartedAt = performance.now();
      const result = await VaultService.SyncNow();
      if (session?.vaultId && await loadVaultSettings(session.vaultId)) {
        await VaultService.SyncNow();
      }
      const syncElapsed = performance.now() - syncStartedAt;
      syncTimingMessages(result.timings, syncElapsed, result.git).forEach((message) => console.info(message));
      if (result.warning) {
        setError(result.warning);
      } else {
        setSyncNotification(syncFinishedMessage(syncElapsed));
      }
      const settings = await VaultService.GetSyncSettings();
      setLastSyncedAt(settings.lastSyncedAt);
    } catch (reason) {
      setError(`Vault opened, but sync failed: ${errorText(reason)}`);
    } finally {
      setSyncing(false);
    }
    return true;
  };

  const updateSummary = (saved: NoteSummary) => {
    setNotes((current) => current.some(({ id }) => id === saved.id)
      ? current.map((item) => item.id === saved.id ? saved : item)
      : [...current, saved]);
  };

  const applyLoadedNote = (loaded: Note | null, state: SaveState = "idle") => {
    setGlobalSearchTarget(null);
    if (!loaded) {
      setTabs((current) => current.map((tab) => tab.id === activeTabIDRef.current
        ? { ...tab, noteID: "", title: "New tab", lastActiveAt: Date.now() }
        : tab));
      noteRef.current = null;
      dirtyRef.current = false;
      setNote(null);
      setDirty(false);
      setSaveState(state);
      return;
    }
    const prepared = noteForEditing(loaded);
    tabNoteCacheRef.current.delete(activeTabIDRef.current);
    setTabs((current) => current.map((tab) => tab.id === activeTabIDRef.current
      ? { ...tab, noteID: prepared.note.id, title: prepared.note.title || "Untitled", lastActiveAt: Date.now() }
      : tab));
    noteRef.current = prepared.note;
    dirtyRef.current = false;
    setNote(prepared.note);
    setDirty(false);
    setSaveState(state);
  };

  const persistCurrent = (snapshot = noteRef.current) => {
    if (!snapshot || !dirtyRef.current) return Promise.resolve(snapshot);
    const version = editVersion.current;
    setSaveState("saving");
    return runSerializedSave(async () => {
      setSaveState("saving");
      try {
        const saved = await VaultService.SaveNote(
          snapshot.id,
          snapshot.title,
          markdownForEditing(snapshot.content),
        );
        updateSummary(saved.summary);
        const prepared = noteForEditing(saved.note);
        if (version === editVersion.current) {
          noteRef.current = prepared.note;
          dirtyRef.current = false;
          setNote(prepared.note);
          setDirty(false);
          setSaveState("saved");
        }
        return prepared.note;
      } catch (reason) {
        setSaveState("error");
        setError(errorText(reason));
        throw reason;
      }
    });
  };

  const persistCurrentInBackground = (snapshot = noteRef.current) => {
    void persistCurrent(snapshot).catch(() => {
      // persistCurrent already presents the actionable error.
    });
  };

  const saveCurrentDraft = () => {
    const snapshot = noteRef.current;
    if (!snapshot || !dirtyRef.current) return;
    setNote(snapshot);
    persistCurrentInBackground(snapshot);
  };

  const persistWhenEditorLosesFocus = (event: ReactFocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (!event.relatedTarget && !document.hasFocus()) return;
    saveCurrentDraft();
  };

  const quitApplication = async () => {
    try {
      await persistCurrent();
      await VaultService.QuitApplication();
    } catch {
      // persistCurrent already presents the actionable error.
    }
  };

  const quitApplicationRef = useRef(quitApplication);
  quitApplicationRef.current = quitApplication;

  useEffect(() => Events.On("cipherleaf:close-requested", () => {
    void quitApplicationRef.current();
  }), []);

  useEffect(() => {
    if (!dirty || !note) return;
    const timer = window.setTimeout(() => {
      persistCurrentInBackground();
    }, autosaveIntervalSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [autosaveIntervalSeconds, autosaveVersion, dirty, note?.id]);

  useEffect(() => {
    if (!session || session.locked || !syncLinked || autoSyncMinutes === autoLockMinutes) return;
    const delay = autoSyncMinutes * 60 * 1000;
    let timer = window.setTimeout(() => void autoSyncVaultRef.current(), delay);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void autoSyncVaultRef.current(), delay);
    };
    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "keydown",
      "mousemove",
      "touchstart",
    ];
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [autoLockMinutes, autoSyncMinutes, session?.vaultId, session?.locked, syncLinked]);

  useEffect(() => {
    if (!session || session.locked) return;
    const delay = autoLockMinutes * 60 * 1000;
    const retryDelay = Math.min(delay, 60_000);
    let timer: number;
    const lock = async () => {
      if (autoSyncMinutes === autoLockMinutes) await autoSyncVaultRef.current();
      if (!await autoLock()) timer = window.setTimeout(() => void lock(), retryDelay);
    };
    timer = window.setTimeout(() => void lock(), delay);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void lock(), delay);
    };
    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "keydown",
      "mousemove",
      "touchstart",
    ];
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [autoLockMinutes, autoSyncMinutes, session?.vaultId, session?.locked]);

  useEffect(() => {
    if (!session || session.locked) return;
    try {
      const directory = window.localStorage.getItem(backupStorageKey(session.vaultId, "directory")) ?? "";
      const storedRetention = Number(window.localStorage.getItem(backupStorageKey(session.vaultId, "retention")));
      const retention = Number.isInteger(storedRetention) && storedRetention >= 1 && storedRetention <= 30 ? storedRetention : 5;
      setBackupVaultID(session.vaultId);
      setBackupDirectory(directory);
      setBackupDirectoryDraft(directory);
      setBackupRetention(retention);
      setBackupRetentionDraft(retention);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [session?.vaultId, session?.locked]);

  useEffect(() => {
    if (!session || session.locked || backupVaultID !== session.vaultId || !backupDirectory) return;
    let active = true;
    const run = async () => {
      try {
        await persistCurrent();
        const path = await VaultService.CreateScheduledBackup(backupDirectory, backupRetention);
        if (active && path) setBackupStatus(`Encrypted backup created at ${path}`);
      } catch (reason) {
        if (active) setError(`Scheduled backup failed: ${errorText(reason)}`);
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [backupDirectory, backupRetention, backupVaultID, session?.vaultId, session?.locked]);

  useEffect(() => {
    if (!session || session.locked) { setActiveTimeEntry(null); return; }
    let active = true;
    Promise.all([VaultService.GetActiveTimeEntry(), VaultService.ListTimeTrackingConflicts()]).then(([entry, conflicts]) => { if (active) { setActiveTimeEntry(entry); setTrackingConflicts(conflicts ?? []); } }).catch(() => { if (active) setActiveTimeEntry(null); });
    return () => { active = false; };
  }, [session?.vaultId, session?.locked]);

  useEffect(() => {
    if (!activeTimeEntry || !timeTrackingOpen) return;
    const refresh = () => setTimerNow(new Date());
    refresh();
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      refresh();
      interval = window.setInterval(refresh, 60_000);
    }, millisecondsUntilNextDurationMinute(activeTimeEntry.startedAtUtc));
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [activeTimeEntry?.id, activeTimeEntry?.startedAtUtc, timeTrackingOpen]);

  const openStartTimerDialog = () => {
    setTimerDialog("start"); setTimerError("");
    VaultService.GetTimeTrackingCatalog().then(setTimerCatalog).catch((reason) => setTimerError(errorText(reason)));
  };

  const startTimerFromDialog = async () => {
    if (!timerTaskName.trim()) { setTimerError("Task name is required"); return; }
    setTimerBusy(true); setTimerError("");
    try {
      const entry = await VaultService.StartTimeEntryForClient(timerTaskName, timerClientID, timerProjectID, timerTagIDs);
      setActiveTimeEntry(entry); setTimerTaskName(""); setTimerClientID(""); setTimerProjectID(""); setTimerTagIDs([]); setTimerDialog(null);
    } catch (reason) { setTimerError(errorText(reason)); }
    finally { setTimerBusy(false); }
  };

  const finishTimerFromDialog = async () => {
    if (!activeTimeEntry) return;
    setTimerBusy(true); setTimerError("");
    try { await VaultService.FinishActiveTimeEntry(); setActiveTimeEntry(null); setTimerDialog(null); }
    catch (reason) { setTimerError(errorText(reason)); }
    finally { setTimerBusy(false); }
  };

  useEffect(() => {
    if (!timerDialog) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setTimerDialog(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [timerDialog]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || session?.locked) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[role=dialog]")) return;
      if (event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault(); openStartTimerDialog(); return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault(); setTimerError(""); setTimerDialog("finish"); return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((current) => !current);
        return;
      }
      if (target?.closest("input, textarea, select")) return;
      if (event.key.toLowerCase() === "s" && !event.shiftKey) {
        event.preventDefault();
        persistCurrentInBackground();
      } else if (event.key.toLowerCase() === "s" && event.shiftKey) {
        event.preventDefault();
        void saveAndSync();
      } else if (event.key.toLowerCase() === "r" && event.shiftKey) {
        event.preventDefault();
        void syncNow();
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createNote();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [session?.locked, selectedFolderID, syncLinked, syncing]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!titlebarMenu) return;
    const close = () => {
      setTitlebarMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [titlebarMenu]);

  const autoLock = async () => {
    console.info("Vault auto-lock triggered");
    try {
      await persistCurrent();
    } catch {
      return false;
    }
    const locked = await VaultService.LockVault();
    resetToLocked(locked);
    console.info("Vault auto-lock completed");
    return true;
  };

  const autoLockRef = useRef(autoLock);
  autoLockRef.current = autoLock;
  useEffect(() => {
    let retry: number | undefined;
    const lock = async () => {
      if (!await autoLockRef.current()) retry = window.setTimeout(() => void lock(), 60_000);
    };
    const off = Events.On("cipherleaf:system-lock-requested", () => {
      if (retry) window.clearTimeout(retry);
      void lock();
    });
    return () => {
      off();
      if (retry) window.clearTimeout(retry);
    };
  }, []);

  const resetToLocked = (locked: Session) => {
    unlockedRef.current = false;
    noteCaretOffsetsRef.current.clear();
    tabNoteCacheRef.current.clear();
    const emptyTab = { id: nextTabIDRef.current++, noteID: "", title: "New tab", lastActiveAt: Date.now() };
    tabsRef.current = [emptyTab];
    activeTabIDRef.current = emptyTab.id;
    setTabs([emptyTab]);
    setActiveTabID(emptyTab.id);
    setUnlockedFolderIDs(new Set());
    setSession(locked);
    setFolders([]);
    setNotes([]);
    setNote(null);
    setSelectedFolderID("all");
    setContextMenu(null);
    setDirty(false);
    setRememberError("");
    setSidebarOpen(false);
    setGraphOpen(false);
    setTimeTrackingOpen(false);
    setActiveTimeEntry(null);
    setTimerDialog(null);
    setTrackingConflicts([]);
    setVaultMenuOpen(false);
    setSaveState("idle");
    setGlobalSearchTarget(null);
    setSyncLinked(false);
    setLastSyncedAt(0);
  };

  const prepareVaultPrompt = async (action: VaultAction, path: string) => {
    setVaultPath(path);
    bringWindowToFront("vaultAction");
    setVaultAction(action);
    setVaultName("");
    setPassphrase("");
    setRememberSecret(false);
    setRememberError("");
    setVaultSecret("");
    setSecretCopied(false);
    setSecretConfirmed(false);
    setCloneRepository("");
    setCloneSSHKey("");
    setCloneBranch("main");
    setCloneRepositoryPrivate(false);
    if (action !== "create") return;
    try {
      setVaultSecret(await VaultService.GenerateVaultSecret());
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const chooseVault = async (action: VaultAction) => {
    setError("");
    let path = "";
    try {
      path =
        action === "open"
          ? await VaultService.SelectVaultFolder()
          : await VaultService.SelectVaultDestinationFolder();
    } catch {
      // Closing a native folder picker is not an application error.
      return;
    }
    if (!path) return;
    if (action === "open" && await openRememberedVault(path)) return;
    await prepareVaultPrompt(action, path);
  };

  const openRememberedVault = async (path: string) => {
    let opened: Session;
    try {
      opened = await VaultService.OpenVaultRemembered(path);
    } catch {
      return false;
    }
    unlockedRef.current = true;
    setSession(opened);
    setLastVaultPath(opened.path);
    setVaultAction(null);
    await syncVaultOnOpen();
    await refreshFolders();
    await refreshNotes();
    return true;
  };

  const openLastVault = async () => {
    setError("");
    if (await openRememberedVault(lastVaultPath)) return;
    await prepareVaultPrompt("open", lastVaultPath);
  };

  const openRecentVault = async (path: string) => {
    setVaultMenuOpen(false);
    if (path === session?.path) return;
    setError("");
    try {
      await persistCurrent();
      resetToLocked(await VaultService.LockVault());
      if (await openRememberedVault(path)) return;
      await prepareVaultPrompt("open", path);
    } catch {
      // persistCurrent already presents the actionable error.
    }
  };

  const removeRecentVault = async (path: string) => {
    setError("");
    try {
      await VaultService.RemoveRecentVaultPath(path);
      setRecentVaultPaths((current) => current.filter((existing) => existing !== path));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const copyVaultSecret = async () => {
    setError("");
    try {
      await VaultService.CopyVaultSecret(vaultSecret);
      setSecretCopied(true);
    } catch (reason) {
      setSecretCopied(false);
      setError(errorText(reason));
    }
  };

  const chooseCloneSSHKey = async () => {
    try {
      const path = await VaultService.SelectGitHubSSHKey();
      if (path) setCloneSSHKey(path);
    } catch {
      // Closing a native file picker is not an application error.
    }
  };

  const submitVault = async () => {
    if (!vaultAction) return;
    if ((vaultAction === "create" || vaultAction === "clone") && !vaultName.trim()) {
      setError("Enter a name for the local vault folder.");
      return;
    }
    if (vaultAction === "create" && (!vaultSecret || !secretCopied || !secretConfirmed)) {
      setError("Copy the vault secret and confirm that you saved it before creating the vault.");
      return;
    }
    if (
      vaultAction === "clone" &&
      (!cloneRepository.trim() ||
        !cloneSSHKey.trim() ||
        !cloneBranch.trim() ||
        !passphrase ||
        !cloneRepositoryPrivate)
    ) {
      setError("Complete the repository, SSH key, branch, vault secret, and private-repository confirmation.");
      return;
    }
    setBusy(true);
    setError("");
    console.info(`Vault ${vaultAction} triggered`);
    try {
      const completedAction = vaultAction;
      let opened: Session;
      let restoreWarning = "";
      if (completedAction === "create") {
        opened = await VaultService.CreateVault(vaultPath, vaultName, vaultSecret);
      } else if (completedAction === "clone") {
        const restored = await VaultService.CloneGitHubVault(
          vaultPath,
          vaultName,
          cloneRepository,
          cloneSSHKey,
          cloneBranch,
          passphrase,
          cloneRepositoryPrivate,
        );
        opened = restored.session;
        restoreWarning = restored.warning;
        setSyncLinked(restored.linked);
      } else {
        opened = await VaultService.OpenVault(vaultPath, passphrase);
      }
      unlockedRef.current = true;
      setSession(opened);
      setLastVaultPath(opened.path);
      if (rememberSecret) {
        try {
          await VaultService.RememberVaultSecret(completedAction === "create" ? vaultSecret : passphrase);
        } catch (reason) {
          setRememberError(
            "Your vault secret could not be saved to the system keychain. You will be asked for it again next time. (" + errorText(reason) + ")",
          );
        }
        setRememberSecret(false);
      }
      setVaultAction(null);
      setVaultName("");
      setPassphrase("");
      setVaultSecret("");
      setSecretCopied(false);
      setSecretConfirmed(false);
      setCloneRepository("");
      setCloneSSHKey("");
      setCloneBranch("main");
      setCloneRepositoryPrivate(false);
      await syncVaultOnOpen();
      await refreshFolders();
      if (completedAction === "create") {
        const first = await VaultService.CreateNote("Welcome");
        const welcomeContent = [
            "# Welcome to Cipherleaf",
            "",
            "Your notes, titles, properties, and attachments are encrypted before they touch the disk.",
            "",
            "> Start here",
            "  > [ ] Write naturally in **Live Preview** or switch to Markdown",
            "  > [ ] Create a note with **Ctrl + N**",
            "  > [ ] Connect notes with `[[wikilinks]]` and explore the link graph",
            "  > [ ] Open the quick switcher with **Ctrl/Cmd + K**",
            "",
            "## Explore",
            "",
            "* Open the calendar to create daily notes from a template",
            "* Use File to import or export Markdown and attach encrypted files",
            "* Use Recovery to restore deleted notes or earlier versions",
            "* Choose Nord Light, Nord Dark, or Archivist in Appearance",
            "* Link a private GitHub repository for encrypted multi-device sync",
            "",
            "## Keep your vault safe",
            "",
            "Save your vault secret somewhere secure—there is no password reset. Cipherleaf locks automatically after 15 minutes of inactivity.",
          ].join("\n");
        const saved = await VaultService.SaveNote(
          first.id,
          first.title,
          welcomeContent,
        );
        setNotes([saved.summary]);
        applyLoadedNote(saved.note);
      } else {
        await refreshNotes();
      }
      if (restoreWarning) setError(restoreWarning);
      console.info(`Vault ${completedAction} completed`);
    } catch (reason) {
      setError(errorText(reason));
      console.error(`Vault ${vaultAction} failed: ${errorText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncNotification("");
    try {
      await persistCurrent();
      await saveVaultSettings();
      console.info(">>>>> Cloud Sync Triggered");
      const syncStartedAt = performance.now();
      const result: SyncResult = await VaultService.SyncNow();
      if (session?.vaultId && await loadVaultSettings(session.vaultId)) {
        await VaultService.SyncNow();
      }
      const syncElapsed = performance.now() - syncStartedAt;
      syncTimingMessages(result.timings, syncElapsed, result.git).forEach((message) => console.info(message));
      await refreshNotes();
      await refreshFolders();
      const note = noteRef.current;
      if (note) {
        try {
          const fresh = await VaultService.GetNote(note.id);
          applyLoadedNote(fresh);
        } catch {
          // note may have been removed by the merge; leave as-is
        }
      }
      try {
        const settings = await VaultService.GetSyncSettings();
        setLastSyncedAt(settings.lastSyncedAt);
      } catch {
        // best-effort refresh of the timestamp
      }
      if (result.warning) {
        setError(result.warning);
      } else if (result.message) {
        setSaveState("saved");
        setSyncNotification(syncFinishedMessage(syncElapsed));
      }
      if (result.merge.conflicts?.length) {
        bringWindowToFront("syncConflicts");
        setSyncConflicts(result.merge.conflicts);
        void startConflictResolution(result.merge.conflicts[0]);
      }
      if (result.merge.trackingConflicts?.length) setTrackingConflicts(result.merge.trackingConflicts);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSyncing(false);
    }
  };

  autoSyncVaultRef.current = async () => {
    if (!syncLinked || syncing) return;
    await syncNow();
  };

  async function startConflictResolution(conflict: MergeConflict) {
    setError("");
    console.info("Sync conflict resolution opened");
    try {
      await persistCurrent();
      const localNote = await VaultService.GetNote(conflict.localNoteId);
      const localContent = conflict.localContent || markdownForEditing(localNote.content);
      const remoteContent = conflict.remoteContent || "";
      setConflictResolution({
        conflict,
        localNote,
        mergedContent: localContent,
        cloudHighlightLines: changedLineNumbers(localContent, remoteContent),
      });
      applyLoadedNote(null);
      setNoteTrail([]);
      setSidebarOpen(false);
    } catch (reason) {
      setError(errorText(reason));
      console.error(`Sync conflict resolution failed to open: ${errorText(reason)}`);
    }
  }

  const saveResolvedConflict = async () => {
    if (!conflictResolution) return;
    const confirmed = await requestAppConfirm({
      kind: "confirm",
      eyebrow: "Merge conflict",
      title: "Save final version?",
      message: "This saves the merged file as the final note version. The temporary local/cloud conflict copies will be discarded.",
      confirmLabel: "Save merged file",
      icon: "lock",
    });
    if (!confirmed) return;
    setSaveState("saving");
    console.info("Sync conflict resolution save triggered");
    try {
      const saved = await VaultService.SaveNote(
        conflictResolution.localNote.id,
        conflictResolution.localNote.title,
        conflictResolution.mergedContent,
      );
      setConflictResolution(null);
      setSyncConflicts((current) =>
        current.filter((item) => item.localNoteId !== conflictResolution.conflict.localNoteId),
      );
      updateSummary(saved.summary);
      applyLoadedNote(saved.note, "saved");
      if (syncLinked) {
        await syncNow();
      }
      console.info("Sync conflict resolution saved");
    } catch (reason) {
      setSaveState("error");
      setError(errorText(reason));
      console.error(`Sync conflict resolution save failed: ${errorText(reason)}`);
    }
  };

  const resolveTrackingConflict = async (conflict: TimeTrackingConflict, choice: "local" | "remote" | "delete-local" | "delete-remote" | "finish") => {
    setError("");
    try {
      if (choice === "remote" && conflict.remoteEntry?.endedAtUtc) {
        const entry = conflict.remoteEntry;
        await VaultService.UpdateTimeEntryForClient(entry.id, entry.name, entry.clientId ?? "", entry.projectId ?? "", entry.tagIds ?? [], entry.startedAtUtc, entry.endedAtUtc!);
      } else if (choice === "remote" && conflict.remoteProject) {
        await VaultService.UpdateProject(conflict.remoteProject.id, conflict.remoteProject.name, conflict.remoteProject.clientId ?? "");
      } else if (choice === "remote" && conflict.remoteClient) {
        await VaultService.RenameClient(conflict.remoteClient.id, conflict.remoteClient.name);
      } else if (choice === "remote" && conflict.remoteTag) {
        await VaultService.RenameTag(conflict.remoteTag.id, conflict.remoteTag.name);
      } else if (choice === "delete-local" && conflict.localEntry) {
        await VaultService.DeleteTimeEntry(conflict.localEntry.id);
      } else if (choice === "delete-remote" && conflict.remoteEntry) {
        await VaultService.DeleteTimeEntry(conflict.remoteEntry.id);
      } else if (choice === "finish") {
        const finished = await VaultService.FinishActiveTimeEntry(); setActiveTimeEntry(null);
        if (!finished.id) throw new Error("Active timer could not be finished");
      }
      await VaultService.ResolveTimeTrackingConflict(conflict.id);
      setTrackingConflicts((current) => current.filter((item) => item.id !== conflict.id));
    } catch (reason) { setError(errorText(reason)); }
  };

  const forcePushLocalVault = async () => {
    if (syncing || !syncConflicts.length) return;
    const confirmed = await requestAppConfirm({
      kind: "confirm",
      eyebrow: "Force push",
      title: "Overwrite remote vault?",
      message: "This replaces the cloud vault with your current local vault. Remote changes involved in the conflict will be lost.",
      confirmLabel: "Force push local vault",
      danger: true,
      icon: "lock",
    });
    if (!confirmed) return;
    setSyncing(true);
    setError("");
    console.warn("Git force-push triggered");
    try {
      await persistCurrent();
      await saveVaultSettings(true);
      const result = await VaultService.ForcePushNow();
      setSyncConflicts([]);
      const settings = await VaultService.GetSyncSettings();
      setLastSyncedAt(settings.lastSyncedAt);
      setSaveState("saved");
      setError(result.warning || result.message || "Local vault force-pushed to cloud.");
      console.info("Git force-push completed");
    } catch (reason) {
      setError(errorText(reason));
      console.error(`Git force-push failed: ${errorText(reason)}`);
    } finally {
      setSyncing(false);
    }
  };

  const saveAndSync = async () => {
    if (syncing) return;
    setError("");
    try {
      await persistCurrent();
    } catch {
      return;
    }
    if (!syncLinked) {
      setError("Link this vault to GitHub in Vault Settings before syncing.");
      return;
    }
    await syncNow();
  };


  const lockVault = async () => {
    setError("");
    console.info("Vault lock triggered");
    try {
      await persistCurrent();
      resetToLocked(await VaultService.LockVault());
      console.info("Vault lock completed");
    } catch {
      // persistCurrent already presents the actionable error.
    }
  };

  const switchVault = async (action: VaultAction) => {
    setTitlebarMenu(null);
    setError("");
    let path = "";
    try {
      path = await VaultService.SelectVaultFolder();
    } catch {
      // Keep the current vault open when the picker is cancelled.
      return;
    }
    if (!path) return;
    try {
      await persistCurrent();
      resetToLocked(await VaultService.LockVault());
      if (action === "open" && await openRememberedVault(path)) return;
      await prepareVaultPrompt(action, path);
    } catch {
      // persistCurrent already presents the actionable error.
    }
  };

  const closeCurrentVault = async () => {
    setTitlebarMenu(null);
    setError("");
    try {
      await persistCurrent();
      resetToLocked(await VaultService.CloseVault());
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const renameCurrentVault = async () => {
    setTitlebarMenu(null);
    if (!session || session.locked) return;
    const currentName = session.path.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const newName = await requestAppPrompt({
      kind: "prompt",
      eyebrow: "Vault",
      title: "Rename vault",
      label: "Vault folder name",
      submitLabel: "Rename vault",
      initialValue: currentName,
      icon: "file",
    });
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Enter a new name for the vault folder.");
      return;
    }
    if (trimmed === currentName) return;
    setError("");
    try {
      await persistCurrent();
      const renamed = await VaultService.RenameVault(trimmed);
      resetToLocked(renamed);
      setError(`Vault renamed to “${trimmed}”. Unlock it again to continue.`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const closeApplication = async () => {
    setTitlebarMenu(null);
    setError("");
    await quitApplication();
  };

  const createNote = async (title = "Untitled") => {
    setError("");
    try {
      await persistCurrent();
      const targetFolder = selectedFolderID === "all" ? "" : selectedFolderID;
      const created = await VaultService.CreateNoteInFolder(title, targetFolder);
      const result = (await VaultService.ListNotes()) ?? [];
      setNotes(result);
      applyLoadedNote(created);
      setSidebarOpen(false);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openDailyNote = async (date: Date) => {
    const title = formatDailyTitle(date, dailyNoteFormat);
    const existing = notes.find((item) => item.title === title && item.folderId === dailyNoteFolderID);
    setCalendarOpen(false);
    if (existing) {
      await selectNote(existing.id, { appendTrail: true });
      return;
    }
    setError("");
    try {
      await persistCurrent();
      const created = await VaultService.CreateNoteInFolder(title, dailyNoteFolderID);
      let content = `# ${title}\n`;
      if (dailyTemplateNoteID) {
        const template = await VaultService.GetNote(dailyTemplateNoteID);
        content = renderNoteTemplate(markdownForEditing(template.content), title, date);
      }
      const saved = await VaultService.SaveNote(created.id, created.title, content);
      updateSummary(saved.summary);
      applyLoadedNote(saved.note);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const createFolder = async (parentID = selectedFolderID === "all" ? "" : selectedFolderID) => {
    const parent = folderByID.get(parentID);
    const name = await requestAppPrompt({
      kind: "prompt",
      eyebrow: "Folder",
      title: parent ? `New folder in “${parent.name}”` : "New folder",
      label: "Folder name",
      submitLabel: "Create folder",
      icon: "folder",
    });
    const trimmed = name?.trim();
    if (!trimmed) return;
    setError("");
    try {
      const created = await VaultService.CreateFolder(trimmed, parentID);
      await refreshFolders();
      setSelectedFolderID(created.id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const renameFolder = async (folder: Folder) => {
    const name = await requestAppPrompt({
      kind: "prompt",
      eyebrow: "Folder",
      title: "Rename folder",
      label: "Folder name",
      submitLabel: "Rename folder",
      initialValue: folder.name,
      icon: "folder",
    });
    const trimmed = name?.trim();
    if (!trimmed || trimmed === folder.name) return;
    setError("");
    try {
      await VaultService.RenameFolder(folder.id, trimmed);
      await refreshFolders();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const deleteFolder = async (folder: Folder) => {
    if (
      !(await requestAppConfirm({
        kind: "confirm",
        eyebrow: "Delete folder",
        title: "Delete empty folder",
        message: `Delete the empty folder “${folder.name}”?`,
        confirmLabel: "Delete folder",
        danger: true,
        icon: "trash",
      }))
    ) {
      return;
    }
    setError("");
    try {
      await VaultService.DeleteFolder(folder.id);
      if (selectedFolderID === folder.id) setSelectedFolderID("all");
      await refreshFolders();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const setFolderHidden = async (folder: Folder, hidden: boolean) => {
    setError("");
    try {
      await VaultService.SetFolderHidden(folder.id, hidden);
      if (hidden && selectedFolderID === folder.id) setSelectedFolderID("all");
      await refreshFolders();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const requestFolderPassword = (title: string, submitLabel: string) => {
    bringWindowToFront("folderPassword");
    setFolderPassword("");
    setFolderPasswordVisible(false);
    setFolderPasswordPrompt({ title, submitLabel });
    return new Promise<string | null>((resolve) => {
      folderPasswordResolverRef.current = resolve;
    });
  };

  const closeFolderPasswordPrompt = (value: string | null) => {
    folderPasswordResolverRef.current?.(value);
    folderPasswordResolverRef.current = null;
    setFolderPasswordPrompt(null);
    setFolderPassword("");
    setFolderPasswordVisible(false);
  };

  useEffect(() => {
    const dialogs: { open: boolean; layer: WindowLayer; close: () => void }[] = [
      {
        open: Boolean(appDialog),
        layer: "appDialog",
        close: () => closeAppDialog(appDialog?.kind === "prompt" ? null : false),
      },
      {
        open: Boolean(folderPasswordPrompt),
        layer: "folderPassword",
        close: () => closeFolderPasswordPrompt(null),
      },
      { open: commandPaletteOpen, layer: "commandPalette", close: () => setCommandPaletteOpen(false) },
      { open: quickSwitcherOpen, layer: "quickSwitcher", close: () => setQuickSwitcherOpen(false) },
      { open: globalSearchOpen, layer: "globalSearch", close: () => setGlobalSearchOpen(false) },
      { open: calendarOpen, layer: "calendar", close: () => setCalendarOpen(false) },
      { open: syncConflicts.length > 0, layer: "syncConflicts", close: () => setSyncConflicts([]) },
      { open: recoveryOpen, layer: "recovery", close: () => setRecoveryOpen(false) },
      {
        open: vaultSettingsOpen,
        layer: "vaultSettings",
        close: () => {
          setVaultSettingsOpen(false);
          setConnectionResult(null);
        },
      },
      {
        open: appearanceSettingsOpen,
        layer: "appearanceSettings",
        close: () => setAppearanceSettingsOpen(false),
      },
      { open: statisticsOpen, layer: "statistics", close: () => setStatisticsOpen(false) },
    ];
    const current = dialogs
      .filter((dialog) => dialog.open)
      .sort((left, right) => (windowLayers[right.layer] ?? 0) - (windowLayers[left.layer] ?? 0))[0];
    if (!current) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      current.close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [
    appDialog,
    appearanceSettingsOpen,
    calendarOpen,
    commandPaletteOpen,
    folderPasswordPrompt,
    globalSearchOpen,
    quickSwitcherOpen,
    recoveryOpen,
    statisticsOpen,
    syncConflicts.length,
    vaultSettingsOpen,
    windowLayers,
  ]);

  const lockFolder = async (folder: Folder) => {
    const password = await requestFolderPassword(`Password for “${folder.name}”`, "Lock folder");
    if (password === null) return;
    setError("");
    try {
      await VaultService.LockFolder(folder.id, password);
      if (folderLineage(selectedFolderID, folderByID).some((item) => item.id === folder.id)) {
        setSelectedFolderID("all");
      }
      await refreshFolders();
      await refreshNotes();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const lockUnlockedFolder = async (folder: Folder) => {
    setError("");
    try {
      if (noteRef.current && folderLineage(noteRef.current.folderId, folderByID).some((item) => item.id === folder.id)) {
        await persistCurrent();
        applyLoadedNote(null);
        setNoteTrail([]);
      }
      if (folderLineage(selectedFolderID, folderByID).some((item) => item.id === folder.id)) {
        setSelectedFolderID("all");
      }
      await VaultService.LockFolderSession(folder.id);
      setUnlockedFolderIDs((current) => {
        return new Set(
          [...current].filter(
            (id) => !folderLineage(id, folderByID).some((item) => item.id === folder.id),
          ),
        );
      });
      await refreshNotes();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const removeFolderLock = async (folder: Folder) => {
    const password = await requestFolderPassword(`Remove lock from “${folder.name}”`, "Remove lock");
    if (password === null) return;
    setError("");
    try {
      await VaultService.UnlockFolder(folder.id, password);
      setUnlockedFolderIDs((current) => {
        const next = new Set(current);
        next.delete(folder.id);
        return next;
      });
      await refreshFolders();
      await refreshNotes();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const setFolderSortMode = async (folder: Folder, mode: string) => {
    setError("");
    try {
      await VaultService.SetFolderSortMode(folder.id, mode);
      await refreshFolders();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const unlockFolderLineage = async (folder: Folder) => {
    const unlocked = new Set(unlockedFolderIDs);
    for (const ancestor of folderLineage(folder.id, folderByID)) {
      if (!ancestor.locked || unlocked.has(ancestor.id)) continue;
      const password = await requestFolderPassword(`Unlock “${ancestor.name}”`, "Unlock folder");
      if (password === null) return false;
      try {
        await VaultService.CheckFolderPassword(ancestor.id, password);
      } catch (reason) {
        setError(errorText(reason));
        return false;
      }
      unlocked.add(ancestor.id);
      setUnlockedFolderIDs(new Set(unlocked));
    }
    await refreshNotes();
    return true;
  };

  const selectFolder = async (folder: Folder) => {
    if (!(await unlockFolderLineage(folder))) return;
    setTimeTrackingOpen(false);
    setSelectedFolderID(folder.id);
  };

  const selectNote = async (
    id: string,
    options: { appendTrail?: boolean; replaceTrail?: NoteCrumb[] } = {},
  ) => {
    setTimeTrackingOpen(false);
    if (note?.id === id) {
      setSidebarOpen(false);
      return;
    }
    const previous = noteRef.current;
    setError("");
    try {
      await persistCurrent();
      const summary = notes.find((item) => item.id === id);
      const lockedFolder = summary && folderByID.get(summary.folderId);
      if (lockedFolder && !(await unlockFolderLineage(lockedFolder))) return;
      const loaded = await VaultService.GetNote(id);
      applyLoadedNote(loaded);
      if (options.replaceTrail) {
        setNoteTrail(options.replaceTrail);
      } else if (options.appendTrail && previous) {
        setNoteTrail((current) => {
          const base = current.length
            ? current
            : [{ id: previous.id, title: previous.title || "Untitled" }];
          return [...base.filter((item) => item.id !== loaded.id), { id: loaded.id, title: loaded.title || "Untitled" }];
        });
      } else {
        setNoteTrail([]);
      }
      setSidebarOpen(false);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openNoteInNewTab = async (id: string) => {
    try {
      const saved = await persistCurrent();
      if (saved) tabNoteCacheRef.current.set(activeTabIDRef.current, saved);
      const tab = { id: nextTabIDRef.current++, noteID: id, title: notes.find((item) => item.id === id)?.title || "Untitled", lastActiveAt: Date.now() };
      setTabs((current) => [...current, tab]);
      setActiveTabID(tab.id);
      activeTabIDRef.current = tab.id;
      await selectNote(id);
    } catch {
      // persistCurrent and selectNote already present actionable errors.
    }
  };

  const openEmptyTab = async () => {
    try {
      await persistCurrent();
      const currentTab = tabsRef.current.find((tab) => tab.id === activeTabIDRef.current);
      if (currentTab && noteRef.current) {
        tabNoteCacheRef.current.set(currentTab.id, noteRef.current);
      }
      const tab = { id: nextTabIDRef.current++, noteID: "", title: "New tab", lastActiveAt: Date.now() };
      setTabs((current) => [...current.map((item) => item.id === activeTabIDRef.current ? { ...item, lastActiveAt: Date.now() } : item), tab]);
      setActiveTabID(tab.id);
      activeTabIDRef.current = tab.id;
      setGraphOpen(false);
      setTimeTrackingOpen(false);
      applyLoadedNote(null);
      setNoteTrail([]);
    } catch {
      // persistCurrent already presents the actionable error.
    }
  };

  const switchTab = async (tabID: number) => {
    if (tabID === activeTabIDRef.current) return;
    try {
      const saved = await persistCurrent();
      const previousID = activeTabIDRef.current;
      if (saved) tabNoteCacheRef.current.set(previousID, saved);
      const now = Date.now();
      const target = tabsRef.current.find((tab) => tab.id === tabID);
      if (!target) return;
      setTabs((current) => current.map((tab) => tab.id === previousID || tab.id === tabID ? { ...tab, lastActiveAt: now } : tab));
      setActiveTabID(tabID);
      activeTabIDRef.current = tabID;
      setGraphOpen(false);
      setTimeTrackingOpen(false);
      const cached = now - target.lastActiveAt < 60_000 ? tabNoteCacheRef.current.get(tabID) : undefined;
      if (cached) applyLoadedNote(cached);
      else if (target.noteID) applyLoadedNote(await VaultService.GetNote(target.noteID));
      else applyLoadedNote(null);
      setNoteTrail([]);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const closeTab = async (tabID: number) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === tabID);
    if (index < 0) return;
    if (tabID !== activeTabIDRef.current) {
      tabNoteCacheRef.current.delete(tabID);
      setTabs((tabs) => tabs.filter((tab) => tab.id !== tabID));
      return;
    }
    if (current.length === 1) {
      await openEmptyTab();
      tabNoteCacheRef.current.delete(tabID);
      setTabs((tabs) => tabs.filter((tab) => tab.id !== tabID));
      return;
    }
    const next = current[index + 1] ?? current[index - 1];
    await switchTab(next.id);
    tabNoteCacheRef.current.delete(tabID);
    setTabs((tabs) => tabs.filter((tab) => tab.id !== tabID));
  };

  useEffect(() => {
    const handleTabs = (event: KeyboardEvent) => {
      if (session?.locked || event.shiftKey || event.metaKey) return;
      if (event.altKey && /^\d$/.test(event.key)) {
        const index = event.key === "0" ? 9 : Number(event.key) - 1;
        const tab = tabsRef.current[index];
        if (!tab) return;
        event.preventDefault();
        void switchTab(tab.id);
      } else if (event.ctrlKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void openEmptyTab();
      } else if (event.ctrlKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        void closeTab(activeTabIDRef.current);
      }
    };
    window.addEventListener("keydown", handleTabs);
    return () => window.removeEventListener("keydown", handleTabs);
  }, [session?.locked]);

  const deleteNote = async (id = note?.id, title = note?.title) => {
    if (!id) return;
    if (
      !(await requestAppConfirm({
        kind: "confirm",
        eyebrow: "Delete note",
        title: "Delete note",
        message: `Move “${title || "Untitled"}” to Trash?`,
        confirmLabel: "Delete note",
        danger: true,
        icon: "trash",
      }))
    ) {
      return;
    }
    try {
      if (noteRef.current?.id !== id) await persistCurrent();
      await VaultService.DeleteNote(id);
      const deletedSelectedNote = noteRef.current?.id === id;
      if (deletedSelectedNote) {
        dirtyRef.current = false;
        setDirty(false);
      }
      const remaining = (await VaultService.ListNotes()) ?? [];
      setNotes(remaining);
      if (deletedSelectedNote) {
        const next =
          remaining.find(
            (item) =>
              selectedFolderID === "all" || item.folderId === selectedFolderID,
          ) ?? remaining[0];
        applyLoadedNote(next ? await VaultService.GetNote(next.id) : null);
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const moveNote = async (id: string, folderID: string) => {
    setError("");
    try {
      if (noteRef.current?.id === id) await persistCurrent();
      const moved = await VaultService.MoveNote(id, folderID);
      setNotes((await VaultService.ListNotes()) ?? []);
      if (noteRef.current?.id === id) {
        applyLoadedNote(moved, "saved");
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const moveFolder = async (id: string, parentID: string) => {
    setError("");
    try {
      await VaultService.MoveFolder(id, parentID);
      await refreshFolders();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const reorderNote = async (id: string, targetID: string, placeAfter = false) => {
    if (id === targetID) return;
    setError("");
    try {
      if (noteRef.current?.id === id) await persistCurrent();
      const target = notes.find((item) => item.id === targetID);
      const source = notes.find((item) => item.id === id);
      if (!target || !source) return;
      if (source.folderId !== target.folderId) {
        await VaultService.MoveNote(id, target.folderId);
      }
      const current = (await VaultService.ListNotes()) ?? [];
      const ordered = current
        .filter((item) => item.folderId === target.folderId && item.id !== id);
      const targetIndex = ordered.findIndex((item) => item.id === targetID);
      const insertAt = targetIndex < 0 ? ordered.length : targetIndex + (placeAfter ? 1 : 0);
      ordered.splice(insertAt, 0,
        current.find((item) => item.id === id)!);
      await VaultService.ReorderNotes(target.folderId, ordered.map((item) => item.id));
      setNotes((await VaultService.ListNotes()) ?? []);
      if (noteRef.current?.id === id) {
        applyLoadedNote(await VaultService.GetNote(id), "saved");
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setDropTarget(null);
    }
  };

  const reorderFolder = async (id: string, targetID: string, placeAfter = false) => {
    if (id === targetID) return;
    setError("");
    try {
      const ordered = folders.filter((item) => item.id !== id);
      const targetIndex = ordered.findIndex((item) => item.id === targetID);
      const source = folders.find((item) => item.id === id);
      if (!source || targetIndex < 0) return;
      ordered.splice(targetIndex + (placeAfter ? 1 : 0), 0, source);
      await VaultService.ReorderFolders(ordered.map((item) => item.id));
      await refreshFolders();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setDropTarget(null);
    }
  };

  const activatePointerDrag = (target: string) => {
    const candidate = dragCandidateRef.current;
    if (!candidate) return false;
    candidate.active = true;
    setDropTarget(target);
    return true;
  };

  const noteDropTargetFromPointer = (
    event: ReactMouseEvent<HTMLElement>,
    id: string,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    return {
      after,
      key: `note:${id}:${after ? "after" : "before"}`,
    };
  };

  const folderDropTargetFromPointer = (
    event: ReactMouseEvent<HTMLElement>,
    id: string,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    return {
      after,
      key: `folder:${id}:${after ? "after" : "before"}`,
    };
  };

  const finishPointerDrag = (
    target: { kind: "folder"; id: string; after?: boolean } | { kind: "note"; id: string; after: boolean },
  ) => {
    const candidate = dragCandidateRef.current;
    if (!candidate?.active) return;
    suppressClickRef.current = true;
    if (candidate.kind === "note" && target.kind === "folder") void moveNote(candidate.id, target.id);
    else if (candidate.kind === "note" && target.kind === "note") void reorderNote(candidate.id, target.id, target.after);
    else if (candidate.kind === "folder" && target.kind === "folder" && target.id) void reorderFolder(candidate.id, target.id, target.after ?? false);
    dragCandidateRef.current = null;
    setDropTarget(null);
  };

  useEffect(() => {
    const cancelDrag = () => {
      dragCandidateRef.current = null;
      setDropTarget(null);
    };
    window.addEventListener("mouseup", cancelDrag);
    return () => window.removeEventListener("mouseup", cancelDrag);
  }, []);

  const showContextMenu = (
    event: ReactMouseEvent,
    target: Omit<ContextMenuState, "x" | "y">,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      ...target,
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 330),
    } as ContextMenuState);
  };

  const markDirty = () => {
    editVersion.current++;
    setAutosaveVersion(editVersion.current);
    dirtyRef.current = true;
    setDirty((current) => current ? current : true);
    setSaveState((current) => current === "idle" ? current : "idle");
  };

  const editNote = (
    patch: Partial<Pick<Note, "title" | "content">>,
    syncState = "title" in patch,
  ) => {
    const current = noteRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    if ("content" in patch) setGlobalSearchTarget(null);
    noteRef.current = next;
    markDirty();
    if ("title" in patch) {
      setTabs((currentTabs) => currentTabs.map((tab) => tab.id === activeTabIDRef.current
        ? { ...tab, title: next.title || "Untitled" }
        : tab));
    }
    if (syncState) {
      setNote(next);
    }
  };

  const attachFile = async () => {
    const current = noteRef.current;
    if (!current) return;
    const path = await VaultService.SelectAttachmentFile();
    if (!path) return;
    setBusy(true);
    try {
      const attachment = await VaultService.ImportFileAttachment(current.id, path);
      const markdown = markdownForEditing(current.content);
      const separator = markdown.endsWith("\n") || markdown === "" ? "" : "\n";
      editNote({ content: `${markdown}${separator}[${attachment.filename}](attachment:${attachment.id})\n` });
      await persistCurrent();
      setFileAttachments((items) => [...items, attachment]);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportFileAttachment = async (attachment: AttachmentInfo) => {
    const current = noteRef.current;
    if (!current) return;
    const destination = await VaultService.SelectMarkdownFolder(`Select where to export ${attachment.filename}`);
    if (!destination) return;
    try {
      const path = await VaultService.ExportFileAttachment(current.id, attachment.id, destination);
      setSyncNotification(`Exported attachment to ${path}.`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const removeFileAttachment = async (attachment: AttachmentInfo) => {
    const current = noteRef.current;
    if (!current) return;
    const markdown = markdownForEditing(current.content);
    editNote({ content: removeAttachmentReferences(markdown, attachment.id) });
    try {
      await persistCurrent();
      setFileAttachments((items) => items.filter((item) => item.id !== attachment.id));
    } catch {
      // persistCurrent already presents the actionable error and preserves the draft.
    }
  };

  const syncDraftNote = () => {
    const draft = noteRef.current;
    if (draft) setNote(draft);
  };

  const setEditorView = (nextView: EditorView) => {
    syncDraftNote();
    saveCurrentDraft();
    setView(nextView);
  };

  const folderByID = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );

  const folderRows = useMemo(() => {
    const children = new Map<string, Folder[]>();
    for (const folder of folders) {
      const parentID = folder.parentId ?? "";
      children.set(parentID, [...(children.get(parentID) ?? []), folder]);
    }
    for (const items of children.values()) {
      items.sort((left, right) =>
        left.order === right.order
          ? left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
          : left.order - right.order,
      );
    }
    const rows: { folder: Folder; depth: number }[] = [];
    const addChildren = (parentID: string, depth: number) => {
      for (const folder of children.get(parentID) ?? []) {
        rows.push({ folder, depth });
        if (folder.locked && !unlockedFolderIDs.has(folder.id)) continue;
        addChildren(folder.id, depth + 1);
      }
    };
    addChildren("", 0);
    return rows;
  }, [folders, unlockedFolderIDs]);

  const publicNotes = useMemo(
    () => notes.filter((item) => {
      if (!item.folderId) return true;
      return !folderIsHidden(item.folderId, folderByID) &&
        !folderIsLocked(item.folderId, folderByID, unlockedFolderIDs);
    }),
    [folderByID, notes, unlockedFolderIDs],
  );

  const graphFolders = useMemo(
    () => graphOpen
      ? folders.filter((folder) =>
          !folderIsHidden(folder.id, folderByID) &&
          !folderIsLocked(folder.id, folderByID, unlockedFolderIDs),
        )
      : [],
    [folderByID, folders, graphOpen, unlockedFolderIDs],
  );

  const noteCountsByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of notes) {
      counts.set(item.folderId, (counts.get(item.folderId) ?? 0) + 1);
    }
    return counts;
  }, [notes]);

  const sortNotesForMode = useCallback((items: NoteSummary[], mode: string) => {
    const sorted = [...items];
    sorted.sort((left, right) => {
      if (mode === "title") return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
      if (mode === "updated") return right.updatedAt.localeCompare(left.updatedAt);
      if (mode === "created") return right.createdAt.localeCompare(left.createdAt);
      if (left.order !== right.order) return left.order - right.order;
      return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    });
    return sorted;
  }, []);

  const sortNotesForFolder = useCallback((items: NoteSummary[], folderID: string) => {
    const mode = folderID
      ? folderByID.get(folderID)?.sortMode || "manual"
      : unfiledSortMode;
    return sortNotesForMode(items, mode);
  }, [folderByID, sortNotesForMode, unfiledSortMode]);

  const currentSortMode = selectedFolderID === "all"
    ? globalSortMode
    : selectedFolderID === ""
      ? unfiledSortMode
      : folderByID.get(selectedFolderID)?.sortMode || "manual";

  const setCurrentSortMode = (mode: string) => {
    if (selectedFolderID === "all") {
      setGlobalSortMode(mode);
      return;
    }
    if (selectedFolderID === "") {
      setUnfiledSortMode(mode);
      return;
    }
    const folder = folderByID.get(selectedFolderID);
    if (folder) void setFolderSortMode(folder, mode);
  };

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    for (const item of publicNotes) {
      for (const tag of item.tags ?? []) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right));
  }, [publicNotes]);

  const visibleNotes = useMemo(() => {
    const tagged = selectedTag
      ? publicNotes.filter((item) => (item.tags ?? []).includes(selectedTag))
      : publicNotes;
    if (selectedFolderID === "all") return sortNotesForMode(tagged, globalSortMode);
    return sortNotesForFolder(
      notes.filter((item) => item.folderId === selectedFolderID),
      selectedFolderID,
    ).filter((item) => !selectedTag || (item.tags ?? []).includes(selectedTag));
  }, [globalSortMode, notes, publicNotes, selectedFolderID, selectedTag, sortNotesForFolder, sortNotesForMode]);

  const quickSwitcherNotes = useMemo(
    () => rankQuickSwitcher(publicNotes, quickSwitcherQuery),
    [publicNotes, quickSwitcherQuery],
  );

  const currentFolder = useMemo(
    () => folders.find((folder) => folder.id === note?.folderId),
    [folders, note?.folderId],
  );

  const noteMarkdown = useMemo(
    () => note ? markdownForEditing(note.content) : "",
    [note?.content],
  );

  const cardMetadata = useMemo(() => {
    const cards = new Map<string, CardMetadata>();
    for (const summary of notes) {
      const metadata = cardMetadataFromSummary(summary);
      if (metadata) cards.set(summary.id, metadata);
    }
    if (cardPanel) cards.set(cardPanel.note.id, cardPanel.metadata);
    return cards;
  }, [cardPanel, notes]);

  const cardTitles = useMemo(
    () => new Map([...cardMetadata].map(([id, metadata]) => [id, metadata.title])),
    [cardMetadata],
  );
  const cardTemplates = useMemo(
    () => notes.filter((summary) => summary.properties?.["cipherleaf-card-template"] === true || summary.properties?.["cipherleaf-card-template"] === "true"),
    [notes],
  );
  const cardSignature = useMemo(
    () => [...cardMetadata.values()].map((item) => `${item.id}:${item.title}:${item.status}:${item.columnEnteredAt ?? ""}`).join("|")
    , [cardMetadata],
  );

  const [portableNoteMarkdown, setPortableNoteMarkdown] = useState("");

  useEffect(() => {
    if (view !== "markdown") {
      setPortableNoteMarkdown("");
      return;
    }
    const timeout = window.setTimeout(
      () => setPortableNoteMarkdown(portableMarkdown(noteMarkdown)),
      100,
    );
    return () => window.clearTimeout(timeout);
  }, [noteMarkdown, view]);

  const markdownScrollSync = useMemo(() => {
    const scrollers = new Set<HTMLElement>();
    const synchronizedOffsets = new WeakMap<HTMLElement, number>();
    return {
      register(scroller: HTMLElement) {
        scrollers.add(scroller);
        return () => { scrollers.delete(scroller); };
      },
      sync(source: HTMLElement) {
        const synchronizedOffset = synchronizedOffsets.get(source);
        if (synchronizedOffset !== undefined) {
          synchronizedOffsets.delete(source);
          if (Math.abs(source.scrollTop - synchronizedOffset) < 1) return;
        }
        for (const target of scrollers) {
          if (target !== source) {
            const offset = Math.min(source.scrollTop, Math.max(0, target.scrollHeight - target.clientHeight));
            synchronizedOffsets.set(target, offset);
            target.scrollTop = offset;
          }
        }
      },
    };
  }, [note?.id]);

  const contentWordCount = useMemo(() => {
    const content = noteMarkdown.trim();
    return content ? content.split(/\s+/).length : 0;
  }, [noteMarkdown]);

  const calendarDays = useMemo(() => {
    const firstDay = calendarMonth.getDay();
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index - firstDay + 1);
      return { date, inMonth: date.getMonth() === calendarMonth.getMonth() };
    });
  }, [calendarMonth]);

  const calendarTitle = calendarMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const compactDay = String(today.getDate()).padStart(2, "0");
  const compactMonth = today.toLocaleDateString("en-US", { month: "short" }).toUpperCase();

  const openWikilinkTitle = async (title: string) => {
    try {
      const linked = await VaultService.ResolveNoteReference(title);
      await selectNote(linked.id, { appendTrail: true });
    } catch {
      setError(`No note named “${title}” exists yet.`);
    }
  };

  const openCard = async (id: string) => {
    try {
      const origin = noteRef.current;
      cardOriginRef.current = origin ? { noteID: origin.id, offset: noteCaretOffsetsRef.current.get(origin.id) ?? 0 } : null;
      const loaded = await VaultService.GetNote(id);
      const parsed = parseCardDocument(loaded.content, id, loaded.title);
      if (!parsed) throw new Error("This reference is not a card.");
      setSelectedTemplateID("");
      setCardPanel({ note: loaded, metadata: parsed.metadata, body: parsed.body });
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const closeCardPanel = () => {
    const origin = cardOriginRef.current;
    if (origin) {
      noteCaretOffsetsRef.current.set(origin.noteID, origin.offset);
      setCaretRestoreVersion((version) => version + 1);
    }
    cardOriginRef.current = null;
    setCardPanel(null);
  };

  useEffect(() => {
    if (!cardPanel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCardPanel();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [cardPanel]);

  const createCard = async () => {
    try {
      const created = await VaultService.CreateNote("Untitled");
      const metadata = newCardMetadata(created.id, new Date(created.createdAt));
      const saved = await VaultService.SaveNote(created.id, "Untitled", serializeCardDocument(metadata, ""));
      updateSummary(saved.summary);
      setSelectedTemplateID("");
      setCardPanel({ note: saved.note, metadata, body: "" });
      return cardReference(created.id);
    } catch (reason) {
      setError(errorText(reason));
      return null;
    }
  };

  const createBoard = async () => {
    if (!noteRef.current) return null;
    const id = typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `board-${Date.now().toString(36)}`;
    return `<!-- cipherleaf-board:${id}: -->`;
  };

  const addCardToBoard = async (boardID: string) => {
    const current = noteRef.current;
    if (!current) return;
    try {
      const reference = await createCard();
      const id = reference ? parseCardReference(reference) : null;
      if (!id) return;
      const loaded = await VaultService.GetNote(id);
      const parsed = parseCardDocument(loaded.content, id, loaded.title);
      if (!parsed || parsed.metadata.boardID) return;
      const metadata = { ...parsed.metadata, boardID };
      const saved = await VaultService.SaveNote(id, metadata.title, serializeCardDocument(metadata, parsed.body));
      updateSummary(saved.summary);
      setCardPanel({ note: saved.note, metadata, body: parsed.body });
      const marker = new RegExp(`(<!--\\s*cipherleaf-board:${boardID.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}:)([^>]*)(-->)`);
      const source = markdownForEditing(current.content);
      const content = source.replace(marker, (_match, prefix, ids, suffix) => {
        const cardIDs = ids.trim() ? ids.split(",").map((value: string) => value.trim()).filter(Boolean) : [];
        return `${prefix}${[...cardIDs, id].join(",")}${suffix}`;
      });
      if (content === source) {
        await VaultService.DeleteNote(id);
        return;
      }
      editNote({ content });
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const saveCardPanel = async () => {
    if (!cardPanel) return;
    setCardPanelSaving(true);
    try {
      const title = cardPanel.metadata.title.trim() || "Untitled";
      const metadata = { ...cardPanel.metadata, title, tags: normalizeCardTags(cardPanel.metadata.tags) };
      const saved = await VaultService.SaveNote(
        cardPanel.note.id,
        title,
        serializeCardDocument(metadata, cardPanel.body),
      );
      updateSummary(saved.summary);
      setCardPanel({ note: saved.note, metadata, body: cardPanel.body });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCardPanelSaving(false);
    }
  };

  const saveCardAsTemplate = async () => {
    if (!cardPanel) return;
    try {
      const template = await VaultService.CreateNote(`Template: ${cardPanel.metadata.title || "Untitled"}`);
      const saved = await VaultService.SaveNote(template.id, template.title, serializeTemplateDocument({
        id: template.id,
        name: cardPanel.metadata.title || "Untitled",
        status: cardPanel.metadata.status,
        tags: cardPanel.metadata.tags,
        body: cardPanel.body,
      }));
      updateSummary(saved.summary);
      setSelectedTemplateID(template.id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const applyCardTemplate = async (id: string) => {
    if (!cardPanel || !id) return;
    try {
      const template = await VaultService.GetNote(id);
      const parsed = parseTemplateDocument(template.content, id);
      if (!parsed) return;
      setCardPanel((current) => current ? {
        ...current,
        metadata: { ...current.metadata, status: parsed.template.status, tags: parsed.template.tags },
        body: parsed.template.body,
      } : current);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const deleteCardTemplate = async () => {
    if (!selectedTemplateID) return;
    try {
      await VaultService.DeleteNote(selectedTemplateID);
      setNotes((current) => current.filter((summary) => summary.id !== selectedTemplateID));
      setSelectedTemplateID("");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const moveCard = async (id: string, status: CardStatus) => {
    const summary = notes.find((item) => item.id === id);
    const current = cardMetadata.get(id);
    if (!summary || !current || current.status === status) return;
    try {
      const loaded = await VaultService.GetNote(id);
      const parsed = parseCardDocument(loaded.content, id, loaded.title);
      if (!parsed) return;
      const metadata = transitionCard(parsed.metadata, status);
      const saved = await VaultService.SaveNote(id, metadata.title, serializeCardDocument(metadata, parsed.body));
      updateSummary(saved.summary);
      if (cardPanel?.note.id === id) setCardPanel({ note: saved.note, metadata, body: parsed.body });
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openVaultSettings = async () => {
    setTitlebarMenu(null);
    bringWindowToFront("vaultSettings");
    setVaultSettingsOpen(true);
    setSyncSettings(null);
    setVaultStatistics(null);
    setSettingsBusy(true);
    setConnectionResult(null);
    setError("");
    try {
      const [settings, statistics, vaultSettings] = await Promise.all([
        VaultService.GetSyncSettings(),
        VaultService.GetVaultStatistics(),
        VaultService.GetVaultSettings(),
      ]);
      setSyncSettings(settings);
      setVaultStatistics(statistics);
      setSyncLinked(settings.linked);
      setLastSyncedAt(settings.lastSyncedAt);
      applyVaultSettings(vaultSettings);
    } catch (reason) {
      setVaultSettingsOpen(false);
      setError(errorText(reason));
    } finally {
      setSettingsBusy(false);
    }
  };

  const refreshRecovery = async () => {
    const [trash, versions] = await Promise.all([
      VaultService.ListTrash(),
      noteRef.current ? VaultService.ListNoteVersions(noteRef.current.id) : Promise.resolve([]),
    ]);
    setTrashItems(trash ?? []);
    setNoteVersions(versions ?? []);
  };

  const openRecovery = async () => {
    setTitlebarMenu(null);
    setRecoveryBusy(true);
    setError("");
    bringWindowToFront("recovery");
    setRecoveryOpen(true);
    try {
      await persistCurrent();
      await refreshRecovery();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRecoveryBusy(false);
    }
  };

  const restoreTrashItem = async (item: TrashItem) => {
    setRecoveryBusy(true);
    try {
      await VaultService.RestoreTrashItem(item.kind, item.id);
      await Promise.all([refreshFolders(), refreshNotes()]);
      await refreshRecovery();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRecoveryBusy(false);
    }
  };

  const permanentlyDeleteTrashItem = async (item: TrashItem) => {
    if (!(await requestAppConfirm({
      kind: "confirm",
      eyebrow: "Permanent deletion",
      title: `Delete ${item.kind} permanently?`,
      message: `“${item.title}” cannot be recovered after this action.`,
      confirmLabel: "Delete permanently",
      danger: true,
      icon: "trash",
    }))) return;
    setRecoveryBusy(true);
    try {
      await VaultService.PermanentlyDeleteTrashItem(item.kind, item.id);
      await refreshRecovery();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRecoveryBusy(false);
    }
  };

  const restoreNoteVersion = async (version: NoteVersion) => {
    const current = noteRef.current;
    if (!current) return;
    setRecoveryBusy(true);
    try {
      const restored = await VaultService.RestoreNoteVersion(current.id, version.revision);
      applyLoadedNote(restored);
      await refreshNotes();
      await refreshRecovery();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRecoveryBusy(false);
    }
  };

  const importMarkdown = async () => {
    const path = await VaultService.SelectMarkdownFolder("Select a folder containing Markdown files");
    if (!path) return;
    setBusy(true);
    setError("");
    try {
      await persistCurrent();
      const result = await VaultService.ImportMarkdown(path);
      await Promise.all([refreshFolders(), refreshNotes()]);
      setSyncNotification(`Imported ${result.notes} note${result.notes === 1 ? "" : "s"} from Markdown.`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportMarkdown = async () => {
    if (!(await requestAppConfirm({
      kind: "confirm",
      eyebrow: "Plaintext export",
      title: "Export decrypted Markdown?",
      message: "The exported notes and attachments will not be encrypted. Anyone with filesystem access can read them.",
      confirmLabel: "Export plaintext",
      danger: true,
      icon: "lock",
    }))) return;
    const path = await VaultService.SelectMarkdownFolder("Select where to create the Markdown export");
    if (!path) return;
    setBusy(true);
    setError("");
    try {
      await persistCurrent();
      const result = await VaultService.ExportMarkdown(path);
      setSyncNotification(`Exported ${result.notes} note${result.notes === 1 ? "" : "s"} to ${result.path}.`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const chooseEditorFont = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLocaleLowerCase().endsWith(".ttf")) {
      setError("Select a TrueType (.ttf) font file.");
      return;
    }
    try {
      const data = await file.arrayBuffer();
      await activateEditorFont(file.name, data);
      await writeStoredEditorFont({ name: file.name, data });
      setError("");
    } catch (reason) {
      setError(`Could not load font: ${errorText(reason)}`);
    }
  };

  const loadInstalledFonts = async () => {
    setInstalledFontsLoading(true);
    try {
      let families = await VaultService.ListInstalledFonts() ?? [];
      if (!families.length) {
        const queryLocalFonts = (window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
        if (!queryLocalFonts) throw new Error("Installed font selection is not supported on this platform. You can still select a .ttf file.");
        families = [...new Set((await queryLocalFonts()).map((font) => font.family))].sort((left, right) => left.localeCompare(right));
      }
      setInstalledFonts(families);
      window.setTimeout(() => setInstalledFonts([]), 10 * 60_000);
      setError("");
    } catch (reason) {
      setError(`Could not list installed fonts: ${errorText(reason)}`);
    } finally {
      setInstalledFontsLoading(false);
    }
  };

  const chooseInstalledFont = (family: string) => {
    if (!family) return;
    if (activeEditorFontRef.current) {
      document.fonts.delete(activeEditorFontRef.current);
      activeEditorFontRef.current = null;
    }
    document.documentElement.style.setProperty("--selected-editor-font", JSON.stringify(family));
    document.documentElement.dataset.editorFont = "custom";
    setEditorFontName(family);
    window.localStorage.setItem(EDITOR_SYSTEM_FONT_KEY, family);
  };

  const resetEditorFont = async () => {
    try {
      if (activeEditorFontRef.current) {
        document.fonts.delete(activeEditorFontRef.current);
        activeEditorFontRef.current = null;
      }
      delete document.documentElement.dataset.editorFont;
      document.documentElement.style.removeProperty("--selected-editor-font");
      setEditorFontName("");
      window.localStorage.removeItem(EDITOR_SYSTEM_FONT_KEY);
      await removeStoredEditorFont();
    } catch (reason) {
      setError(`Could not reset font: ${errorText(reason)}`);
    }
  };

  const chooseGitHubSSHKey = async () => {
    try {
      const path = await VaultService.SelectGitHubSSHKey();
      if (path) {
        setSyncSettings((current) =>
          current ? { ...current, privateKeyPath: path } : current,
        );
        setConnectionResult(null);
      }
    } catch {
      // Closing a native file picker is not an application error.
    }
  };

  const testGitHubConnection = async () => {
    if (!syncSettings) return;
    setSettingsBusy(true);
    setConnectionResult(null);
    console.info("GitHub connection test triggered");
    try {
      const result = await VaultService.TestGitHubConnection(syncSettings);
      setConnectionResult(result);
      console.info(`GitHub connection test completed: ${result.success ? "success" : "failed"}`);
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings.branch,
      });
      console.error(`GitHub connection test failed: ${errorText(reason)}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const linkGitHubVault = async () => {
    if (!syncSettings) return;
    setSettingsBusy(true);
    setConnectionResult(null);
    console.info("GitHub link triggered");
    try {
      await persistCurrent();
      await saveVaultSettings(true);
      const linked = await VaultService.LinkGitHubVault(syncSettings);
      const saved = await VaultService.GetSyncSettings();
      setSyncSettings(saved);
      setSyncLinked(linked.linked);
      setLastSyncedAt(saved.lastSyncedAt);
      setConnectionResult({
        success: true,
        message: linked.message,
        warning: linked.warning,
        branch: linked.branch,
      });
      console.info("GitHub link completed");
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings.branch,
      });
      console.error(`GitHub link failed: ${errorText(reason)}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const pullAndLinkGitHubVault = async () => {
    if (!syncSettings) return;
    const confirmed = await requestAppConfirm({
      kind: "confirm",
      eyebrow: "GitHub sync",
      title: "Pull remote before linking?",
      message: "This downloads the encrypted GitHub snapshot and merges it into this local vault. If a note conflicts, you will resolve it before anything is pushed.",
      confirmLabel: "Pull and link",
      icon: "lock",
    });
    if (!confirmed) return;
    setSettingsBusy(true);
    setConnectionResult(null);
    console.info("GitHub pull-and-link triggered");
    try {
      await persistCurrent();
      const result: SyncResult = await VaultService.PullAndLinkGitHubVault(syncSettings);
      if (session?.vaultId && await loadVaultSettings(session.vaultId)) {
        await VaultService.SyncNow();
      }
      const saved = await VaultService.GetSyncSettings();
      setSyncSettings(saved);
      setSyncLinked(saved.linked);
      setLastSyncedAt(saved.lastSyncedAt);
      await refreshFolders();
      await refreshNotes();
      const current = noteRef.current;
      if (current) {
        try {
          applyLoadedNote(await VaultService.GetNote(current.id));
        } catch {
          applyLoadedNote(null);
        }
      }
      setConnectionResult({
        success: true,
        message: result.message || "Remote changes were pulled and this vault is linked.",
        warning: result.warning,
        branch: result.branch || saved.branch,
      });
      if (result.merge.conflicts?.length) {
        bringWindowToFront("syncConflicts");
        setSyncConflicts(result.merge.conflicts);
        void startConflictResolution(result.merge.conflicts[0]);
      }
      console.info(`GitHub pull-and-link completed with ${result.merge.conflicts?.length ?? 0} conflict(s)`);
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings.branch,
      });
      console.error(`GitHub pull-and-link failed: ${errorText(reason)}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const unlinkGitHubSync = async () => {
    if (
      !(await requestAppConfirm({
        kind: "confirm",
        eyebrow: "GitHub sync",
        title: "Unlink GitHub sync",
        message: "Remove this vault’s GitHub settings from this device? The local vault, SSH key, and repository will not be deleted.",
        confirmLabel: "Unlink sync",
        danger: true,
        icon: "trash",
      }))
    ) {
      return;
    }
    setSettingsBusy(true);
    console.info("GitHub unlink triggered");
    try {
      await VaultService.UnlinkGitHubSync();
      const settings = await VaultService.GetSyncSettings();
      setSyncSettings(settings);
      setSyncLinked(false);
      setLastSyncedAt(0);
      setConnectionResult({
        success: true,
        message: "GitHub sync settings were removed from this device.",
        warning: "",
        branch: "main",
      });
      console.info("GitHub unlink completed");
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings?.branch ?? "main",
      });
      console.error(`GitHub unlink failed: ${errorText(reason)}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const openGitTerminal = async () => {
    setSettingsBusy(true);
    setConnectionResult(null);
    try {
      await VaultService.OpenGitTerminal();
      setConnectionResult({
        success: true,
        message: "Opened a terminal in this vault's encrypted Git checkout.",
        warning: "Manual Git changes can affect the next Cipherleaf sync.",
        branch: syncSettings?.branch ?? "main",
      });
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings?.branch ?? "main",
      });
    } finally {
      setSettingsBusy(false);
    }
  };

  const forgetRememberedSecret = async () => {
    setSettingsBusy(true);
    try {
      await VaultService.ForgetVaultSecret();
      setConnectionResult({
        success: true,
        message: "The remembered vault secret was removed from this device.",
        warning: "",
        branch: syncSettings?.branch ?? "main",
      });
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings?.branch ?? "main",
      });
    } finally {
      setSettingsBusy(false);
    }
  };

  const commandPaletteCommands: CommandPaletteCommand[] = [
    {
      id: "new-note",
      shortcut: "Ctrl + N",
      name: "New note",
      description: "Create a new encrypted note",
      run: () => void createNote(),
    },
    {
      id: "save-note",
      shortcut: "Ctrl + S",
      name: "Save note",
      description: "Save the current note",
      run: () => persistCurrentInBackground(),
    },
    {
      id: "quick-switcher",
      shortcut: "Ctrl + K",
      name: "Quick note switcher",
      description: "Open a note by title",
      run: () => {
        bringWindowToFront("quickSwitcher");
        setQuickSwitcherQuery("");
        setQuickSwitcherOpen(true);
      },
    },
    {
      id: "toggle-sidebar",
      shortcut: "Ctrl + B",
      name: "Toggle sidebar",
      description: "Expand or collapse the sidebar",
      run: () => setSidebarCollapsed((current) => !current),
    },
    {
      id: "find-notes",
      shortcut: "Ctrl + Shift + F",
      name: "Find in all notes",
      description: "Search text across your vault",
      run: () => {
        bringWindowToFront("globalSearch");
        setGlobalSearchReplace(false);
        setGlobalSearchOpen(true);
      },
    },
    {
      id: "start-timer",
      shortcut: "Ctrl + Shift + T",
      name: "Start timer",
      description: "Start tracking time without leaving this note",
      run: openStartTimerDialog,
    },
    {
      id: "finish-timer",
      shortcut: "Ctrl + Shift + E",
      name: "Finish timer",
      description: "Finish the active timer",
      run: () => {
        setTimerError("");
        setTimerDialog("finish");
      },
    },
    {
      id: "time-tracking",
      shortcut: "",
      name: "Time tracking",
      description: "Open tracked entries, clients, projects, and tags",
      run: () => {
        saveCurrentDraft();
        setGraphOpen(false);
        setTimeTrackingOpen(true);
        setSidebarOpen(false);
      },
    },
    {
      id: "graph-view",
      shortcut: "",
      name: "Graph view",
      description: "Explore links between notes",
      run: () => {
        saveCurrentDraft();
        setGraphOpen(true);
        setTimeTrackingOpen(false);
        setSidebarOpen(false);
      },
    },
    {
      id: "calendar",
      shortcut: "",
      name: "Calendar",
      description: "Open daily notes and calendar settings",
      run: () => {
        setCalendarMonth(startOfMonth(calendarSelected));
        bringWindowToFront("calendar");
        setCalendarOpen(true);
      },
    },
    {
      id: "sync-vault",
      shortcut: "Ctrl + Shift + R",
      name: "Sync vault",
      description: "Pull and push encrypted changes",
      run: () => void syncNow(),
    },
    {
      id: "vault-settings",
      shortcut: "",
      name: "Vault settings",
      description: "Manage sync and view vault statistics",
      run: () => void openVaultSettings(),
    },
    {
      id: "recovery",
      shortcut: "",
      name: "Trash and version history",
      description: "Restore deleted notes and earlier versions",
      run: () => void openRecovery(),
    },
    {
      id: "settings",
      shortcut: "",
      name: "Settings",
      description: "Change application appearance and preferences",
      run: () => {
        bringWindowToFront("appearanceSettings");
        setAppearanceSettingsOpen(true);
      },
    },
  ];
  const commandPaletteNeedle = commandPaletteQuery.trim().toLocaleLowerCase();
  const matchingCommandPaletteCommands = commandPaletteCommands.filter((command) =>
    !commandPaletteNeedle || [command.shortcut, command.name, command.description]
      .some((value) => value.toLocaleLowerCase().includes(commandPaletteNeedle)),
  );
  const selectedCommandPaletteCommand = matchingCommandPaletteCommands[
    Math.min(commandPaletteIndex, Math.max(0, matchingCommandPaletteCommands.length - 1))
  ];
  const commandPaletteSelectedIndex = Math.min(
    commandPaletteIndex,
    Math.max(0, matchingCommandPaletteCommands.length - 1),
  );
  const closeCommandPalette = () => setCommandPaletteOpen(false);
  const runCommandPaletteCommand = (command: CommandPaletteCommand) => {
    closeCommandPalette();
    command.run();
  };

  if (session === null) {
    return (
      <main className="loading-screen">
        <div className="brand-glyph"><img src={logo} alt="" /></div>
        <p>Preparing your vault…</p>
      </main>
    );
  }

  if (session.locked) {
    return (
      <main className="welcome-screen">
        <section className="welcome-card">
          <div className="brand-row">
            <div className="brand-glyph"><img src={logo} alt="" /></div>
            <span>Cipherleaf</span>
          </div>
          <p className="eyebrow">Local-first · end-to-end encrypted</p>
          <h1>Your thoughts,<br /><em>kept yours.</em></h1>
          <p className="welcome-copy">
            A quiet Markdown workspace where every title, note, and link is encrypted
            locally before it reaches disk.
          </p>
          <div className="welcome-actions">
            {lastVaultPath && (
              <button className="primary-button" onClick={() => void openLastVault()}>
                Open Last Vault
              </button>
            )}
            <button className="primary-button" onClick={() => void chooseVault("create")}>
              Create a new vault
            </button>
            <button className="secondary-button" onClick={() => void chooseVault("open")}>
              Open an existing vault
            </button>
            <button className="secondary-button" onClick={() => void chooseVault("clone")}>
              Clone from GitHub
            </button>
          </div>
          <div className="security-note">
            <Icon name="lock" size={15} />
            XChaCha20-Poly1305 · Your key never leaves this device
          </div>
        </section>

        <aside className="welcome-art" aria-hidden="true">
          <div className="paper paper-back" />
          <div className="paper paper-front">
            <span>04 · JUL</span>
            <div className="paper-line long" />
            <div className="paper-line medium" />
            <div className="paper-line short" />
            <blockquote>Ideas need<br />a private place<br />to become.</blockquote>
            <div className="paper-sprig">⌁</div>
          </div>
        </aside>

        {vaultAction && (
          <div className="modal-backdrop vault-action-backdrop" role="presentation" style={{ zIndex: windowLayers.vaultAction }}>
            <form
              className={`vault-modal ${vaultAction === "clone" ? "clone-vault-modal" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                void submitVault();
              }}
            >
              <button
                type="button"
                className="icon-button modal-close"
                aria-label="Close"
                onClick={() => {
                  setVaultAction(null);
                  setVaultName("");
                  setPassphrase("");
                  setVaultSecret("");
                  setSecretCopied(false);
                  setSecretConfirmed(false);
                  setCloneRepository("");
                  setCloneSSHKey("");
                  setCloneBranch("main");
                  setCloneRepositoryPrivate(false);
                  setError("");
                }}
              >
                <Icon name="x" />
              </button>
              <div className="modal-icon"><Icon name="lock" size={21} /></div>
              <p className="eyebrow">
                {vaultAction === "create"
                  ? "New encrypted vault"
                  : vaultAction === "clone"
                    ? "Restore encrypted vault"
                    : "Unlock vault"}
              </p>
              <h2>
                {vaultAction === "create"
                  ? "Create a vault"
                  : vaultAction === "clone"
                    ? "Clone from GitHub"
                    : folderName(vaultPath)}
              </h2>
              <p className="path-label" title={vaultPath}>{vaultPath}</p>
              {vaultAction === "create" ? (
                <>
                  <label>
                    Vault name
                    <input
                      autoFocus
                      value={vaultName}
                      onChange={(event) => setVaultName(event.target.value)}
                      placeholder="Personal notes"
                      autoComplete="off"
                    />
                  </label>
                  <div className="secret-heading">
                    <span>256-bit vault secret</span>
                    <span>Shown once</span>
                  </div>
                  <div className="secret-box">
                    <code>{vaultSecret}</code>
                    <button
                      type="button"
                      className={`copy-secret-button ${secretCopied ? "copied" : ""}`}
                      onClick={() => void copyVaultSecret()}
                    >
                      <Icon name="copy" size={15} />
                      {secretCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="secret-help">
                    This secret unlocks your vault. Store it in a password manager before continuing.
                    Anyone with it can decrypt a copy of the vault.
                  </p>
                  <label className="secret-confirmation">
                    <input
                      type="checkbox"
                      checked={secretConfirmed}
                      onChange={(event) => setSecretConfirmed(event.target.checked)}
                    />
                    <span>I saved this secret somewhere safe.</span>
                  </label>
                </>
              ) : vaultAction === "clone" ? (
                <>
                  <label>
                    Local vault folder name
                    <input
                      autoFocus
                      value={vaultName}
                      onChange={(event) => setVaultName(event.target.value)}
                      placeholder="Personal notes"
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    GitHub repository
                    <input
                      value={cloneRepository}
                      onChange={(event) => setCloneRepository(event.target.value)}
                      placeholder="git@github.com:OWNER/REPOSITORY.git"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    GitHub SSH private key
                    <div className="settings-path-field">
                      <input
                        value={cloneSSHKey}
                        onChange={(event) => setCloneSSHKey(event.target.value)}
                        placeholder="/home/user/.ssh/cipherleaf_vault"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void chooseCloneSSHKey()}
                      >
                        Browse…
                      </button>
                    </div>
                  </label>
                  <div className="clone-vault-grid">
                    <label>
                      Branch
                      <input
                        value={cloneBranch}
                        onChange={(event) => setCloneBranch(event.target.value)}
                        placeholder="main"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      Vault secret
                      <input
                        type="password"
                        value={passphrase}
                        onChange={(event) => setPassphrase(event.target.value)}
                        placeholder="Paste your vault secret"
                        autoComplete="current-password"
                      />
                    </label>
                  </div>
                  <label className="secret-confirmation">
                    <input
                      type="checkbox"
                      checked={cloneRepositoryPrivate}
                      onChange={(event) => setCloneRepositoryPrivate(event.target.checked)}
                    />
                    <span>I confirm this GitHub repository is private.</span>
                  </label>
                  <p className="secret-help">
                    The SSH key downloads encrypted files. The separate vault secret
                    authenticates and decrypts them locally.
                  </p>
                </>
              ) : (
                <label>
                  Vault secret
                  <input
                    autoFocus
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder="Paste your vault secret"
                    autoComplete="current-password"
                  />
                </label>
              )}
              {vaultAction && (
                <label className="remember-secret-row">
                  <input
                    type="checkbox"
                    checked={rememberSecret}
                    onChange={(event) => setRememberSecret(event.target.checked)}
                  />
                  <span>Don't ask again for 7 days</span>
                </label>
              )}
              {rememberError && (
                <p className="form-error" role="alert">
                  {rememberError}
                </p>
              )}
              {error && <p className="form-error" role="alert">{error}</p>}
              <button
                className="primary-button"
                disabled={
                  busy ||
                  (vaultAction === "create"
                    ? !vaultName.trim() || !vaultSecret || !secretCopied || !secretConfirmed
                    : vaultAction === "clone"
                      ? !vaultName.trim() ||
                        !cloneRepository.trim() ||
                        !cloneSSHKey.trim() ||
                        !cloneBranch.trim() ||
                        !passphrase ||
                        !cloneRepositoryPrivate
                      : !passphrase)
                }
              >
                {busy
                  ? vaultAction === "clone" ? "Downloading and restoring…" : "Working…"
                  : vaultAction === "create"
                    ? "Create encrypted vault"
                    : vaultAction === "clone"
                      ? "Clone and open vault"
                      : "Unlock vault"}
              </button>
              {vaultAction === "create" && (
                <p className="recovery-warning">
                  There is no reset or recovery service. The clipboard may also be readable by other applications.
                </p>
              )}
            </form>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className={`workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${logOpen ? "log-open" : ""}`}>
      <header className="app-menubar">
        <button
          type="button"
          className="sidebar-collapse-toggle"
          onClick={() => setSidebarCollapsed((current) => !current)}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
        >
          {sidebarCollapsed ? ">>>" : "<<<"}
        </button>
        <div className="app-menubar-mark" title="Cipherleaf" aria-label="Cipherleaf">
          <Icon name="book" size={17} />
        </div>
        <nav
          className="titlebar-menus"
          aria-label="Application menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="titlebar-menu">
            <button
              className={titlebarMenu === "file" ? "active" : ""}
              aria-haspopup="menu"
              aria-expanded={titlebarMenu === "file"}
              onClick={() => {
                setTitlebarMenu((current) => current === "file" ? null : "file")
              }}
            >
              File
            </button>
            {titlebarMenu === "file" && (
              <div className="titlebar-menu-popover" role="menu">
                <button role="menuitem" onClick={() => {
                  setTitlebarMenu(null);
                  void createNote();
                }}>
                  New file <kbd>Ctrl + N</kbd>
                </button>
                <button role="menuitem" disabled={!note || !dirty} onClick={() => {
                  setTitlebarMenu(null);
                  persistCurrentInBackground();
                }}>
                  Save file <kbd>Ctrl + S</kbd>
                </button>
                <button role="menuitem" disabled={!note || busy} onClick={() => {
                  setTitlebarMenu(null);
                  void attachFile();
                }}>
                  Attach encrypted file…
                </button>
                <button role="menuitem" disabled={!note || saveState === "saving" || syncing || !syncLinked} onClick={() => {
                  setTitlebarMenu(null);
                  void saveAndSync();
                }}>
                  Save file and sync <kbd>Ctrl + Shift + S</kbd>
                </button>
                <div className="titlebar-menu-separator" />
                <button role="menuitem" disabled={busy} onClick={() => {
                  setTitlebarMenu(null);
                  void importMarkdown();
                }}>
                  Import Markdown folder…
                </button>
                <button role="menuitem" disabled={busy} onClick={() => {
                  setTitlebarMenu(null);
                  void exportMarkdown();
                }}>
                  Export plaintext Markdown…
                </button>
                <div className="titlebar-menu-separator" />
                <button role="menuitem" onClick={() => void closeApplication()}>
                  Close application
                </button>
              </div>
            )}
          </div>
          <div className="titlebar-menu">
            <button
              className={titlebarMenu === "vault" ? "active" : ""}
              aria-haspopup="menu"
              aria-expanded={titlebarMenu === "vault"}
              onClick={() => {
                setTitlebarMenu((current) => current === "vault" ? null : "vault")
              }}
            >
              Vault
            </button>
            {titlebarMenu === "vault" && (
              <div className="titlebar-menu-popover" role="menu">
                <button role="menuitem" disabled={!syncLinked || syncing} title={!syncLinked ? "Link this vault in Vault Settings first" : syncing ? "Syncing…" : "Pull then push the vault to GitHub"} onClick={() => {
                  setTitlebarMenu(null);
                  void syncNow();
                }}>
                  Sync vault <kbd>Ctrl + Shift + R</kbd>
                </button>
                <button role="menuitem" onClick={() => void openVaultSettings()}>
                  Vault Settings…
                </button>
                <button role="menuitem" onClick={() => void openRecovery()}>
                  Trash and version history…
                </button>
                <div className="titlebar-menu-separator" />
                <button role="menuitem" onClick={() => void switchVault("create")}>
                  New vault
                </button>
                <button role="menuitem" onClick={() => void switchVault("open")}>
                  Change vault
                </button>
                <button
                  role="menuitem"
                  disabled={!session || session.locked}
                  onClick={() => void renameCurrentVault()}
                >
                  Rename vault…
                </button>
                <button role="menuitem" onClick={() => void closeCurrentVault()}>
                  Close vault
                </button>
              </div>
            )}
          </div>
          <div className="titlebar-menu">
            <button
              className={titlebarMenu === "settings" ? "active" : ""}
              aria-haspopup="menu"
              aria-expanded={titlebarMenu === "settings"}
              onClick={() => {
                setTitlebarMenu((current) => current === "settings" ? null : "settings")
              }}
            >
              Settings
            </button>
            {titlebarMenu === "settings" && (
              <div className="titlebar-menu-popover" role="menu">
                <button role="menuitem" onClick={() => {
                  setTitlebarMenu(null);
                  bringWindowToFront("appearanceSettings");
                  setAppearanceSettingsOpen(true);
                }}>
                  Settings…
                </button>
                <button role="menuitem" onClick={() => {
                  setTitlebarMenu(null);
                  setLogOpen(true);
                }}>
                  Log
                </button>
                <button role="menuitem" onClick={() => {
                  setTitlebarMenu(null);
                  bringWindowToFront("statistics");
                  setStatisticsOpen(true);
                }}>
                  Application statistics…
                </button>
              </div>
            )}
          </div>
        </nav>
        <div className="app-menubar-title" title={session.path}>
          {folderName(session.path)}
        </div>
      </header>
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-glyph small"><img src={logo} alt="" /></div>
          <div>
            <strong>Cipherleaf</strong>
            <span>{folderName(session.path)}</span>
          </div>
          <button
            type="button"
            className="calendar-button"
            aria-label={`Open calendar for ${today.toLocaleDateString("en-US", { dateStyle: "full" })}`}
            title="Open calendar"
            onClick={() => {
              setCalendarMonth(startOfMonth(calendarSelected));
              bringWindowToFront("calendar");
              setCalendarOpen(true);
            }}
          >
            <span>{compactDay}</span>
            <small>{compactMonth}</small>
          </button>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">
            <Icon name="x" />
          </button>
        </div>
        <div className="sidebar-view-buttons">
          <button
            type="button"
            className={`graph-view-button ${graphOpen ? "active" : ""}`}
            onClick={() => {
              saveCurrentDraft();
              setGraphOpen(true);
              setTimeTrackingOpen(false);
              setSidebarOpen(false);
            }}
          >
            <Icon name="graph" size={16} />
            <span>Graph view</span>
          </button>
          <button
            type="button"
            className={`graph-view-button time-tracking-view-button ${timeTrackingOpen ? "active" : ""}`}
            onClick={() => {
              saveCurrentDraft();
              setGraphOpen(false);
              setTimeTrackingOpen(true);
              setSidebarOpen(false);
            }}
          >
            <Icon name="clock" size={16} />
            <span>Time tracking</span>
          </button>
        </div>
        <div className="notes-heading folders-heading">
          <span>Folders</span>
          <button className="icon-button" onClick={() => void createFolder()} aria-label="Create folder" title="New folder">
            <Icon name="plus" size={17} />
          </button>
        </div>
        <nav className="folder-list" aria-label="Folders">
          <button
            className={`folder-list-item ${selectedFolderID === "all" ? "active" : ""}`}
            onClick={() => {
              setGraphOpen(false);
              setTimeTrackingOpen(false);
              setSelectedFolderID("all");
            }}
          >
            <Icon name="book" size={15} />
            <span>All notes</span>
            <small>{publicNotes.length}</small>
          </button>
          <button
            className={`folder-list-item ${selectedFolderID === "" ? "active" : ""} ${dropTarget === "folder:" ? "drag-over" : ""}`}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              setGraphOpen(false);
              setTimeTrackingOpen(false);
              setSelectedFolderID("");
            }}
            onMouseEnter={(event) => {
              if (event.buttons === 1 && dragCandidateRef.current?.kind === "note") activatePointerDrag("folder:");
            }}
            onMouseUp={() => finishPointerDrag({ kind: "folder", id: "" })}
          >
            <Icon name="folder" size={15} />
            <span>Unfiled</span>
            <small>{noteCountsByFolder.get("") ?? 0}</small>
          </button>
          {folderRows.map(({ folder, depth }) => (
            <button
              key={folder.id}
              className={`folder-list-item ${selectedFolderID === folder.id ? "active" : ""} ${dropTarget === `folder:${folder.id}` ? "drag-over" : ""} ${dropTarget === `folder:${folder.id}:before` ? "drag-over-before" : ""} ${dropTarget === `folder:${folder.id}:after` ? "drag-over-after" : ""}`}
              style={{ paddingLeft: `${10 + depth * 14}px` }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
              }
              setGraphOpen(false);
              void selectFolder(folder);
              }}
              onMouseDown={(event) => {
                if (event.button === 0) {
                  dragCandidateRef.current = { kind: "folder", id: folder.id, active: false };
                }
              }}
              onContextMenu={(event) =>
                showContextMenu(event, {
                  kind: "folder",
                  id: folder.id,
                  label: folder.name,
                })
              }
              onMouseEnter={(event) => {
                if (event.buttons !== 1 || !dragCandidateRef.current) return;
                if (dragCandidateRef.current.kind === "note") activatePointerDrag(`folder:${folder.id}`);
                else if (dragCandidateRef.current.id !== folder.id) activatePointerDrag(folderDropTargetFromPointer(event, folder.id).key);
              }}
              onMouseMove={(event) => {
                if (event.buttons !== 1 || dragCandidateRef.current?.kind !== "folder" || !dragCandidateRef.current.active) return;
                if (dragCandidateRef.current.id === folder.id) return;
                setDropTarget(folderDropTargetFromPointer(event, folder.id).key);
              }}
              onMouseUp={(event) => {
                const target = folderDropTargetFromPointer(event, folder.id);
                finishPointerDrag({ kind: "folder", id: folder.id, after: target.after });
              }}
            >
              <Icon name={folderIsLocked(folder.id, folderByID, unlockedFolderIDs) ? "lock" : "folder"} size={15} />
              <span>{folder.name}</span>
              <small>{folderIsLocked(folder.id, folderByID, unlockedFolderIDs) ? "Locked" : (noteCountsByFolder.get(folder.id) ?? 0)}</small>
            </button>
          ))}
        </nav>
        {availableTags.length > 0 && (
          <>
            <div className="notes-heading tags-heading">
              <span>Tags</span>
            </div>
            <nav className="tag-list" aria-label="Tags">
              <button
                className={`tag-list-item ${selectedTag === "" ? "active" : ""}`}
                onClick={() => setSelectedTag("")}
              >
                All tags
              </button>
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  className={`tag-list-item ${selectedTag === tag ? "active" : ""}`}
                  onClick={() => setSelectedTag(tag)}
                >
                  #{tag}
                </button>
              ))}
            </nav>
          </>
        )}
        <div className="notes-heading">
          <span>
            {selectedFolderID === "all"
              ? "Notes"
              : selectedFolderID === ""
                ? "Unfiled"
                : folders.find((folder) => folder.id === selectedFolderID)?.name ?? "Notes"}
          </span>
          <NoteSortSelect value={currentSortMode} onChange={setCurrentSortMode} />
          <button className="icon-button" onClick={() => void createNote()} aria-label="Create note" title="New note (Ctrl + N)">
            <Icon name="plus" size={17} />
          </button>
        </div>
        <nav className="note-list" aria-label="Notes">
          {visibleNotes.map((item) => (
            <button
              key={item.id}
              className={`note-list-item ${note?.id === item.id ? "active" : ""} ${dropTarget === `note:${item.id}:before` ? "drag-over-before" : ""} ${dropTarget === `note:${item.id}:after` ? "drag-over-after" : ""}`}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
              }
              setGraphOpen(false);
              void selectNote(item.id);
              }}
              onMouseDown={(event) => {
                if (event.button === 0) {
                  dragCandidateRef.current = { kind: "note", id: item.id, active: false };
                }
              }}
              onMouseEnter={(event) => {
                if (event.buttons !== 1 || dragCandidateRef.current?.kind !== "note" || dragCandidateRef.current.id === item.id) return;
                activatePointerDrag(noteDropTargetFromPointer(event, item.id).key);
              }}
              onMouseMove={(event) => {
                if (event.buttons !== 1 || dragCandidateRef.current?.kind !== "note" || !dragCandidateRef.current.active) return;
                if (dragCandidateRef.current.id === item.id) return;
                setDropTarget(noteDropTargetFromPointer(event, item.id).key);
              }}
              onMouseUp={(event) => {
                finishPointerDrag({
                  kind: "note",
                  id: item.id,
                  after: noteDropTargetFromPointer(event, item.id).after,
                });
              }}
              onContextMenu={(event) =>
                showContextMenu(event, {
                  kind: "note",
                  id: item.id,
                  label: item.title,
                })
              }
            >
              <Icon name="file" size={16} />
              <span>
                <strong>{item.title}</strong>
                <small>{new Date(item.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small>
              </span>
            </button>
          ))}
          {visibleNotes.length === 0 && (
            <div className="empty-list">
              <p>This folder is empty.</p>
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="encrypted-status"><span /> Encrypted locally</div>
          <div className="sidebar-vault-buttons">
            <button className="lock-button" onClick={() => void lockVault()}>
              <Icon name="lock" size={15} /> Lock vault
            </button>
            <div className="vault-selector">
              <button
                type="button"
                className="vault-selector-button"
                aria-haspopup="menu"
                aria-expanded={vaultMenuOpen}
                onClick={() => setVaultMenuOpen((open) => !open)}
              >
                <span>{folderName(session.path)}</span><small>⌃</small>
              </button>
              {vaultMenuOpen && (
                <div className="vault-selector-menu" role="menu" aria-label="Recent vaults">
                  {recentVaultPaths.slice(-5).map((path) => (
                    <div className="vault-selector-item" key={path}>
                      <button
                        type="button"
                        role="menuitem"
                        className={`vault-selector-menu-item ${path === session.path ? "active" : ""}`}
                        title={path}
                        onClick={() => void openRecentVault(path)}
                      >
                        <span>{folderName(path)}</span>
                      </button>
                      <button
                        type="button"
                        className="vault-selector-remove"
                        aria-label={`Remove ${folderName(path)} from recent vaults`}
                        title="Remove from recent vaults"
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeRecentVault(path);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      <section
        className="editor-shell"
        onBlur={persistWhenEditorLosesFocus}
        onClick={(event) => {
          if (cardPanel && !(event.target instanceof Element && event.target.closest(".card-sidebar"))) {
            closeCardPanel();
          }
        }}
      >
        <header className="editor-topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <Icon name="menu" />
          </button>
          <div className="breadcrumbs">
            {graphOpen ? (
              <span className="breadcrumb-item"><strong>Graph view</strong></span>
            ) : timeTrackingOpen ? (
              <span className="breadcrumb-item"><strong>Time tracking</strong></span>
            ) : (noteTrail.length ? noteTrail : [
              { id: "", title: folderName(session.path) },
              ...(currentFolder ? [{ id: "", title: currentFolder.name }] : []),
              ...(note ? [{ id: note.id, title: note.title || "Untitled" }] : []),
            ]).map((crumb, index, items) => (
              <span className="breadcrumb-item" key={`${crumb.id || crumb.title}-${index}`}>
                {index > 0 && <b>/</b>}
                {crumb.id && index < items.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => void selectNote(crumb.id, { replaceTrail: items.slice(0, index + 1) })}
                  >
                    {crumb.title}
                  </button>
                ) : index === items.length - 1 ? (
                  <strong>{crumb.title}</strong>
                ) : (
                  <span>{crumb.title}</span>
                )}
              </span>
            ))}
          </div>
          {globalSearchOrigin && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void returnToGlobalSearchOrigin()}
            >
              Back to previous location
            </button>
          )}
          <div className="save-indicators">
            {activeTimeEntry && <div className="global-timer-indicator" title={activeTimeEntry.name} aria-label={`Running ${activeTimeEntry.name}`}><span>{activeTimeEntry.name}</span><strong><RunningTimerText startedAtUtc={activeTimeEntry.startedAtUtc} /></strong></div>}
            <div className={`save-status ${saveState}`}>
              <span />
              {saveState === "saving"
                ? "Encrypting…"
                : saveState === "error"
                  ? "Save failed"
                  : dirty
                    ? "Unsaved"
                    : "Saved locally"}
            </div>
          </div>
          <button
            className="save-file-button"
            disabled={graphOpen || timeTrackingOpen || (!note && !conflictResolution) || (!conflictResolution && !dirty) || saveState === "saving"}
            title={conflictResolution ? "Save the merged conflict result" : !note ? "No note open" : "Save this note (Ctrl + S)"}
            onClick={() => conflictResolution ? void saveResolvedConflict() : persistCurrentInBackground()}
          >
            {saveState === "saving" ? "Encrypting…" : conflictResolution ? "Save merged file" : "Save file"}
          </button>
          <div className={`sync-status ${syncLinked ? "linked" : "not-linked"}`}>
            <span />
            {syncLinked ? "Linked" : "Not linked"}
          </div>
          <button
            className="save-and-sync-button"
            disabled={graphOpen || timeTrackingOpen || !note || !!conflictResolution || saveState === "saving" || syncing || !syncLinked}
            title={
              !note
                ? "No note open"
                : !syncLinked
                  ? "Link this vault to GitHub in Vault Settings first"
                  : "Save and sync to GitHub (Ctrl + Shift + S)"
            }
            onClick={() => void saveAndSync()}
          >
            {syncing ? "Syncing…" : "Save file and sync"}
          </button>
          {syncLinked && lastSyncedAt > 0 && <LastSyncLabel timestamp={lastSyncedAt} />}
          {note && !graphOpen && !timeTrackingOpen && (
            <button className="icon-button delete-button" onClick={() => void deleteNote()} aria-label="Delete note" title="Delete note">
              <Icon name="trash" size={16} />
            </button>
          )}
        </header>

        <nav className="note-tabs" aria-label="Open notes" role="tablist">
          {tabs.map((tab, index) => (
            <div className={`note-tab ${tab.id === activeTabID ? "active" : ""}`} key={tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabID}
                title={`${tab.title} (Alt+${index === 9 ? 0 : index + 1})`}
                onClick={() => void switchTab(tab.id)}
              >
                <span>{tab.title}</span>
              </button>
              <button type="button" aria-label={`Close ${tab.title}`} onClick={() => void closeTab(tab.id)}>×</button>
            </div>
          ))}
          <button type="button" className="new-note-tab" aria-label="Open new tab" title="New tab (Ctrl+T)" onClick={() => void openEmptyTab()}>+</button>
        </nav>

        {(error || syncNotification) && (
          <div className="notification-stack">
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error">
                  <Icon name="x" size={16} />
                </button>
              </div>
            )}

            {syncNotification && (
              <div className="sync-notification" role="status" aria-live="polite">
                <span>{syncNotification}</span>
                <button className="icon-button" onClick={() => setSyncNotification("")} aria-label="Dismiss notification">
                  <Icon name="x" size={16} />
                </button>
              </div>
            )}
          </div>
        )}

        {timeTrackingOpen ? (
          <Suspense fallback={<div className="settings-loading">Loading time tracking...</div>}>
            <TimeTrackingView key={`${session.vaultId}:${activeTimeEntry?.id ?? "idle"}`} now={timerNow} onActiveEntryChange={setActiveTimeEntry} />
          </Suspense>
        ) : graphOpen ? (
          <Suspense fallback={<div className="settings-loading">Loading graph...</div>}>
            <GraphView
              folders={graphFolders}
              notes={publicNotes}
              onSelectFolder={(folder) => {
                setGraphOpen(false);
                void selectFolder(folder);
              }}
              onSelectNote={(noteID) => {
                setGraphOpen(false);
                void selectNote(noteID);
              }}
            />
          </Suspense>
        ) : conflictResolution ? (
          <>
            <div className="document-heading conflict-heading">
              <div>
                <p className="eyebrow">Merge conflict</p>
                <h2>{conflictResolution.localNote.title || "Untitled"}</h2>
              </div>
              <button
                type="button"
                className="primary-button"
                disabled={saveState === "saving"}
                onClick={() => void saveResolvedConflict()}
              >
                {saveState === "saving" ? "Encrypting…" : "Save merged file"}
              </button>
            </div>
            <Suspense fallback={<EditorLoading />}>
              <div className="conflict-editor-grid">
                <section className="conflict-editor-pane">
                  <header>Local File</header>
                  <LiveMarkdownEditor
                    key={`${conflictResolution.conflict.localNoteId}-local`}
                    noteID={`${conflictResolution.conflict.localNoteId}-local`}
                    value={conflictResolution.conflict.localContent}
                    onChange={() => {}}
                    onSave={() => {}}
                    onError={(reason) => setError(errorText(reason))}
                    onOpenWikilink={(title) => void openWikilinkTitle(title)}
                    onDecreaseFontSize={decreaseEditorFontSize}
                    onIncreaseFontSize={increaseEditorFontSize}
                    readOnly
                    showToolbar={false}
                  />
                </section>
                <section className="conflict-editor-pane cloud">
                  <header>Cloud File</header>
                  <LiveMarkdownEditor
                    key={`${conflictResolution.conflict.remoteNoteId}-cloud`}
                    noteID={`${conflictResolution.conflict.remoteNoteId}-cloud`}
                    value={conflictResolution.conflict.remoteContent}
                    onChange={() => {}}
                    onSave={() => {}}
                    onError={(reason) => setError(errorText(reason))}
                    onOpenWikilink={(title) => void openWikilinkTitle(title)}
                    onDecreaseFontSize={decreaseEditorFontSize}
                    onIncreaseFontSize={increaseEditorFontSize}
                    readOnly
                    showToolbar={false}
                    highlightLineNumbers={conflictResolution.cloudHighlightLines}
                  />
                </section>
                <section className="conflict-editor-pane merged">
                  <header>Merged File</header>
                  <LiveMarkdownEditor
                    key={`${conflictResolution.conflict.localNoteId}-merged`}
                    noteID={`${conflictResolution.conflict.localNoteId}-merged`}
                    value={conflictResolution.mergedContent}
                    onChange={(content) =>
                      setConflictResolution((current) =>
                        current ? { ...current, mergedContent: content } : current,
                      )
                    }
                    onSave={() => void saveResolvedConflict()}
                    onError={(reason) => setError(errorText(reason))}
                    onOpenWikilink={(title) => void openWikilinkTitle(title)}
                    onDecreaseFontSize={decreaseEditorFontSize}
                    onIncreaseFontSize={increaseEditorFontSize}
                    showToolbar={false}
                  />
                </section>
              </div>
            </Suspense>
            <footer className="document-footer">
              <span>Resolve conflict</span>
              <span>Local and cloud panes are read-only</span>
              <span className="footer-encryption"><Icon name="lock" size={12} /> Encrypted at rest</span>
            </footer>
          </>
        ) : note ? (
          <>
            <div className={`document-heading ${titleCollapsed ? "is-collapsed" : ""}`}>
              <div className="document-heading-main">
                <button
                  type="button"
                  className="icon-button document-title-toggle disclosure-chevron"
                  onClick={() => setTitleCollapsed((current) => !current)}
                  aria-label={titleCollapsed ? "Expand title" : "Collapse title"}
                  aria-expanded={!titleCollapsed}
                  title={titleCollapsed ? "Expand title" : "Collapse title"}
                >
                </button>
                {titleCollapsed && <span className="collapsed-note-title">{note.title || "Untitled"}</span>}
                {!titleCollapsed && (
                  <div className="document-heading-content">
                    <input
                      className="title-input"
                      value={note.title}
                      onChange={(event) => editNote({ title: event.target.value })}
                      placeholder="Untitled"
                      aria-label="Note title"
                    />
                    <p>
                      Edited {new Date(note.updatedAt).toLocaleString("en-US", {
                        month: "long",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        hourCycle: "h23",
                      })}
                    </p>
                  </div>
                )}
              </div>
              {!titleCollapsed && (
                <div className="document-heading-toolbar">
                  <div className="view-tabs" role="tablist" aria-label="Editor view">
                    {(["live", "object", "markdown"] as EditorView[]).map((item) => (
                      <button
                        key={item}
                        role="tab"
                        aria-selected={view === item}
                        className={view === item ? "active" : ""}
                        onClick={() => setEditorView(item)}
                      >
                        {item === "live"
                          ? "Live Preview"
                          : item === "object"
                            ? "Object Tree"
                            : "Markdown"}
                      </button>
                    ))}
                  </div>
                  <div className="document-heading-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void attachFile()}
                    >
                      Attach encrypted file…
                    </button>
                  </div>
                </div>
              )}
            </div>
            <Suspense fallback={<EditorLoading />}>
              <div className="document-body">
                {view === "live" && (
                  <div className="editor-view-pane active">
                    <LiveMarkdownEditor
                      key={`${note.id}:${sectionDefault}:${cardSignature}`}
                      noteID={note.id}
                      value={noteMarkdown}
                      onChange={(content) => editNote({ content })}
                      onSave={() => persistCurrentInBackground()}
                      onError={(reason) => setError(errorText(reason))}
                      onOpenWikilink={(title) => void openWikilinkTitle(title)}
                      onOpenCard={openCard}
                      cardTitles={cardTitles}
                      cardData={cardMetadata}
                      onCreateCard={createCard}
                      onCreateBoard={createBoard}
                      onMoveCard={moveCard}
                      onAddCardToBoard={addCardToBoard}
                      onDecreaseFontSize={decreaseEditorFontSize}
                      onIncreaseFontSize={increaseEditorFontSize}
                      searchTarget={globalSearchTarget}
                      onSearchTargetApplied={() => setGlobalSearchTarget(null)}
                      caretOffset={noteCaretOffsetsRef.current.get(note.id) ?? 0}
                      caretRestoreVersion={caretRestoreVersion}
                      onCaretChange={(offset) => noteCaretOffsetsRef.current.set(note.id, offset)}
                      defaultSectionsCollapsed={sectionDefault === "collapsed"}
                    />
                  </div>
                )}
                {view === "object" && (
                  <div className="editor-view-pane active">
                    <ObjectTreeView value={note.content} onChange={(content) => editNote({ content }, true)} />
                  </div>
                )}
                {view === "markdown" && (
                  <div className="editor-view-pane active markdown-split-view">
                    <section className="markdown-split-pane">
                      <header>Raw Markdown</header>
                      <SourceMarkdownEditor
                        key={`${note.id}:raw`}
                        noteID={note.id}
                        value={noteMarkdown}
                        scrollSync={markdownScrollSync}
                        onChange={(content) => editNote({ content }, true)}
                        onError={(reason) => setError(errorText(reason))}
                      />
                    </section>
                    <section className="markdown-split-pane portable">
                      <header>Portable Markdown · Read only</header>
                      <SourceMarkdownEditor
                        key={`${note.id}:portable`}
                        noteID={note.id}
                        value={portableNoteMarkdown}
                        readOnly
                        scrollSync={markdownScrollSync}
                        onChange={() => {}}
                        onError={(reason) => setError(errorText(reason))}
                      />
                    </section>
                  </div>
                )}
              </div>
            </Suspense>
            <footer className="document-footer">
              <span>{contentWordCount} words</span>
              <span>Revision {note.revision}</span>
              <span className="footer-encryption"><Icon name="lock" size={12} /> Encrypted at rest</span>
            </footer>
            {backlinks.length > 0 && (
              <aside className="backlinks-panel" aria-label="Backlinks">
                <strong>Backlinks</strong>
                {backlinks.map((item) => (
                  <button
                    key={`${item.noteId}-${item.offset}`}
                    type="button"
                    onClick={() => void selectNote(item.noteId)}
                  >
                    <span>{item.title}</span>
                    <small>{item.snippet}</small>
                  </button>
                ))}
              </aside>
            )}
            {fileAttachments.length > 0 && (
              <aside className="backlinks-panel" aria-label="File attachments">
                <strong>Encrypted files</strong>
                {fileAttachments.map((attachment) => (
                  <div className="attachment-row" key={attachment.id}>
                    <span>{attachment.filename}<small>{attachment.mimeType} · {(attachment.size / 1024).toFixed(1)} KiB</small></span>
                    <button type="button" onClick={() => void exportFileAttachment(attachment)}>Export / open</button>
                    <button type="button" className="danger" onClick={() => void removeFileAttachment(attachment)}>Remove</button>
                  </div>
                ))}
              </aside>
            )}
          </>
        ) : (
          <div className="empty-editor">
            <div className="modal-icon"><Icon name="file" size={21} /></div>
            <h2>A fresh page is waiting.</h2>
            <p>Create a note to begin writing inside this encrypted vault.</p>
            <button className="primary-button" onClick={() => void createNote()}>
              <Icon name="plus" size={17} /> New note
            </button>
          </div>
        )}
        {cardPanel && (
          <aside className="card-sidebar" aria-label="Card details" onClick={(event) => event.stopPropagation()}>
            <header className="card-sidebar-header">
              <div>
                <p className="eyebrow">Card</p>
                <h2>{cardPanel.metadata.title || "Untitled"}</h2>
              </div>
              <button type="button" autoFocus className="icon-button" aria-label="Close card" title="Close card" onClick={closeCardPanel}>
                <Icon name="x" size={16} />
              </button>
            </header>
            <label>Title<input value={cardPanel.metadata.title} placeholder="Untitled" onChange={(event) => setCardPanel((current) => current ? { ...current, metadata: { ...current.metadata, title: event.target.value }, note: { ...current.note, title: event.target.value } } : current)} /></label>
            <label>Status<select value={cardPanel.metadata.status} onChange={(event) => setCardPanel((current) => current ? { ...current, metadata: transitionCard(current.metadata, event.target.value as CardStatus) } : current)}>
              {BOARD_COLUMNS.map((status) => <option value={status} key={status}>{CARD_STATUS_LABELS[status]}</option>)}
            </select></label>
            <label>Tags<input value={cardPanel.metadata.tags.join(", ")} placeholder="Add tags" onChange={(event) => setCardPanel((current) => current ? { ...current, metadata: { ...current.metadata, tags: event.target.value.split(",") } } : current)} /></label>
            {cardTemplates.length > 0 && (
              <label>Template<select value={selectedTemplateID} onChange={(event) => { setSelectedTemplateID(event.target.value); void applyCardTemplate(event.target.value); }}>
                <option value="">Choose a template</option>
                {cardTemplates.map((template) => <option value={template.id} key={template.id}>{String(template.properties?.["cipherleaf-card-template-name"] ?? template.title)}</option>)}
              </select></label>
            )}
            <div className="card-sidebar-dates" aria-label="Card dates">
              <span>Created: {new Date(cardPanel.metadata.createdAt).toLocaleString()}</span>
              {cardPanel.metadata.startedAt && <span>Started: {new Date(cardPanel.metadata.startedAt).toLocaleString()}</span>}
              {cardPanel.metadata.blockedOn && <span>Blocked: {new Date(cardPanel.metadata.blockedOn).toLocaleString()}</span>}
              {cardPanel.metadata.finishedAt && <span>Finished: {new Date(cardPanel.metadata.finishedAt).toLocaleString()}</span>}
            </div>
            <label className="card-sidebar-notes">Notes<textarea value={cardPanel.body} onChange={(event) => setCardPanel((current) => current ? { ...current, body: event.target.value } : current)} /></label>
            <div className="card-sidebar-actions">
              <button type="button" className="secondary-button" onClick={() => void saveCardAsTemplate()}>Save as template</button>
              {selectedTemplateID && <button type="button" className="secondary-button danger" onClick={() => void deleteCardTemplate()}>Delete template</button>}
              <button type="button" className="primary-button" disabled={cardPanelSaving} onClick={() => void saveCardPanel()}>{cardPanelSaving ? "Saving…" : "Save card"}</button>
            </div>
          </aside>
        )}
      </section>
      {logOpen && (
        <section className="log-panel" aria-labelledby="log-title">
          <div className="log-panel-header">
            <div>
              <p className="eyebrow">Diagnostics</p>
              <h2 id="log-title">Log</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConsoleEntries([])}
            >
              Clear
            </button>
            <button
              type="button"
              className="icon-button modal-close"
              aria-label="Close log"
              onClick={() => setLogOpen(false)}
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="log-output" role="log" aria-live="polite">
            {consoleEntries.length === 0 ? (
              <p className="log-empty">No console messages yet.</p>
            ) : (
              consoleEntries.map((entry) => (
                <div className={`log-entry ${entry.level}`} key={entry.id}>
                  <span>{entry.timestamp}</span>
                  <strong>{entry.level}</strong>
                  <code>{entry.message}</code>
                </div>
              ))
            )}
          </div>
        </section>
      )}
      {folderPasswordPrompt && (
        <div className="modal-backdrop folder-password-backdrop" role="presentation" style={{ zIndex: windowLayers.folderPassword }}>
          <form
            className="vault-modal folder-password-modal"
            onSubmit={(event) => {
              event.preventDefault();
              closeFolderPasswordPrompt(folderPassword);
            }}
          >
            <button
              type="button"
              className="icon-button modal-close"
              aria-label="Cancel"
              onClick={() => closeFolderPasswordPrompt(null)}
            >
              <Icon name="x" />
            </button>
            <div className="modal-icon"><Icon name="lock" size={21} /></div>
            <p className="eyebrow">Folder password</p>
            <h2>{folderPasswordPrompt.title}</h2>
            <label>
              Password
              <div className="password-field">
                <input
                  autoFocus
                  type={folderPasswordVisible ? "text" : "password"}
                  value={folderPassword}
                  onChange={(event) => setFolderPassword(event.target.value)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={folderPasswordVisible ? "Hide password" : "Show password"}
                  title={folderPasswordVisible ? "Hide password" : "Show password"}
                  onClick={() => setFolderPasswordVisible((current) => !current)}
                >
                  <Icon name="eye" size={17} />
                </button>
              </div>
            </label>
            <button className="primary-button">
              {folderPasswordPrompt.submitLabel}
            </button>
          </form>
        </div>
      )}
      {recoveryOpen && (
        <div className="modal-backdrop" role="presentation" style={{ zIndex: windowLayers.recovery }}>
          <section className="vault-modal settings-modal recovery-modal" role="dialog" aria-labelledby="recovery-title">
            <button type="button" className="icon-button modal-close" aria-label="Close recovery" onClick={() => setRecoveryOpen(false)}>
              <Icon name="x" />
            </button>
            <p className="eyebrow">Recovery</p>
            <h2 id="recovery-title">Trash and version history</h2>
            <h3>Trash</h3>
            <div className="recovery-list">
              {trashItems.length === 0 && <p className="settings-loading">Trash is empty.</p>}
              {trashItems.map((item) => (
                <div className="recovery-row" key={`${item.kind}:${item.id}`}>
                  <span><strong>{item.title}</strong><small>{item.kind} · {formatLocalDateTime(new Date(item.deletedAt))}</small></span>
                  <button type="button" className="secondary-button" disabled={recoveryBusy} onClick={() => void restoreTrashItem(item)}>Restore</button>
                  <button type="button" className="danger-button" disabled={recoveryBusy} onClick={() => void permanentlyDeleteTrashItem(item)}>Delete</button>
                </div>
              ))}
            </div>
            <h3>{note ? `History for “${note.title}”` : "Note history"}</h3>
            <div className="recovery-list">
              {!note && <p className="settings-loading">Open a note to view its history.</p>}
              {note && noteVersions.length === 0 && <p className="settings-loading">No earlier versions.</p>}
              {noteVersions.map((version) => (
                <div className="recovery-row" key={version.revision}>
                  <span><strong>{version.title}</strong><small>Revision {version.revision} · {formatLocalDateTime(new Date(version.updatedAt))}</small></span>
                  <button type="button" className="secondary-button" disabled={recoveryBusy} onClick={() => void restoreNoteVersion(version)}>Restore</button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {appearanceSettingsOpen && (
        <div className="modal-backdrop appearance-settings-backdrop" role="presentation" style={{ zIndex: windowLayers.appearanceSettings }}>
          <section
            className="vault-modal settings-modal appearance-settings-modal"
            role="dialog"
            aria-labelledby="appearance-settings-title"
          >
            <button
              type="button"
              className="icon-button modal-close"
              aria-label="Close settings"
              onClick={() => setAppearanceSettingsOpen(false)}
            >
              <Icon name="x" />
            </button>
            <p className="eyebrow">Settings</p>
            <h2 id="appearance-settings-title">Settings</h2>
            <div className="settings-layout">
              <nav className="settings-sidebar" aria-label="Settings sections">
                <button
                  type="button"
                  aria-expanded={settingsTab === "general"}
                  className={`settings-parent ${settingsTab === "general" ? "active" : ""}`}
                  onClick={() => openSettingsSection("general")}
                >
                  General
                </button>
                {settingsTab === "general" && (
                  <div className="settings-submenu">
                    <button type="button" onClick={() => openSettingsSection("general", "settings-daily-notes")}>Daily notes</button>
                    <button type="button" onClick={() => openSettingsSection("general", "settings-autosave")}>Auto-save</button>
                    <button type="button" onClick={() => openSettingsSection("general", "settings-auto-sync")}>Auto-sync</button>
                    <button type="button" onClick={() => openSettingsSection("general", "settings-auto-lock")}>Vault lock</button>
                    <button type="button" onClick={() => openSettingsSection("general", "settings-section-default")}>Section state</button>
                  </div>
                )}
                <button
                  type="button"
                  aria-expanded={settingsTab === "appearance"}
                  className={`settings-parent ${settingsTab === "appearance" ? "active" : ""}`}
                  onClick={() => openSettingsSection("appearance")}
                >
                  Appearance
                </button>
                {settingsTab === "appearance" && (
                  <div className="settings-submenu">
                    <button type="button" onClick={() => openSettingsSection("appearance", "settings-theme")}>Theme</button>
                    <button type="button" onClick={() => openSettingsSection("appearance", "settings-guide-lines")}>Guide lines</button>
                    <button type="button" onClick={() => openSettingsSection("appearance", "settings-font-size")}>Text size</button>
                    <button type="button" onClick={() => openSettingsSection("appearance", "settings-editor-font")}>Editor font</button>
                  </div>
                )}
              </nav>
              <div className="settings-content" role="tabpanel">
                {settingsTab === "general" ? (
                  <>
                    <h3>General</h3>
                    <fieldset id="settings-daily-notes" className="appearance-fieldset settings-section settings-section-card">
                      <legend>Daily notes</legend>
                      <label>
                        Title format
                        <input value={dailyNoteFormat} onChange={(event) => setDailyNoteFormat(event.target.value)} placeholder="YYYY-MM-DD" />
                      </label>
                      <label>
                        Folder
                        <select value={dailyNoteFolderID} onChange={(event) => setDailyNoteFolderID(event.target.value)}>
                          <option value="">Unfiled</option>
                          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Template note
                        <select value={dailyTemplateNoteID} onChange={(event) => setDailyTemplateNoteID(event.target.value)}>
                          <option value="">Default heading</option>
                          {notes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                        </select>
                      </label>
                      <small>Template variables: {"{{title}}"}, {"{{date}}"}, and {"{{time}}"}.</small>
                    </fieldset>
                    <div id="settings-autosave" className="settings-section settings-section-card">
                      <label>
                        Auto-save interval (seconds)
                        <input
                          type="number"
                          min="60"
                          step="1"
                          value={autosaveIntervalSeconds}
                          onChange={(event) => setAutosaveIntervalSeconds(Math.max(60, Number(event.target.value) || 60))}
                        />
                      </label>
                    </div>
                    <div id="settings-auto-sync" className="settings-section settings-section-card">
                      <label>
                        Auto-sync after inactivity (minutes)
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={autoSyncMinutes}
                          onChange={(event) => setAutoSyncMinutes(Math.max(1, Number(event.target.value) || 1))}
                        />
                      </label>
                    </div>
                    <div id="settings-auto-lock" className="settings-section settings-section-card">
                      <label>
                        Lock vault after inactivity (minutes)
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={autoLockMinutes}
                          onChange={(event) => setAutoLockMinutes(Math.max(1, Number(event.target.value) || 1))}
                        />
                      </label>
                    </div>
                    <fieldset id="settings-section-default" className="appearance-fieldset settings-section settings-section-card">
                      <legend>Default section state</legend>
                      <div className="appearance-theme-options">
                        {(["expanded", "collapsed"] as SectionDefault[]).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={sectionDefault === value ? "active" : ""}
                            aria-pressed={sectionDefault === value}
                            onClick={() => setSectionDefault(value)}
                          >
                            {value === "expanded" ? "Expanded" : "Collapsed"}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  </>
                ) : (
                  <>
                    <h3>Appearance</h3>
                    <fieldset id="settings-theme" className="appearance-fieldset settings-section settings-section-card">
                      <legend>Theme</legend>
                      <div className="appearance-theme-options">
                        {THEME_OPTIONS.map((item) => (
                          <button key={item.value} type="button" className={theme === item.value ? "active" : ""} aria-pressed={theme === item.value} onClick={() => setTheme(item.value)}>
                            <span className={`theme-swatch ${item.swatch}`} />
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset id="settings-guide-lines" className="appearance-fieldset settings-section settings-section-card">
                      <legend>Writing guide lines</legend>
                      <div className="appearance-theme-options">
                        {(["none", "full", "dotted"] as JournalLines[]).map((value) => (
                          <button key={value} type="button" className={journalLines === value ? "active" : ""} aria-pressed={journalLines === value} onClick={() => setJournalLines(value)}>
                            {value === "none" ? "None" : value === "full" ? "Solid" : "Dotted"}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <div id="settings-font-size" className="settings-section settings-section-card">
                      <label>
                        Editor font size
                        <div className="appearance-size-row">
                          <input type="range" min="10" max="32" step="1" value={editorFontSize} onChange={(event) => setEditorFontSize(Number(event.target.value))} />
                          <output>{editorFontSize}px</output>
                        </div>
                      </label>
                    </div>
                    <div id="settings-editor-font" className="appearance-font-field settings-section settings-section-card">
                      <span>Editor font</span>
                      <dl className="appearance-font-details">
                        <div><dt>Name:</dt><dd title={editorFontName}>{editorFontName || "Default (Charter)"}</dd></div>
                        <div><dt>Sample:</dt><dd className="appearance-font-sample" style={{ fontFamily: "var(--selected-editor-font, var(--editor-font))" }}>The quick brown fox jumps over the lazy dog 1234567890</dd></div>
                      </dl>
                      <div className="appearance-font-actions">
                        {installedFonts.length > 0 ? (
                          <details className="tag-multi-select appearance-font-select">
                            <summary aria-label="Installed editor font">Installed fonts…</summary>
                            <div className="tag-multi-select-options" role="listbox" aria-label="Installed editor font">
                              {installedFonts.map((font) => <button key={font} type="button" role="option" aria-selected={editorFontName === font} style={{ fontFamily: font }} onClick={(event) => { chooseInstalledFont(font); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{font}</button>)}
                            </div>
                          </details>
                        ) : (
                          <button type="button" className="secondary-button" disabled={installedFontsLoading} onClick={() => void loadInstalledFonts()}>{installedFontsLoading ? "Loading fonts…" : "Installed fonts…"}</button>
                        )}
                        <button type="button" className="secondary-button" onClick={() => editorFontInputRef.current?.click()}>Select .ttf…</button>
                        <button type="button" className="secondary-button" disabled={!editorFontName} onClick={() => void resetEditorFont()}>Reset</button>
                        <input ref={editorFontInputRef} className="appearance-font-input" type="file" accept=".ttf,font/ttf" onChange={(event) => void chooseEditorFont(event)} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {statisticsOpen && (
        <div className="modal-backdrop" role="presentation" style={{ zIndex: windowLayers.statistics }}>
          <section className="vault-modal statistics-modal" role="dialog" aria-modal="true" aria-labelledby="statistics-title">
            <button type="button" className="icon-button modal-close" aria-label="Close statistics" onClick={() => setStatisticsOpen(false)}>
              <Icon name="x" />
            </button>
            <div className="modal-icon"><Icon name="dots" size={21} /></div>
            <p className="eyebrow">Live usage</p>
            <h2 id="statistics-title">Application statistics</h2>
            {statisticsError ? <p className="error-message">{statisticsError}</p> : (
              <>
                <div className="statistics-grid">
                  <div><span>CPU usage</span><strong>{statistics ? `${statistics.cpuPercent.toFixed(1)}%` : "—"}</strong></div>
                  <div><span>Memory usage</span><strong>{statistics ? `${(statistics.memoryBytes / 1024 / 1024).toFixed(1)} MB` : "—"}</strong></div>
                </div>
                {statistics && (
                  <div className="statistics-processes">
                    <h3>Memory by process</h3>
                    {(statistics.memoryUsage ?? []).map((item) => (
                      <div className="statistics-process" key={item.pid}>
                        <span><strong>{item.name}</strong><small>PID {item.pid}</small></span>
                        <strong>{(item.memoryBytes / 1024 / 1024).toFixed(1)} MB</strong>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {vaultSettingsOpen && (
        <div className="modal-backdrop vault-settings-backdrop" role="presentation" style={{ zIndex: windowLayers.vaultSettings }}>
          <form
            className="vault-modal settings-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void linkGitHubVault();
            }}
          >
            <button
              type="button"
              className="icon-button modal-close"
              aria-label="Close settings"
              onClick={() => {
                setVaultSettingsOpen(false);
                setConnectionResult(null);
              }}
            >
              <Icon name="x" />
            </button>
            <div className="modal-icon"><Icon name="lock" size={21} /></div>
            <p className="eyebrow">Vault settings</p>
            <h2>Vault Statistics</h2>
            <div className="vault-statistics">
              <div><span>Notes</span><strong>{vaultStatistics ? formatStorageSize(vaultStatistics.notesBytes) : "—"}</strong></div>
              <div><span>Attachments</span><strong>{vaultStatistics ? formatStorageSize(vaultStatistics.attachmentsBytes) : "—"}</strong></div>
              <div><span>Time Tracking</span><strong>{vaultStatistics ? formatStorageSize(vaultStatistics.timeTrackingBytes) : "—"}</strong></div>
              <div><span>Git metadata (.git)</span><strong>{vaultStatistics ? formatStorageSize(vaultStatistics.gitBytes) : "—"}</strong></div>
            </div>
            <h2>File history</h2>
            <label>
              Versions kept per file
              <div className="settings-path-field">
                <input
                  type="number"
                  min="1"
                  max="50"
                  step="1"
                  value={fileHistoryLimitDraft}
                  onChange={(event) => setFileHistoryLimitDraft(Math.min(50, Math.max(1, Number(event.target.value) || 1)))}
                />
                <button type="button" className="secondary-button" disabled={historySaving || fileHistoryLimitDraft === fileHistoryLimit} onClick={() => void saveHistorySettings()}>
                  {historySaving ? "Saving…" : "Save"}
                </button>
              </div>
              <small>Save syncs this limit and permanently deletes older versions.</small>
            </label>
            <h2>Encrypted backups</h2>
            <label>
              Backup destination
              <div className="settings-path-field">
                <input value={backupDirectoryDraft} onChange={(event) => setBackupDirectoryDraft(event.target.value)} placeholder="Disabled" spellCheck={false} />
                <button type="button" className="secondary-button" onClick={() => void chooseBackupDestination()}>Browse…</button>
              </div>
            </label>
            <label>
              Backups kept
              <div className="settings-path-field">
                <input type="number" min="1" max="30" value={backupRetentionDraft} onChange={(event) => setBackupRetentionDraft(Math.min(30, Math.max(1, Number(event.target.value) || 1)))} />
                <button type="button" className="secondary-button" disabled={backupSaving || (backupDirectoryDraft === backupDirectory && backupRetentionDraft === backupRetention)} onClick={saveBackupSettings}>
                  {backupSaving ? "Saving…" : "Save"}
                </button>
              </div>
              <small>Creates one encrypted snapshot per day while Cipherleaf is open. Clear the destination to disable backups.</small>
            </label>
            {backupStatus && <div className="connection-result success" role="status">{backupStatus}</div>}
            <h2>GitHub sync (experimental)</h2>
            <div className={`sync-link-state ${syncSettings?.linked ? "linked" : ""}`}>
              <span />
              {syncSettings?.linked ? "Linked" : "Not linked"}
            </div>
            {syncSettings ? (
              <>
                <label>
                  GitHub repository
                  <input
                    autoFocus
                    value={syncSettings.repositorySsh}
                    onChange={(event) => {
                      setSyncSettings({ ...syncSettings, repositorySsh: event.target.value });
                      setConnectionResult(null);
                    }}
                    placeholder="git@github.com:OWNER/REPOSITORY.git"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  GitHub SSH key location
                  <div className="settings-path-field">
                    <input
                      value={syncSettings.privateKeyPath}
                      onChange={(event) => {
                        setSyncSettings({ ...syncSettings, privateKeyPath: event.target.value });
                        setConnectionResult(null);
                      }}
                      placeholder="/home/user/.ssh/cipherleaf_vault"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void chooseGitHubSSHKey()}
                    >
                      Browse…
                    </button>
                  </div>
                </label>
                <label>
                  Branch
                  <input
                    value={syncSettings.branch}
                    onChange={(event) => {
                      setSyncSettings({ ...syncSettings, branch: event.target.value });
                      setConnectionResult(null);
                    }}
                    placeholder="main"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="private-repository-confirmation">
                  <input
                    type="checkbox"
                    checked={syncSettings.repositoryPrivate}
                    onChange={(event) => {
                      setSyncSettings({
                        ...syncSettings,
                        repositoryPrivate: event.target.checked,
                      });
                      setConnectionResult(null);
                    }}
                  />
                  <span>I confirm this GitHub repository is private.</span>
                </label>
                <div className="sync-privacy-warning">
                  Multi-device conflict handling is experimental. Keep an independent backup.
                  {" "}
                  Note content remains encrypted, but Git history reveals commit timing,
                  object count, and ciphertext size.
                </div>
                {connectionResult && (
                  <div
                    className={`connection-result ${connectionResult.success ? "success" : "error"}`}
                    role="status"
                  >
                    <strong>{connectionResult.success ? "Ready" : "Connection failed"}</strong>
                    <span>{connectionResult.message}</span>
                    {connectionResult.warning && <span>{connectionResult.warning}</span>}
                  </div>
                )}
                <div className="settings-actions">
                  {syncConflicts.length > 0 && (
                    <button
                      type="button"
                      className="secondary-button danger-button"
                      disabled={settingsBusy || syncing}
                      onClick={() => void forcePushLocalVault()}
                    >
                      Force push local
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={settingsBusy}
                    onClick={() => void forgetRememberedSecret()}
                  >
                    Forget remembered secret
                  </button>
                  <button
                    type="button"
                    className="secondary-button unlink-button"
                    disabled={settingsBusy}
                    onClick={() => void unlinkGitHubSync()}
                  >
                    Unlink vault
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={settingsBusy}
                    onClick={() => void testGitHubConnection()}
                  >
                    {settingsBusy ? "Working…" : "Test connection"}
                  </button>
                  {syncSettings.linked && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={settingsBusy}
                      onClick={() => void openGitTerminal()}
                    >
                      Open Git terminal
                    </button>
                  )}
                  {!syncSettings.linked && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={settingsBusy}
                      onClick={() => void pullAndLinkGitHubVault()}
                    >
                      Pull remote and link
                    </button>
                  )}
                  <button className="primary-button" disabled={settingsBusy}>
                    {settingsBusy
                      ? "Linking…"
                      : syncSettings.linked
                        ? "Verify link"
                        : "Link vault"}
                  </button>
                </div>
              </>
            ) : (
              <p className="settings-loading">Loading GitHub sync settings…</p>
            )}
          </form>
        </div>
      )}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="context-menu-title">{contextMenu.label}</div>
          {contextMenu.kind === "note" ? (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  const id = contextMenu.id;
                  setContextMenu(null);
                  void openNoteInNewTab(id);
                }}
              >
                <Icon name="file" size={14} />
                Open in a New Tab
              </button>
              <div className="context-menu-separator" />
              <button
                className="danger"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  void deleteNote(contextMenu.id, contextMenu.label);
                }}
              >
                <Icon name="trash" size={14} />
                Delete note
              </button>
              <div className="context-menu-separator" />
              <div className="context-menu-label">Move to</div>
              <button
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  void moveNote(contextMenu.id, "");
                }}
              >
                <Icon name="folder" size={14} />
                Unfiled
              </button>
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  role="menuitem"
                  onClick={() => {
                    setContextMenu(null);
                    void moveNote(contextMenu.id, folder.id);
                  }}
                >
                  <Icon name="folder" size={14} />
                  {folder.name}
                </button>
              ))}
            </>
          ) : (
            <>
              {(() => {
                const folder = folders.find((item) => item.id === contextMenu.id);
                if (!folder) return null;
                return (
                  <>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setContextMenu(null);
                        void createFolder(folder.id);
                      }}
                    >
                      <Icon name="folder" size={14} />
                      New subfolder
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setContextMenu(null);
                        void setFolderHidden(folder, !folder.hidden);
                      }}
                    >
                      <Icon name="eye" size={14} />
                      {folder.hidden ? "Show notes" : "Hide notes"}
                    </button>
                    {folder.locked && unlockedFolderIDs.has(folder.id) && (
                      <button
                        role="menuitem"
                        onClick={() => {
                          setContextMenu(null);
                          void lockUnlockedFolder(folder);
                        }}
                      >
                        <Icon name="lock" size={14} />
                        Lock folder
                      </button>
                    )}
                    <button
                      role="menuitem"
                      onClick={() => {
                        setContextMenu(null);
                        void (folder.locked ? removeFolderLock(folder) : lockFolder(folder));
                      }}
                    >
                      <Icon name="lock" size={14} />
                      {folder.locked ? "Remove lock" : "Lock folder"}
                    </button>
                    <div className="titlebar-menu-separator" />
                    <div className="context-menu-label">Move to</div>
                    <button
                      role="menuitem"
                      disabled={!folder.parentId}
                      onClick={() => {
                        setContextMenu(null);
                        void moveFolder(folder.id, "");
                      }}
                    >
                      <Icon name="folder" size={14} />
                      Top level
                    </button>
                    {folderRows
                      .filter(({ folder: destination }) =>
                        destination.id !== folder.id &&
                        !folderLineage(destination.id, folderByID).some((item) => item.id === folder.id),
                      )
                      .map(({ folder: destination, depth }) => (
                        <button
                          key={destination.id}
                          role="menuitem"
                          disabled={destination.id === folder.parentId}
                          onClick={() => {
                            setContextMenu(null);
                            void moveFolder(folder.id, destination.id);
                          }}
                        >
                          <Icon name="folder" size={14} />
                          {" ".repeat(depth)}{destination.name}
                        </button>
                      ))}
                    <div className="titlebar-menu-separator" />
                    {(["manual", "title", "updated", "created"] as const).map((mode) => (
                      <button
                        key={mode}
                        role="menuitem"
                        onClick={() => {
                          setContextMenu(null);
                          void setFolderSortMode(folder, mode);
                        }}
                      >
                        <Icon name="dots" size={14} />
                        Sort: {mode}{(folder.sortMode || "manual") === mode ? " ✓" : ""}
                      </button>
                    ))}
                    <div className="titlebar-menu-separator" />
                  </>
                );
              })()}
              <button
                role="menuitem"
                onClick={() => {
                  const folder = folders.find((item) => item.id === contextMenu.id);
                  setContextMenu(null);
                  if (folder) void renameFolder(folder);
                }}
              >
                <Icon name="dots" size={14} />
                Rename folder
              </button>
              <button
                className="danger"
                role="menuitem"
                onClick={() => {
                  const folder = folders.find((item) => item.id === contextMenu.id);
                  setContextMenu(null);
                  if (folder) void deleteFolder(folder);
                }}
              >
                <Icon name="trash" size={14} />
                Delete empty folder
              </button>
            </>
          )}
        </div>
      )}
      {timerDialog && (
        <div className="modal-backdrop timer-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTimerDialog(null); }}>
          <section className="vault-modal timer-modal" role="dialog" aria-modal="true" aria-labelledby="timer-dialog-title">
            <button type="button" className="icon-button modal-close" aria-label="Close timer dialog" onClick={() => setTimerDialog(null)}><Icon name="x" /></button>
            <p className="eyebrow">Time tracking</p>
            {timerDialog === "start" ? <form onSubmit={(event) => { event.preventDefault(); void startTimerFromDialog(); }}>
              <h2 id="timer-dialog-title">Start a timer</h2>
              {activeTimeEntry && <p className="timer-modal-warning">“{activeTimeEntry.name}” is already running.</p>}
              <label>Task name<input autoFocus value={timerTaskName} onChange={(event) => setTimerTaskName(event.target.value)} disabled={!!activeTimeEntry || timerBusy} /></label>
              <ClientSelect clients={(timerCatalog?.clients ?? []).filter((item) => !item.archivedAtUtc)} selected={timerClientID} onChange={(id) => { setTimerClientID(id); if (timerProjectID && (timerCatalog?.projects ?? []).find((project) => project.id === timerProjectID)?.clientId !== id) setTimerProjectID(""); }} disabled={!!activeTimeEntry || timerBusy} />
              <ProjectSelect projects={(timerCatalog?.projects ?? []).filter((item) => !item.archivedAtUtc && (!timerClientID || item.clientId === timerClientID))} selected={timerProjectID} onChange={(id) => { setTimerProjectID(id); if (!timerClientID) setTimerClientID((timerCatalog?.projects ?? []).find((project) => project.id === id)?.clientId ?? ""); }} disabled={!!activeTimeEntry || timerBusy} />
              <TagMultiSelect tags={(timerCatalog?.tags ?? []).filter((item) => !item.archivedAtUtc)} selected={timerTagIDs} onChange={setTimerTagIDs} disabled={!!activeTimeEntry || timerBusy} />
              {timerError && <div className="timer-modal-error" role="alert">{timerError}</div>}
              <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setTimerDialog(null)}>Cancel</button><button className="primary-button" disabled={!!activeTimeEntry || timerBusy}>{timerBusy ? "Starting…" : "Start timer"}</button></div>
            </form> : <div>
              <h2 id="timer-dialog-title">Finish active timer?</h2>
              <p>{activeTimeEntry ? <>Finish <strong>{activeTimeEntry.name}</strong> at <RunningTimerText startedAtUtc={activeTimeEntry.startedAtUtc} />?</> : "There is no active timer."}</p>
              {timerError && <div className="timer-modal-error" role="alert">{timerError}</div>}
              <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setTimerDialog(null)}>Cancel</button><button autoFocus type="button" className="primary-button" disabled={!activeTimeEntry || timerBusy} onClick={() => void finishTimerFromDialog()}>{timerBusy ? "Finishing…" : "Finish timer"}</button></div>
            </div>}
          </section>
        </div>
      )}
      {syncing && (
        <div className="sync-overlay" role="status" aria-live="polite" aria-busy="true">
          <div className="sync-spinner" aria-hidden="true" />
          <div className="sync-overlay-label">Sync in progress</div>
        </div>
      )}
      {syncConflicts.length > 0 && (
        <div className="modal-backdrop conflict-backdrop" role="presentation" style={{ zIndex: windowLayers.syncConflicts }}>
          <section className="vault-modal conflict-modal" role="dialog" aria-labelledby="conflict-title">
            <button
              type="button"
              className="icon-button modal-close"
              aria-label="Close conflicts"
              onClick={() => setSyncConflicts([])}
            >
              <Icon name="x" />
            </button>
            <p className="eyebrow">Sync conflicts</p>
            <h2 id="conflict-title">Remote edits were preserved</h2>
            <div className="conflict-list">
              {syncConflicts.map((conflict) => (
                <button
                  key={conflict.remoteNoteId}
                  type="button"
                  onClick={() => {
                    setSyncConflicts([]);
                    void startConflictResolution(conflict);
                  }}
                >
                  <strong>{conflict.title}</strong>
                  <span>{conflict.message}</span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button danger-button"
                disabled={syncing}
                onClick={() => void forcePushLocalVault()}
              >
                Force push local vault
              </button>
            </div>
          </section>
        </div>
      )}
      {trackingConflicts.length > 0 && (
        <div className="modal-backdrop conflict-backdrop tracking-conflict-backdrop" role="presentation">
          <section className="vault-modal conflict-modal tracking-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="tracking-conflict-title">
            <p className="eyebrow">Time tracking sync conflicts</p>
            <h2 id="tracking-conflict-title">Choose each result explicitly</h2>
            <p>Sync remains blocked until every preserved variant is resolved.</p>
            <div className="tracking-conflict-list">{trackingConflicts.map((conflict) => <article key={conflict.id}><h3>{conflict.message}</h3><div className="tracking-conflict-variants"><div><strong>Local</strong><span>{conflict.localEntry?.name ?? conflict.localClient?.name ?? conflict.localProject?.name ?? conflict.localTag?.name ?? "No local variant"}</span>{conflict.localEntry && <small>{formatLocalDateTime(new Date(conflict.localEntry.startedAtUtc))} – {conflict.localEntry.endedAtUtc ? formatLocalDateTime(new Date(conflict.localEntry.endedAtUtc)) : "Running"}</small>}</div><div><strong>Remote</strong><span>{conflict.remoteEntry?.name ?? conflict.remoteClient?.name ?? conflict.remoteProject?.name ?? conflict.remoteTag?.name ?? "No remote variant"}</span>{conflict.remoteEntry && <small>{formatLocalDateTime(new Date(conflict.remoteEntry.startedAtUtc))} – {conflict.remoteEntry.endedAtUtc ? formatLocalDateTime(new Date(conflict.remoteEntry.endedAtUtc)) : "Running"}</small>}</div></div><div className="settings-actions"><button className="secondary-button" onClick={() => void resolveTrackingConflict(conflict, "local")}>Keep local</button><button className="secondary-button" onClick={() => void resolveTrackingConflict(conflict, "remote")}>Use remote</button>{conflict.localEntry && <button className="secondary-button danger-button" onClick={() => void resolveTrackingConflict(conflict, "delete-local")}>Delete local entry</button>}{conflict.remoteEntry && <button className="secondary-button danger-button" onClick={() => void resolveTrackingConflict(conflict, "delete-remote")}>Delete remote entry</button>}{conflict.kind === "active-entries" && activeTimeEntry && <button className="primary-button" onClick={() => void resolveTrackingConflict(conflict, "finish")}>Finish active timer</button>}</div></article>)}</div>
          </section>
        </div>
      )}
      {calendarOpen && (
        <div
          className="modal-backdrop calendar-backdrop"
          role="presentation"
          style={{ zIndex: windowLayers.calendar }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCalendarOpen(false);
          }}
        >
          <section className="vault-modal calendar-modal" role="dialog" aria-modal="true" aria-labelledby="calendar-title">
            <button type="button" className="icon-button modal-close" aria-label="Close calendar" onClick={() => setCalendarOpen(false)}>
              <Icon name="x" />
            </button>
            <p className="eyebrow">Calendar</p>
            <div className="calendar-controls">
              <button
                type="button"
                className="calendar-arrow"
                aria-label="Previous month"
                onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
              >
                ‹
              </button>
              <h2 id="calendar-title">{calendarTitle}</h2>
              <button
                type="button"
                className="calendar-arrow"
                aria-label="Next month"
                onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
              >
                ›
              </button>
            </div>
            <div className="calendar-selectors">
              <label>
                <span>Month</span>
                <select
                  value={calendarMonth.getMonth()}
                  onChange={(event) => setCalendarMonth((current) => new Date(current.getFullYear(), Number(event.target.value), 1))}
                >
                  {Array.from({ length: 12 }, (_, month) => (
                    <option key={month} value={month}>
                      {new Date(2000, month, 1).toLocaleDateString("en-US", { month: "long" })}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Year</span>
                <select
                  value={calendarMonth.getFullYear()}
                  onChange={(event) => setCalendarMonth((current) => new Date(Number(event.target.value), current.getMonth(), 1))}
                >
                  {Array.from({ length: 201 }, (_, index) => calendarMonth.getFullYear() - 100 + index).map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="calendar-weekdays" aria-hidden="true">
              {Array.from({ length: 7 }, (_, day) => (
                <span key={day}>{new Date(2023, 0, day + 1).toLocaleDateString("en-US", { weekday: "narrow" })}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {calendarDays.map(({ date, inMonth }) => (
                <button
                  type="button"
                  key={date.toISOString()}
                  className={`calendar-day${inMonth ? "" : " outside-month"}${isSameDay(date, today) ? " today" : ""}${isSameDay(date, calendarSelected) ? " selected" : ""}`}
                  aria-label={date.toLocaleDateString("en-US", { dateStyle: "full" })}
                  aria-pressed={isSameDay(date, calendarSelected)}
                  onClick={() => {
                    setCalendarSelected(date);
                    if (!inMonth) setCalendarMonth(startOfMonth(date));
                  }}
                >
                  {date.getDate()}
                </button>
              ))}
            </div>
            <div className="calendar-footer">
              <span>{calendarSelected.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
              <button type="button" className="primary-button" onClick={() => void openDailyNote(calendarSelected)}>
                Open daily note
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setCalendarSelected(today);
                  setCalendarMonth(startOfMonth(today));
                }}
              >
                Today
              </button>
            </div>
          </section>
        </div>
      )}
      {quickSwitcherOpen && (
        <div className="global-search-scrim" style={{ zIndex: windowLayers.quickSwitcher }} onClick={(event) => {
          if (event.target === event.currentTarget) setQuickSwitcherOpen(false);
        }}>
          <div className="global-search-panel" role="dialog" aria-label="Quick note switcher">
            <div className="global-search-header">
              <span>Quick note switcher</span>
              <button type="button" className="icon-button" onClick={() => setQuickSwitcherOpen(false)} aria-label="Close"><Icon name="x" size={14} /></button>
            </div>
            <div className="global-search-row">
              <input
                className="global-search-input"
                autoFocus
                value={quickSwitcherQuery}
                placeholder="Type a note title"
                onChange={(event) => setQuickSwitcherQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuickSwitcherOpen(false);
                  if (event.key === "Enter" && quickSwitcherNotes[0]) {
                    setQuickSwitcherOpen(false);
                    void selectNote(quickSwitcherNotes[0].id, { appendTrail: true });
                  }
                }}
              />
            </div>
            <div className="global-search-results">
              {quickSwitcherNotes.map((item) => (
                <button type="button" className="global-search-result" key={item.id} onClick={() => {
                  setQuickSwitcherOpen(false);
                  void selectNote(item.id, { appendTrail: true });
                }}>
                  <div className="global-search-result-title">{item.title}</div>
                </button>
              ))}
              {quickSwitcherQuery.trim() && !notes.some((item) => item.title.toLocaleLowerCase() === quickSwitcherQuery.trim().toLocaleLowerCase()) && (
                <button type="button" className="global-search-result" onClick={() => {
                  const title = quickSwitcherQuery.trim();
                  setQuickSwitcherOpen(false);
                  void createNote(title);
                }}>
                  <div className="global-search-result-title">Create “{quickSwitcherQuery.trim()}”</div>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {commandPaletteOpen && (
        <div
          className="global-search-scrim"
          style={{ zIndex: windowLayers.commandPalette }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeCommandPalette();
          }}
        >
          <section className="global-search-panel command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
            <div className="global-search-header">
              <span id="command-palette-title">Command palette</span>
              <button type="button" className="icon-button" onClick={closeCommandPalette} aria-label="Close command palette"><Icon name="x" size={14} /></button>
            </div>
            <div className="global-search-row">
              <input
                className="global-search-input"
                type="text"
                autoFocus
                value={commandPaletteQuery}
                placeholder="Type a command"
                aria-label="Search commands"
                aria-activedescendant={selectedCommandPaletteCommand ? `command-palette-${selectedCommandPaletteCommand.id}` : undefined}
                onChange={(event) => {
                  setCommandPaletteQuery(event.target.value);
                  setCommandPaletteIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeCommandPalette();
                    return;
                  }
                  if (event.key === "Enter" && selectedCommandPaletteCommand) {
                    event.preventDefault();
                    runCommandPaletteCommand(selectedCommandPaletteCommand);
                    return;
                  }
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  if (!matchingCommandPaletteCommands.length) return;
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setCommandPaletteIndex((current) => (
                    Math.min(current, matchingCommandPaletteCommands.length - 1) + direction + matchingCommandPaletteCommands.length
                  ) % matchingCommandPaletteCommands.length);
                }}
              />
            </div>
            <div className="command-palette-results" role="listbox" aria-label="Matching commands">
              {matchingCommandPaletteCommands.map((command, index) => (
                <button
                  type="button"
                  key={command.id}
                  id={`command-palette-${command.id}`}
                  className="command-palette-command"
                  role="option"
                  aria-selected={index === commandPaletteSelectedIndex}
                  onMouseEnter={() => setCommandPaletteIndex(index)}
                  onClick={() => runCommandPaletteCommand(command)}
                >
                  <kbd>{command.shortcut || "—"}</kbd>
                  <strong>{command.name}</strong>
                  <span>{command.description}</span>
                </button>
              ))}
              {!matchingCommandPaletteCommands.length && <p className="command-palette-empty">No matching commands.</p>}
            </div>
          </section>
        </div>
      )}
      {globalSearchOpen && (
        <div
          className="global-search-scrim"
          style={{ zIndex: windowLayers.globalSearch }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setGlobalSearchOpen(false);
            }
          }}
        >
          <div
            className="global-search-panel"
            role="dialog"
            aria-label="Find in all notes"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="global-search-header">
              <span>{globalSearchReplace ? "Find and replace in all notes" : "Find in all notes"}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setGlobalSearchOpen(false)}
                aria-label="Close"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="global-search-row">
              <input
                className="global-search-input"
                type="text"
                placeholder={globalSearchReplace ? "Search plain text to replace" : "Search text, tag:name, folder:name, property:key=value, or re:pattern"}
                value={globalSearchQuery}
                onChange={(event) => {
                  const query = event.target.value;
                  globalSearchRequestRef.current++;
                  globalSearchResultsKeyRef.current = "";
                  setGlobalSearchMatches([]);
                  setGlobalSearchBusy(Boolean(query.trim()));
                  setGlobalSearchQuery(query);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setGlobalSearchOpen(false);
                  }
                }}
                autoFocus
              />
            </div>
            <div className="global-search-options" aria-label="Search options">
              <label>
                <input
                  type="checkbox"
                  checked={globalSearchCaseSensitive}
                  onChange={(event) => {
                    globalSearchRequestRef.current++;
                    globalSearchResultsKeyRef.current = "";
                    setGlobalSearchMatches([]);
                    setGlobalSearchBusy(Boolean(globalSearchQuery.trim()));
                    setGlobalSearchCaseSensitive(event.target.checked);
                  }}
                />
                Case sensitive
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={globalSearchWholeWord}
                  onChange={(event) => {
                    globalSearchRequestRef.current++;
                    globalSearchResultsKeyRef.current = "";
                    setGlobalSearchMatches([]);
                    setGlobalSearchBusy(Boolean(globalSearchQuery.trim()));
                    setGlobalSearchWholeWord(event.target.checked);
                  }}
                />
                Match whole word
              </label>
            </div>
            {globalSearchReplace && (
              <div className="global-search-row">
                <input
                  className="global-search-input"
                  type="text"
                  placeholder="Replace with"
                  value={globalSearchReplacement}
                  onChange={(event) => setGlobalSearchReplacement(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void runGlobalReplace();
                    } else if (event.key === "Escape") {
                      setGlobalSearchOpen(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="sync-now-button"
                  disabled={!canReplaceSearch(
                    globalSearchQuery,
                    globalSearchResultsKeyRef.current,
                    globalSearchBusy,
                    globalSearchCaseSensitive,
                    globalSearchWholeWord,
                  )}
                  onClick={() => void runGlobalReplace()}
                >
                  Replace all
                </button>
              </div>
            )}
            <div className="global-search-results">
              {globalSearchError && <div className="error-banner" role="alert">{globalSearchError}</div>}
              {globalSearchBusy && <div className="global-search-status">Searching…</div>}
              {!globalSearchBusy && globalSearchQuery.trim() && globalSearchMatches.length === 0 && !globalSearchError && (
                <div className="global-search-status">No matches.</div>
              )}
              {globalSearchMatches.map((match, index) => (
                <button
                  type="button"
                  key={`${match.noteId}-${match.offset}-${index}`}
                  className="global-search-result"
                  onClick={() => void openGlobalSearchResult(match)}
                >
                  <div className="global-search-result-title">{match.title}</div>
                  <div className="global-search-result-snippet">{match.snippet}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
      {appDialog && (
        <div className="modal-backdrop app-dialog-backdrop" role="presentation" style={{ zIndex: windowLayers.appDialog }}>
          <form
            className={`vault-modal app-dialog-modal${appDialog.kind === "confirm" && appDialog.danger ? " danger-dialog" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              closeAppDialog(appDialog.kind === "prompt" ? appDialogValue : true);
            }}
          >
            <button
              type="button"
              className="icon-button modal-close"
              aria-label="Cancel"
              onClick={() => closeAppDialog(appDialog.kind === "prompt" ? null : false)}
            >
              <Icon name="x" />
            </button>
            <div className="modal-icon"><Icon name={appDialog.icon ?? "dots"} size={21} /></div>
            <p className="eyebrow">{appDialog.eyebrow}</p>
            <h2>{appDialog.title}</h2>
            {appDialog.kind === "prompt" ? (
              <label>
                {appDialog.label}
                <input
                  autoFocus
                  type="text"
                  value={appDialogValue}
                  onChange={(event) => setAppDialogValue(event.target.value)}
                />
              </label>
            ) : (
              <p className="app-dialog-message">{appDialog.message}</p>
            )}
            <div className="app-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => closeAppDialog(appDialog.kind === "prompt" ? null : false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={appDialog.kind === "confirm" && appDialog.danger ? "danger-button" : "primary-button"}
              >
                {appDialog.kind === "prompt" ? appDialog.submitLabel : appDialog.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

export default App;
