import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Events } from "@wailsio/runtime";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type {
  FindMatch,
  Folder,
  MergeConflict,
  Note,
  NoteSummary,
  ReplaceResult,
  Session,
} from "../bindings/cipherleaf/internal/vault/models";
import type {
  ConnectionResult,
  SyncSettings,
} from "../bindings/cipherleaf/internal/githubsync/models";
import type { SyncResult } from "../bindings/cipherleaf/internal/app/models";
import { syncFinishedMessage } from "./syncTiming";
import { errorText } from "./errors";
import {
  canonicalObjectDocumentTextFromMarkdown,
  prepareNoteContent,
} from "./objectDocument";
import { targetForMatch, type SearchTarget } from "./searchTarget";

type VaultAction = "create" | "open" | "clone";
type EditorView = "live" | "object" | "markdown";
type SaveState = "idle" | "saving" | "saved" | "error";
type Theme = "light" | "dark";
type WindowLayer = "vaultAction" | "folderPassword" | "appearanceSettings" | "vaultSettings" | "syncConflicts" | "calendar" | "globalSearch" | "appDialog";

const THEME_OPTIONS: { value: Theme; label: string; swatch: string }[] = [
  { value: "light", label: "Light (Nord)", swatch: "light" },
  { value: "dark", label: "Dark (Nord)", swatch: "dark" },
];
type TitlebarMenu = "file";
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

type ConflictResolution = {
  conflict: MergeConflict;
  localNote: Note;
  mergedContent: string;
  cloudHighlightLines: ReadonlySet<number>;
};

const LiveMarkdownEditor = lazy(() => import("./LiveMarkdownEditor"));
const ObjectTreeView = lazy(() => import("./ObjectTreeView"));
const SourceMarkdownEditor = lazy(() => import("./SourceMarkdownEditor"));
const GraphView = lazy(() => import("./GraphView").then(({ GraphView }) => ({ default: GraphView })));

function EditorLoading() {
  return <div className="settings-loading">Loading editor...</div>;
}

const AUTO_LOCK_MS = 15 * 60 * 1000;
const AUTOSAVE_DELAY_MS = 60 * 1000;
const EDITOR_FONT_FAMILY = "CipherleafEditorFont";
const EDITOR_FONT_STORE = "appearance";
const EDITOR_FONT_KEY = "editor-font";

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

function noteForStorage(note: Note): Note {
  return note;
}

function markdownForEditing(content: string): string {
  return prepareNoteContent(content).markdown;
}

function canonicalContentFromMarkdown(markdown: string): string {
  return canonicalObjectDocumentTextFromMarkdown(markdown);
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
  name: "book" | "copy" | "dots" | "eye" | "file" | "folder" | "graph" | "lock" | "plus" | "search" | "trash" | "x" | "menu";
  size?: number;
}) {
  const paths = {
    book: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
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

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [noteTrail, setNoteTrail] = useState<NoteCrumb[]>([]);
  const [backlinks, setBacklinks] = useState<FindMatch[]>([]);
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
  const [graphOpen, setGraphOpen] = useState(false);
  const [titlebarMenu, setTitlebarMenu] = useState<TitlebarMenu | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const consoleEntryIDRef = useRef(0);
  const [appearanceSettingsOpen, setAppearanceSettingsOpen] = useState(false);
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false);
  const [folderPasswordPrompt, setFolderPasswordPrompt] = useState<FolderPasswordPrompt | null>(null);
  const [folderPassword, setFolderPassword] = useState("");
  const [folderPasswordVisible, setFolderPasswordVisible] = useState(false);
  const [appDialog, setAppDialog] = useState<AppDialogState | null>(null);
  const [appDialogValue, setAppDialogValue] = useState("");
  const [syncSettings, setSyncSettings] = useState<SyncSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);
  const [syncLinked, setSyncLinked] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncConflicts, setSyncConflicts] = useState<MergeConflict[]>([]);
  const [autosaveVersion, setAutosaveVersion] = useState(0);
  const [conflictResolution, setConflictResolution] = useState<ConflictResolution | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchReplace, setGlobalSearchReplace] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchReplacement, setGlobalSearchReplacement] = useState("");
  const [globalSearchMatches, setGlobalSearchMatches] = useState<FindMatch[]>([]);
  const [globalSearchBusy, setGlobalSearchBusy] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState("");
  const [globalSearchTarget, setGlobalSearchTarget] = useState<SearchTarget | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [calendarSelected, setCalendarSelected] = useState(() => new Date());
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
  const [editorFontSize, setEditorFontSize] = useState(() => {
    const saved = Number(window.localStorage.getItem("cipherleaf-editor-font-size"));
    return Number.isFinite(saved) && saved >= 10 && saved <= 32 ? saved : 14;
  });
  const initialThemeRef = useRef(true);
  const editorFontInputRef = useRef<HTMLInputElement | null>(null);
  const activeEditorFontRef = useRef<FontFace | null>(null);
  const editVersion = useRef(0);
  const noteRef = useRef<Note | null>(null);
  const noteCaretOffsetsRef = useRef(new Map<string, number>());
  const globalSearchRequestRef = useRef(0);
  const dirtyRef = useRef(false);
  const unlockedRef = useRef(false);
  const dragCandidateRef = useRef<{ kind: "note" | "folder"; id: string; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const folderPasswordResolverRef = useRef<((value: string | null) => void) | null>(null);
  const appDialogResolverRef = useRef<((value: string | boolean | null) => void) | null>(null);
  const nextWindowLayerRef = useRef(160);

  const bringWindowToFront = useCallback((layer: WindowLayer) => {
    nextWindowLayerRef.current += 1;
    setWindowLayers((current) => ({ ...current, [layer]: nextWindowLayerRef.current }));
  }, []);

  useEffect(() => {
    noteRef.current = note;
  }, [note]);

  useEffect(() => {
    const interval = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

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
          timestamp: new Date().toLocaleTimeString(),
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
    if (!note || session?.locked) {
      setBacklinks([]);
      return;
    }
    let active = true;
    VaultService.ListBacklinks(note.id)
      .then((result) => {
        if (active) setBacklinks(result ?? []);
      })
      .catch(() => {
        if (active) setBacklinks([]);
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
    document.documentElement.dataset.editorFont = "custom";
    setEditorFontName(name);
  }, []);

  useEffect(() => {
    let active = true;
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

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const runGlobalSearch = useCallback(async (query: string) => {
    const request = ++globalSearchRequestRef.current;
    const trimmed = query.trim();
    if (!trimmed) {
      setGlobalSearchMatches([]);
      setGlobalSearchBusy(false);
      return;
    }
    setGlobalSearchBusy(true);
    setGlobalSearchError("");
    try {
      const results = await VaultService.FindInNotes(trimmed);
      const folderByID = new Map(folders.map((folder) => [folder.id, folder]));
      if (request !== globalSearchRequestRef.current) return;
      setGlobalSearchMatches(
        (results ?? []).filter(
          (match) => !folderIsLocked(match.folderId, folderByID, unlockedFolderIDs),
        ),
      );
    } catch (reason) {
      if (request !== globalSearchRequestRef.current) return;
      setGlobalSearchError(errorText(reason));
      setGlobalSearchMatches([]);
    } finally {
      if (request === globalSearchRequestRef.current) setGlobalSearchBusy(false);
    }
  }, [folders, unlockedFolderIDs]);

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
      bringWindowToFront("globalSearch");
      setGlobalSearchReplace(isReplace);
      setGlobalSearchOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bringWindowToFront, session?.locked]);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const id = window.setTimeout(() => {
      void runGlobalSearch(globalSearchQuery);
    }, 200);
    return () => window.clearTimeout(id);
  }, [globalSearchOpen, globalSearchQuery, runGlobalSearch]);

  const openGlobalSearchResult = async (match: FindMatch) => {
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

  const runGlobalReplace = async () => {
    if (!globalSearchQuery.trim()) return;
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
    try {
      const result: ReplaceResult = await VaultService.ReplaceAcrossNotes(
        globalSearchQuery,
        globalSearchReplacement,
        noteIDs,
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
    } catch (reason) {
      setGlobalSearchError(errorText(reason));
    } finally {
      setGlobalSearchBusy(false);
    }
  };

  const lastSyncLabel = useMemo(() => {
    if (!lastSyncedAt) return "";
    const then = lastSyncedAt * 1000;
    const diffMs = Math.max(0, nowTick - then);
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 60) {
      if (minutes < 1) return "Last Sync just now";
      return `Last Sync ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `Last Sync ${hours} hour${hours === 1 ? "" : "s"} ago`;
    }
    const date = new Date(then);
    const pad = (n: number) => String(n).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    return `Last Sync at ${year}-${month}-${day} ${hh}:${mm}`;
  }, [lastSyncedAt, nowTick]);

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

  const refreshNotes = async (preferredID?: string) => {
    const result = (await VaultService.ListNotes()) ?? [];
    setNotes(result);
    const targetID = preferredID ?? noteRef.current?.id ?? result[0]?.id;
    if (targetID && result.some((item) => item.id === targetID)) {
      const loaded = await VaultService.GetNote(targetID);
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
      const syncStartedAt = performance.now();
      const result = await VaultService.SyncNow();
      const syncElapsed = performance.now() - syncStartedAt;
      if (import.meta.env.DEV) console.debug("Cipherleaf sync timings", result.timings);
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

  const updateSummary = (saved: Note) => {
    setNotes((current) =>
      current
        .map((item) =>
          item.id === saved.id
            ? {
                ...item,
                id: saved.id,
                title: saved.title,
                folderId: saved.folderId,
                order: saved.order,
                createdAt: saved.createdAt,
                updatedAt: saved.updatedAt,
                modifiedAt: saved.modifiedAt,
                revision: saved.revision,
              }
            : item,
        ),
    );
  };

  const applyLoadedNote = (loaded: Note | null, state: SaveState = "idle") => {
    setGlobalSearchTarget(null);
    if (!loaded) {
      noteRef.current = null;
      dirtyRef.current = false;
      setNote(null);
      setDirty(false);
      setSaveState(state);
      return;
    }
    const prepared = noteForEditing(loaded);
    noteRef.current = prepared.note;
    dirtyRef.current = false;
    setNote(prepared.note);
    setDirty(false);
    setSaveState(state);
  };

  const persistCurrent = async (snapshot = noteRef.current) => {
    if (!snapshot || !dirtyRef.current) return snapshot;
    setSaveState("saving");
    try {
      const version = editVersion.current;
      const stored = noteForStorage(snapshot);
      const saved = await VaultService.SaveNote(
        stored.id,
        stored.title,
        stored.content,
      );
      updateSummary(saved);
      if (version === editVersion.current) {
        const prepared = noteForEditing(saved);
        noteRef.current = prepared.note;
        dirtyRef.current = false;
        setNote(prepared.note);
        setDirty(false);
        setSaveState("saved");
      }
      return noteForEditing(saved).note;
    } catch (reason) {
      setSaveState("error");
      setError(errorText(reason));
      throw reason;
    }
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
      void persistCurrent();
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autosaveVersion, dirty, note?.id]);

  useEffect(() => {
    if (!session || session.locked) return;
    let timer = window.setTimeout(() => void autoLock(), AUTO_LOCK_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void autoLock(), AUTO_LOCK_MS);
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
  }, [session?.vaultId, session?.locked]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || session?.locked) return;
      if (event.key.toLowerCase() === "s" && !event.shiftKey) {
        event.preventDefault();
        void persistCurrent();
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

  useEffect(() => {
    if (!calendarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCalendarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [calendarOpen]);

  const autoLock = async () => {
    try {
      await persistCurrent();
    } catch {
      return;
    }
    const locked = await VaultService.LockVault();
    resetToLocked(locked);
  };

  const resetToLocked = (locked: Session) => {
    unlockedRef.current = false;
    noteCaretOffsetsRef.current.clear();
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
          await VaultService.RememberVaultSecret();
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
        const welcomeContent = canonicalObjectDocumentTextFromMarkdown(
          "# Welcome to your encrypted vault\n\nYour notes are encrypted before they touch the disk.\n\n* Write naturally in **Live Preview**\n* Add _emphasis_, **strong ideas**, and `[[double brackets]]`\n* [ ] Try the interactive checklist\n* Create a note with **Ctrl + N**\n\n> Collapsible project\n> [ ] First task\n>> [ ] Nested task—use Tab and Shift+Tab to change its level\n> [ ] Another task\n\nThis vault locks automatically after 15 minutes of inactivity.",
        );
        const saved = await VaultService.SaveNote(
          first.id,
          first.title,
          welcomeContent,
        );
        await refreshNotes(saved.id);
      } else {
        await refreshNotes();
      }
      if (restoreWarning) setError(restoreWarning);
    } catch (reason) {
      setError(errorText(reason));
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
      const syncStartedAt = performance.now();
      const result: SyncResult = await VaultService.SyncNow();
      const syncElapsed = performance.now() - syncStartedAt;
      if (import.meta.env.DEV) console.debug("Cipherleaf sync timings", result.timings);
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
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSyncing(false);
    }
  };

  async function startConflictResolution(conflict: MergeConflict) {
    setError("");
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
    try {
      const saved = await VaultService.SaveNote(
        conflictResolution.localNote.id,
        conflictResolution.localNote.title,
        canonicalContentFromMarkdown(conflictResolution.mergedContent),
      );
      setConflictResolution(null);
      setSyncConflicts((current) =>
        current.filter((item) => item.localNoteId !== conflictResolution.conflict.localNoteId),
      );
      await refreshNotes(saved.id);
      applyLoadedNote(saved, "saved");
      if (syncLinked) {
        await syncNow();
      }
    } catch (reason) {
      setSaveState("error");
      setError(errorText(reason));
    }
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
    try {
      await persistCurrent();
      const result = await VaultService.ForcePushNow();
      setSyncConflicts([]);
      const settings = await VaultService.GetSyncSettings();
      setLastSyncedAt(settings.lastSyncedAt);
      setSaveState("saved");
      setError(result.warning || result.message || "Local vault force-pushed to cloud.");
    } catch (reason) {
      setError(errorText(reason));
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
    try {
      await persistCurrent();
      resetToLocked(await VaultService.LockVault());
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

  const createNote = async () => {
    setError("");
    try {
      await persistCurrent();
      const targetFolder = selectedFolderID === "all" ? "" : selectedFolderID;
      const created = await VaultService.CreateNoteInFolder("Untitled", targetFolder);
      const result = (await VaultService.ListNotes()) ?? [];
      setNotes(result);
      applyLoadedNote(created);
      setSidebarOpen(false);
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
    setSelectedFolderID(folder.id);
  };

  const selectNote = async (
    id: string,
    options: { appendTrail?: boolean; replaceTrail?: NoteCrumb[] } = {},
  ) => {
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

  const deleteNote = async (id = note?.id, title = note?.title) => {
    if (!id) return;
    if (
      !(await requestAppConfirm({
        kind: "confirm",
        eyebrow: "Delete note",
        title: "Delete note",
        message: `Delete “${title || "Untitled"}”? This cannot be undone.`,
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
    if (syncState) {
      setNote(next);
    }
  };

  const syncDraftNote = () => {
    const draft = noteRef.current;
    if (draft) setNote(draft);
  };

  const setEditorView = (nextView: EditorView) => {
    syncDraftNote();
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

  const currentFolder = useMemo(
    () => folders.find((folder) => folder.id === note?.folderId),
    [folders, note?.folderId],
  );

  const noteMarkdown = useMemo(
    () => note ? markdownForEditing(note.content) : "",
    [note?.content],
  );

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

  const calendarTitle = calendarMonth.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const compactDay = String(today.getDate()).padStart(2, "0");
  const compactMonth = today.toLocaleDateString(undefined, { month: "short" }).toUpperCase();

  const openWikilinkTitle = async (title: string) => {
    try {
      const linked = await VaultService.ResolveNoteReference(title);
      await selectNote(linked.id, { appendTrail: true });
    } catch {
      setError(`No note named “${title}” exists yet.`);
    }
  };

  const openVaultSettings = async () => {
    setTitlebarMenu(null);
    bringWindowToFront("vaultSettings");
    setVaultSettingsOpen(true);
    setSyncSettings(null);
    setSettingsBusy(true);
    setConnectionResult(null);
    setError("");
    try {
      const settings = await VaultService.GetSyncSettings();
      setSyncSettings(settings);
      setSyncLinked(settings.linked);
      setLastSyncedAt(settings.lastSyncedAt);
    } catch (reason) {
      setVaultSettingsOpen(false);
      setError(errorText(reason));
    } finally {
      setSettingsBusy(false);
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

  const resetEditorFont = async () => {
    try {
      if (activeEditorFontRef.current) {
        document.fonts.delete(activeEditorFontRef.current);
        activeEditorFontRef.current = null;
      }
      delete document.documentElement.dataset.editorFont;
      setEditorFontName("");
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
    try {
      setConnectionResult(await VaultService.TestGitHubConnection(syncSettings));
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings.branch,
      });
    } finally {
      setSettingsBusy(false);
    }
  };

  const linkGitHubVault = async () => {
    if (!syncSettings) return;
    setSettingsBusy(true);
    setConnectionResult(null);
    try {
      await persistCurrent();
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
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings.branch,
      });
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
    try {
      await persistCurrent();
      const result: SyncResult = await VaultService.PullAndLinkGitHubVault(syncSettings);
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
    } catch (reason) {
      setConnectionResult({
        success: false,
        message: errorText(reason),
        warning: "",
        branch: syncSettings.branch,
      });
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

  if (session === null) {
    return (
      <main className="loading-screen">
        <div className="brand-glyph"><img src="/cipherleaf-logo.png" alt="" /></div>
        <p>Preparing your vault…</p>
      </main>
    );
  }

  if (session.locked) {
    return (
      <main className="welcome-screen">
        <section className="welcome-card">
          <div className="brand-row">
            <div className="brand-glyph"><img src="/cipherleaf-logo.png" alt="" /></div>
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
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
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
                  void persistCurrent();
                }}>
                  Save file <kbd>Ctrl + S</kbd>
                </button>
                <button role="menuitem" disabled={!note || saveState === "saving" || syncing || !syncLinked} onClick={() => {
                  setTitlebarMenu(null);
                  void saveAndSync();
                }}>
                  Save file and sync <kbd>Ctrl + Shift + S</kbd>
                </button>
                <div className="titlebar-menu-separator" />
                <button role="menuitem" disabled={!syncLinked || syncing} title={!syncLinked ? "Link this vault in Vault Settings first" : syncing ? "Syncing…" : "Pull then push the vault to GitHub"} onClick={() => {
                  setTitlebarMenu(null);
                  void syncNow();
                }}>
                  Sync vault <kbd>Ctrl + Shift + R</kbd>
                </button>
                <button role="menuitem" onClick={() => {
                  setTitlebarMenu(null);
                  bringWindowToFront("appearanceSettings");
                  setAppearanceSettingsOpen(true);
                }}>
                  Settings…
                </button>
                <button role="menuitem" onClick={() => void openVaultSettings()}>
                  Vault Settings…
                </button>
                <button role="menuitem" onClick={() => {
                  setTitlebarMenu(null);
                  setLogOpen(true);
                }}>
                  Log
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
                <div className="titlebar-menu-separator" />
                <button role="menuitem" onClick={() => void closeApplication()}>
                  Close application
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
          <div className="brand-glyph small"><img src="/cipherleaf-logo.png" alt="" /></div>
          <div>
            <strong>Cipherleaf</strong>
            <span>{folderName(session.path)}</span>
          </div>
          <button
            type="button"
            className="calendar-button"
            aria-label={`Open calendar for ${today.toLocaleDateString(undefined, { dateStyle: "full" })}`}
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
        <button
          type="button"
          className={`graph-view-button ${graphOpen ? "active" : ""}`}
          onClick={() => {
            setGraphOpen(true);
            setSidebarOpen(false);
          }}
        >
          <Icon name="graph" size={16} />
          <span>Graph view</span>
        </button>
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
          <select
            className="notes-sort-select"
            value={currentSortMode}
            onChange={(event) => setCurrentSortMode(event.target.value)}
            aria-label="Sort notes"
          >
            <option value="manual">Manual</option>
            <option value="title">Title</option>
            <option value="updated">Updated</option>
            <option value="created">Created</option>
          </select>
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
                <small>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
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
                {(recentVaultPaths.includes(session.path)
                  ? recentVaultPaths
                  : [...recentVaultPaths, session.path]
                ).slice(-5).map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="menuitem"
                    className={path === session.path ? "active" : ""}
                    title={path}
                    onClick={() => void openRecentVault(path)}
                  >
                    {folderName(path)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>

      <section className="editor-shell">
        <header className="editor-topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <Icon name="menu" />
          </button>
          <div className="breadcrumbs">
            {graphOpen ? (
              <span className="breadcrumb-item"><strong>Graph view</strong></span>
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
          <button
            className="save-file-button"
            disabled={graphOpen || (!note && !conflictResolution) || (!conflictResolution && !dirty) || saveState === "saving"}
            title={conflictResolution ? "Save the merged conflict result" : !note ? "No note open" : "Save this note (Ctrl + S)"}
            onClick={() => conflictResolution ? void saveResolvedConflict() : void persistCurrent()}
          >
            {saveState === "saving" ? "Encrypting…" : conflictResolution ? "Save merged file" : "Save file"}
          </button>
          <div className={`sync-status ${syncLinked ? "linked" : "not-linked"}`}>
            <span />
            {syncLinked ? "Linked" : "Not linked"}
          </div>
          <button
            className="save-and-sync-button"
            disabled={graphOpen || !note || !!conflictResolution || saveState === "saving" || syncing || !syncLinked}
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
          {syncLinked && lastSyncLabel && (
            <span className="last-sync-label" title="Time of the last successful sync">
              {lastSyncLabel}
            </span>
          )}
          {note && !graphOpen && (
            <button className="icon-button delete-button" onClick={() => void deleteNote()} aria-label="Delete note" title="Delete note">
              <Icon name="trash" size={16} />
            </button>
          )}
        </header>

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

        {graphOpen ? (
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
            <div className="document-heading">
              <input
                className="title-input"
                value={note.title}
                onChange={(event) => editNote({ title: event.target.value })}
                placeholder="Untitled"
                aria-label="Note title"
              />
              <p>
                Edited {new Date(note.updatedAt).toLocaleString(undefined, {
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            </div>
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
            <Suspense fallback={<EditorLoading />}>
              <div className={`document-body view-${view}`}>
                {view === "live" && (
                  <div className="editor-view-pane active">
                    <LiveMarkdownEditor
                      key={note.id}
                      noteID={note.id}
                      value={noteMarkdown}
                      onChange={(content) => editNote({ content: canonicalContentFromMarkdown(content) })}
                      onSave={() => void persistCurrent()}
                      onError={(reason) => setError(errorText(reason))}
                      onOpenWikilink={(title) => void openWikilinkTitle(title)}
                      onDecreaseFontSize={decreaseEditorFontSize}
                      onIncreaseFontSize={increaseEditorFontSize}
                      searchTarget={globalSearchTarget}
                      onSearchTargetApplied={() => setGlobalSearchTarget(null)}
                      caretOffset={noteCaretOffsetsRef.current.get(note.id) ?? 0}
                      onCaretChange={(offset) => noteCaretOffsetsRef.current.set(note.id, offset)}
                    />
                  </div>
                )}
                {view === "object" && (
                  <div className="editor-view-pane active">
                    <ObjectTreeView value={note.content} onChange={(content) => editNote({ content: canonicalContentFromMarkdown(content) }, true)} />
                  </div>
                )}
                {view === "markdown" && (
                  <div className="editor-view-pane active">
                    <SourceMarkdownEditor
                      key={note.id}
                      noteID={note.id}
                      value={noteMarkdown}
                      onChange={(content) => editNote({ content: canonicalContentFromMarkdown(content) })}
                      onError={(reason) => setError(errorText(reason))}
                    />
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
            <h2 id="appearance-settings-title">Appearance</h2>

            <fieldset className="appearance-fieldset">
              <legend>Theme</legend>
              <div className="appearance-theme-options">
                {THEME_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={theme === item.value ? "active" : ""}
                    aria-pressed={theme === item.value}
                    onClick={() => setTheme(item.value)}
                  >
                    <span className={`theme-swatch ${item.swatch}`} />
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <label>
              Font
              <div className="appearance-font-row">
                <span title={editorFontName}>
                  {editorFontName || "Default (Georgia)"}
                </span>
                {editorFontName && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void resetEditorFont()}
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => editorFontInputRef.current?.click()}
                >
                  Select .ttf…
                </button>
                <input
                  ref={editorFontInputRef}
                  className="appearance-font-input"
                  type="file"
                  accept=".ttf,font/ttf"
                  onChange={(event) => void chooseEditorFont(event)}
                />
              </div>
            </label>

            <label>
              Font size
              <div className="appearance-size-row">
                <input
                  type="range"
                  min="10"
                  max="32"
                  step="1"
                  value={editorFontSize}
                  onChange={(event) => setEditorFontSize(Number(event.target.value))}
                />
                <output>{editorFontSize}px</output>
              </div>
            </label>
            <p className="appearance-help">
              Download and extract a Nerd Font, then select one of its .ttf files.
            </p>
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
                      {new Date(2000, month, 1).toLocaleDateString(undefined, { month: "long" })}
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
                <span key={day}>{new Date(2023, 0, day + 1).toLocaleDateString(undefined, { weekday: "narrow" })}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {calendarDays.map(({ date, inMonth }) => (
                <button
                  type="button"
                  key={date.toISOString()}
                  className={`calendar-day${inMonth ? "" : " outside-month"}${isSameDay(date, today) ? " today" : ""}${isSameDay(date, calendarSelected) ? " selected" : ""}`}
                  aria-label={date.toLocaleDateString(undefined, { dateStyle: "full" })}
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
              <span>{calendarSelected.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
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
                placeholder="Find in all notes"
                value={globalSearchQuery}
                onChange={(event) => setGlobalSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setGlobalSearchOpen(false);
                  }
                }}
                autoFocus
              />
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
                  disabled={globalSearchBusy || !globalSearchQuery.trim()}
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
