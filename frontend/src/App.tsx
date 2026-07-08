import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
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
import { errorText } from "./errors";
import LiveMarkdownEditor from "./LiveMarkdownEditor";
import ObjectTreeView from "./ObjectTreeView";
import SourceMarkdownEditor from "./SourceMarkdownEditor";

type VaultAction = "create" | "open" | "clone";
type EditorView = "live" | "object" | "markdown";
type SaveState = "idle" | "saving" | "saved" | "error";
type Theme = "light" | "dark";

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

type NoteCrumb = {
  id: string;
  title: string;
};

const AUTO_LOCK_MS = 15 * 60 * 1000;
const AUTOSAVE_DELAY_MS = 10 * 1000;
const EDITOR_FONT_FAMILY = "CipherleafEditorFont";
const EDITOR_FONT_STORE = "appearance";
const EDITOR_FONT_KEY = "editor-font";

type StoredEditorFont = {
  name: string;
  data: ArrayBuffer;
};

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
  name: "book" | "copy" | "dots" | "eye" | "file" | "folder" | "lock" | "plus" | "search" | "trash" | "x" | "menu";
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
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [globalSortMode, setGlobalSortMode] = useState(() => window.localStorage.getItem("cipherleaf-sort-all") || "manual");
  const [unfiledSortMode, setUnfiledSortMode] = useState(() => window.localStorage.getItem("cipherleaf-sort-unfiled") || "manual");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [view, setView] = useState<EditorView>("live");
  const [vaultAction, setVaultAction] = useState<VaultAction | null>(null);
  const [vaultPath, setVaultPath] = useState("");
  const [lastVaultPath, setLastVaultPath] = useState("");
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [titlebarMenu, setTitlebarMenu] = useState<TitlebarMenu | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const consoleEntryIDRef = useRef(0);
  const [appearanceSettingsOpen, setAppearanceSettingsOpen] = useState(false);
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false);
  const [folderPasswordPrompt, setFolderPasswordPrompt] = useState<FolderPasswordPrompt | null>(null);
  const [folderPassword, setFolderPassword] = useState("");
  const [folderPasswordVisible, setFolderPasswordVisible] = useState(false);
  const [syncSettings, setSyncSettings] = useState<SyncSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);
  const [syncLinked, setSyncLinked] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncConflicts, setSyncConflicts] = useState<MergeConflict[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchReplace, setGlobalSearchReplace] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchReplacement, setGlobalSearchReplacement] = useState("");
  const [globalSearchMatches, setGlobalSearchMatches] = useState<FindMatch[]>([]);
  const [globalSearchBusy, setGlobalSearchBusy] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState("");
  const [scrollToOffset, setScrollToOffset] = useState<number | null>(null);
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
  const sidebarSearchRef = useRef<HTMLInputElement | null>(null);
  const editVersion = useRef(0);
  const noteRef = useRef<Note | null>(null);
  const dirtyRef = useRef(false);
  const unlockedRef = useRef(false);
  const dragCandidateRef = useRef<{ kind: "note" | "folder"; id: string; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const folderPasswordResolverRef = useRef<((value: string | null) => void) | null>(null);

  useEffect(() => {
    noteRef.current = note;
    dirtyRef.current = dirty;
  }, [note, dirty]);

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
    const trimmed = query.trim();
    if (!trimmed) {
      setGlobalSearchMatches([]);
      return;
    }
    setGlobalSearchBusy(true);
    setGlobalSearchError("");
    try {
      const results = await VaultService.FindInNotes(trimmed);
      setGlobalSearchMatches(results ?? []);
    } catch (reason) {
      setGlobalSearchError(errorText(reason));
      setGlobalSearchMatches([]);
    } finally {
      setGlobalSearchBusy(false);
    }
  }, []);

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
        setSidebarOpen(true);
        window.setTimeout(() => sidebarSearchRef.current?.focus(), 0);
        return;
      }
      setGlobalSearchReplace(isReplace);
      setGlobalSearchOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session?.locked]);

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
        const fresh = await VaultService.GetNote(match.noteId);
        setNote(fresh);
        noteRef.current = fresh;
        setDirty(false);
        const summaries = await VaultService.ListNotes();
        if (summaries) {
          setNotes(summaries);
        }
      }
      if (match.field === "content") {
        setScrollToOffset(match.offset);
        window.setTimeout(() => setScrollToOffset(null), 500);
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const runGlobalReplace = async () => {
    if (!globalSearchQuery.trim()) return;
    const noteIDs = Array.from(new Set(globalSearchMatches.map((m) => m.noteId)));
    const confirmMessage =
      noteIDs.length === 0
        ? `Replace "${globalSearchQuery}" with "${globalSearchReplacement}" across every note?`
        : `Replace "${globalSearchQuery}" with "${globalSearchReplacement}" in ${noteIDs.length} note${noteIDs.length === 1 ? "" : "s"}?`;
    if (!window.confirm(confirmMessage)) return;
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
          setNote(fresh);
          noteRef.current = fresh;
          setDirty(false);
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

  const refreshNotes = async (preferredID?: string) => {
    const result = (await VaultService.ListNotes()) ?? [];
    setNotes(result);
    const targetID = preferredID ?? noteRef.current?.id ?? result[0]?.id;
    if (targetID && result.some((item) => item.id === targetID)) {
      const loaded = await VaultService.GetNote(targetID);
      setNote(loaded);
      setDirty(false);
      setSaveState("idle");
    } else {
      setNote(null);
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
    try {
      const result = await VaultService.SyncNow();
      if (result.warning) setError(result.warning);
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

  const persistCurrent = async (snapshot = noteRef.current) => {
    if (!snapshot || !dirtyRef.current) return snapshot;
    setSaveState("saving");
    try {
      const version = editVersion.current;
      const saved = await VaultService.SaveNote(
        snapshot.id,
        snapshot.title,
        snapshot.content,
      );
      updateSummary(saved);
      if (version === editVersion.current) {
        noteRef.current = saved;
        dirtyRef.current = false;
        setNote(saved);
        setDirty(false);
        setSaveState("saved");
      }
      return saved;
    } catch (reason) {
      setSaveState("error");
      setError(errorText(reason));
      throw reason;
    }
  };

  useEffect(() => {
    if (!dirty || !note) return;
    const snapshot = note;
    const timer = window.setTimeout(() => {
      void persistCurrent(snapshot);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, note?.id, note?.title, note?.content]);

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
    setUnlockedFolderIDs(new Set());
    setSession(locked);
    setFolders([]);
    setNotes([]);
    setNote(null);
    setSelectedFolderID("all");
    setContextMenu(null);
    setDirty(false);
    setQuery("");
    setRememberError("");
    setSidebarOpen(false);
    setSaveState("idle");
    setSyncLinked(false);
    setLastSyncedAt(0);
  };

  const prepareVaultPrompt = async (action: VaultAction, path: string) => {
    setVaultPath(path);
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
        const saved = await VaultService.SaveNote(
          first.id,
          first.title,
          "# Welcome to your encrypted vault\n\nYour notes are encrypted before they touch the disk.\n\n* Write naturally in **Live Preview**\n* Add _emphasis_, **strong ideas**, and `[[double brackets]]`\n* [ ] Try the interactive checklist\n* Create a note with **Ctrl + N**\n\n> Collapsible project\n> [ ] First task\n>> [ ] Nested task—use Tab and Shift+Tab to change its level\n> [ ] Another task\n\nThis vault locks automatically after 15 minutes of inactivity.",
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
    try {
      await persistCurrent();
      const result: SyncResult = await VaultService.SyncNow();
      await refreshNotes();
      await refreshFolders();
      const note = noteRef.current;
      if (note) {
        try {
          const fresh = await VaultService.GetNote(note.id);
          setNote(fresh);
          noteRef.current = fresh;
          setDirty(false);
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
      }
      if (result.merge.conflicts?.length) {
        setSyncConflicts(result.merge.conflicts);
      }
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
    const newName = window.prompt("Rename vault folder to:", currentName);
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
    try {
      await persistCurrent();
      await VaultService.QuitApplication();
    } catch {
      // persistCurrent already presents the actionable error.
    }
  };

  const createNote = async () => {
    setError("");
    try {
      await persistCurrent();
      const targetFolder = selectedFolderID === "all" ? "" : selectedFolderID;
      const created = await VaultService.CreateNoteInFolder("Untitled", targetFolder);
      const result = (await VaultService.ListNotes()) ?? [];
      setNotes(result);
      setNote(created);
      setDirty(false);
      setSaveState("idle");
      setSidebarOpen(false);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const createFolder = async () => {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    setError("");
    try {
      const created = await VaultService.CreateFolder(name);
      await refreshFolders();
      setSelectedFolderID(created.id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const renameFolder = async (folder: Folder) => {
    const name = window.prompt("Rename folder", folder.name);
    if (!name?.trim() || name.trim() === folder.name) return;
    setError("");
    try {
      await VaultService.RenameFolder(folder.id, name);
      await refreshFolders();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const deleteFolder = async (folder: Folder) => {
    if (!window.confirm(`Delete the empty folder “${folder.name}”?`)) return;
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
      if (selectedFolderID === folder.id) setSelectedFolderID("all");
      await refreshFolders();
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

  const selectFolder = async (folder: Folder) => {
    if (folder.locked && !unlockedFolderIDs.has(folder.id)) {
      const password = await requestFolderPassword(`Unlock “${folder.name}”`, "Unlock folder");
      if (password === null) return;
      try {
        await VaultService.CheckFolderPassword(folder.id, password);
        setUnlockedFolderIDs((current) => new Set(current).add(folder.id));
      } catch (reason) {
        setError(errorText(reason));
        return;
      }
    }
    setSelectedFolderID(folder.id);
    setQuery("");
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
      const loaded = await VaultService.GetNote(id);
      const folder = folderByID.get(loaded.folderId);
      if (folder?.locked && !unlockedFolderIDs.has(folder.id)) {
        const password = await requestFolderPassword(`Unlock “${folder.name}”`, "Unlock folder");
        if (password === null) return;
        try {
          await VaultService.CheckFolderPassword(folder.id, password);
          setUnlockedFolderIDs((current) => new Set(current).add(folder.id));
        } catch (reason) {
          setError(errorText(reason));
          return;
        }
      }
      setNote(loaded);
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
      setDirty(false);
      setSaveState("idle");
      setSidebarOpen(false);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const deleteNote = async (id = note?.id, title = note?.title) => {
    if (!id || !window.confirm(`Delete “${title || "Untitled"}”? This cannot be undone.`)) return;
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
        setNote(next ? await VaultService.GetNote(next.id) : null);
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
        setNote(moved);
        setDirty(false);
        setSaveState("saved");
      }
      if (query) setNotes((await VaultService.SearchNotes(query)) ?? []);
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
        setNote(await VaultService.GetNote(id));
        setDirty(false);
        setSaveState("saved");
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

  const editNote = (patch: Partial<Pick<Note, "title" | "content">>) => {
    setNote((current) => (current ? { ...current, ...patch } : current));
    editVersion.current++;
    setDirty(true);
    setSaveState("idle");
  };

  useEffect(() => {
    if (!session || session.locked) return;
    let active = true;
    const timer = window.setTimeout(() => {
      VaultService.SearchNotes(query)
        .then((result) => {
          if (active && unlockedRef.current) setNotes(result ?? []);
        })
        .catch((reason) => {
          if (active && unlockedRef.current) setError(errorText(reason));
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, session?.locked, session?.vaultId]);

  const folderByID = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );

  const publicNotes = useMemo(
    () => notes.filter((item) => {
      if (!item.folderId) return true;
      const folder = folderByID.get(item.folderId);
      return !folder?.hidden && (!folder?.locked || unlockedFolderIDs.has(item.folderId));
    }),
    [folderByID, notes, unlockedFolderIDs],
  );

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
    if (query.trim() || selectedFolderID === "all") return sortNotesForMode(tagged, globalSortMode);
    return sortNotesForFolder(
      notes.filter((item) => item.folderId === selectedFolderID),
      selectedFolderID,
    ).filter((item) => !selectedTag || (item.tags ?? []).includes(selectedTag));
  }, [globalSortMode, notes, publicNotes, query, selectedFolderID, selectedTag, sortNotesForFolder, sortNotesForMode]);

  const currentFolder = folders.find((folder) => folder.id === note?.folderId);

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

  const unlinkGitHubSync = async () => {
    if (!window.confirm("Remove this vault’s GitHub settings from this device? The local vault, SSH key, and repository will not be deleted.")) {
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
          <div className="modal-backdrop" role="presentation">
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
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">
            <Icon name="x" />
          </button>
        </div>
        <div className="search-box">
          <Icon name="search" size={16} />
          <input
            ref={sidebarSearchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search encrypted notes"
            aria-label="Search notes"
          />
          <kbd>⌘ K</kbd>
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
              setSelectedFolderID("all");
              setQuery("");
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
              setSelectedFolderID("");
              setQuery("");
            }}
            onMouseEnter={(event) => {
              if (event.buttons === 1 && dragCandidateRef.current?.kind === "note") activatePointerDrag("folder:");
            }}
            onMouseUp={() => finishPointerDrag({ kind: "folder", id: "" })}
          >
            <Icon name="folder" size={15} />
            <span>Unfiled</span>
            <small>{publicNotes.filter((item) => !item.folderId).length}</small>
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              className={`folder-list-item ${selectedFolderID === folder.id ? "active" : ""} ${dropTarget === `folder:${folder.id}` ? "drag-over" : ""} ${dropTarget === `folder:${folder.id}:before` ? "drag-over-before" : ""} ${dropTarget === `folder:${folder.id}:after` ? "drag-over-after" : ""}`}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                void selectFolder(folder);
              }}
              onMouseDown={(event) => {
                if (event.button === 0 && !query) {
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
              <Icon name={folder.locked && !unlockedFolderIDs.has(folder.id) ? "lock" : "folder"} size={15} />
              <span>{folder.name}</span>
              <small>{folder.locked && !unlockedFolderIDs.has(folder.id) ? "Locked" : notes.filter((item) => item.folderId === folder.id).length}</small>
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
            {query
              ? "Search results"
              : selectedFolderID === "all"
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
                void selectNote(item.id);
              }}
              onMouseDown={(event) => {
                if (event.button === 0 && !query) {
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
              <p>{query ? "No notes match your search." : "This folder is empty."}</p>
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="encrypted-status"><span /> Encrypted locally</div>
          <button className="lock-button" onClick={() => void lockVault()}>
            <Icon name="lock" size={15} /> Lock vault
          </button>
        </div>
      </aside>

      <section className="editor-shell">
        <header className="editor-topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <Icon name="menu" />
          </button>
          <div className="breadcrumbs">
            {(noteTrail.length ? noteTrail : [
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
            disabled={!note || !dirty || saveState === "saving"}
            title={!note ? "No note open" : "Save this note (Ctrl + S)"}
            onClick={() => void persistCurrent()}
          >
            {saveState === "saving" ? "Encrypting…" : "Save file"}
          </button>
          <div className={`sync-status ${syncLinked ? "linked" : "not-linked"}`}>
            <span />
            {syncLinked ? "Linked" : "Not linked"}
          </div>
          <button
            className="save-and-sync-button"
            disabled={!note || saveState === "saving" || syncing || !syncLinked}
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
          {note && (
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

        {note ? (
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
                  onClick={() => setView(item)}
                >
                  {item === "live"
                    ? "Live Preview"
                    : item === "object"
                      ? "Object Tree"
                      : "Markdown"}
                </button>
              ))}
            </div>
            <div className={`document-body view-${view}`}>
              <div className={`editor-view-pane ${view === "live" ? "active" : ""}`}>
                <LiveMarkdownEditor
                  key={note.id}
                  noteID={note.id}
                  value={note.content}
                  onChange={(content) => editNote({ content })}
                  onSave={() => void persistCurrent()}
                  onError={(reason) => setError(errorText(reason))}
                  onOpenWikilink={(title) => void openWikilinkTitle(title)}
                  onDecreaseFontSize={decreaseEditorFontSize}
                  onIncreaseFontSize={increaseEditorFontSize}
                  scrollToOffset={scrollToOffset}
                />
              </div>
              <div className={`editor-view-pane ${view === "object" ? "active" : ""}`}>
                <ObjectTreeView value={note.content} />
              </div>
              <div className={`editor-view-pane ${view === "markdown" ? "active" : ""}`}>
                <SourceMarkdownEditor
                  key={note.id}
                  noteID={note.id}
                  value={note.content}
                  onChange={(content) => editNote({ content })}
                  onError={(reason) => setError(errorText(reason))}
                />
              </div>
            </div>
            <footer className="document-footer">
              <span>{note.content.trim() ? note.content.trim().split(/\s+/).length : 0} words</span>
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
        <div className="modal-backdrop" role="presentation">
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
        <div className="modal-backdrop" role="presentation">
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
        <div className="modal-backdrop" role="presentation">
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
                        void setFolderHidden(folder, !folder.hidden);
                      }}
                    >
                      <Icon name="eye" size={14} />
                      {folder.hidden ? "Show notes" : "Hide notes"}
                    </button>
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
        <div className="modal-backdrop" role="presentation">
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
                    void selectNote(conflict.remoteNoteId);
                  }}
                >
                  <strong>{conflict.title}</strong>
                  <span>{conflict.message}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {globalSearchOpen && (
        <div
          className="global-search-scrim"
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
    </main>
  );
}

export default App;
