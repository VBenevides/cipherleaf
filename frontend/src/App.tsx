import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { VaultService } from "../bindings/cipherleaf";
import type {
  FindMatch,
  Folder,
  Note,
  NoteSummary,
  ReplaceResult,
  Session,
} from "../bindings/cipherleaf/internal/vault/models";
import type {
  ConnectionResult,
  SyncSettings,
} from "../bindings/cipherleaf/internal/githubsync/models";
import type { SyncResult } from "../bindings/cipherleaf/models";
import { errorText } from "./errors";import LiveMarkdownEditor from "./LiveMarkdownEditor";
import NotionOutlinePreview from "./NotionOutlinePreview";

type VaultAction = "create" | "open" | "clone";
type EditorView = "live" | "write" | "preview" | "split";
type SaveState = "idle" | "saving" | "saved" | "error";
type Theme = "light" | "dark";

const THEME_OPTIONS: { value: Theme; label: string; swatch: string }[] = [
  { value: "light", label: "Light (Nord)", swatch: "light" },
  { value: "dark", label: "Dark (Nord)", swatch: "dark" },
];
type TitlebarMenu = "file" | "view";
type ContextMenuState =
  | { kind: "note"; id: string; label: string; x: number; y: number }
  | { kind: "folder"; id: string; label: string; x: number; y: number };

const AUTO_LOCK_MS = 15 * 60 * 1000;
const AUTOSAVE_DELAY_MS = 10 * 1000;

function Icon({
  name,
  size = 18,
}: {
  name: "book" | "copy" | "dots" | "file" | "folder" | "lock" | "plus" | "search" | "trash" | "x" | "menu";
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
  const [selectedFolderID, setSelectedFolderID] = useState("all");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<EditorView>("live");
  const [vaultAction, setVaultAction] = useState<VaultAction | null>(null);
  const [vaultPath, setVaultPath] = useState("");
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
  const [titlebarMenu, setTitlebarMenu] = useState<TitlebarMenu | null>(null);
  const [viewThemeOpen, setViewThemeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncSettings, setSyncSettings] = useState<SyncSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);
  const [syncLinked, setSyncLinked] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
  const initialThemeRef = useRef(true);
  const sidebarSearchRef = useRef<HTMLInputElement | null>(null);
  const editVersion = useRef(0);
  const noteRef = useRef<Note | null>(null);
  const dirtyRef = useRef(false);
  const unlockedRef = useRef(false);

  useEffect(() => {
    noteRef.current = note;
    dirtyRef.current = dirty;
  }, [note, dirty]);

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
          await refreshFolders();
          await refreshNotes();
          return;
        }
        try {
          const autoUnlocked = await VaultService.TryUnlockRemembered();
          unlockedRef.current = !autoUnlocked.locked;
          setSession(autoUnlocked);
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
          setVaultAction("open");
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

  const updateSummary = (saved: Note) => {
    setNotes((current) =>
      current
        .map((item) =>
          item.id === saved.id
            ? {
                id: saved.id,
                title: saved.title,
                folderId: saved.folderId,
                createdAt: saved.createdAt,
                updatedAt: saved.updatedAt,
                modifiedAt: saved.modifiedAt,
                revision: saved.revision,
              }
            : item,
        )
        .sort((left, right) => left.title.localeCompare(right.title)),
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
  }, [session?.locked, selectedFolderID, syncLinked]);

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
      setViewThemeOpen(false);
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
    if (path) await prepareVaultPrompt(action, path);
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
      let linkedOnOpen = false;
      if (completedAction === "clone") {
        linkedOnOpen = true;
      } else {
        try {
          const openedSettings = await VaultService.GetSyncSettings();
          linkedOnOpen = openedSettings.linked;
          setLastSyncedAt(openedSettings.lastSyncedAt);
        } catch {
          linkedOnOpen = false;
          setLastSyncedAt(0);
        }
      }
      setSyncLinked(linkedOnOpen);
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
      await refreshFolders();
      if (completedAction === "create") {
        const first = await VaultService.CreateNote("Welcome");
        const saved = await VaultService.SaveNote(
          first.id,
          first.title,
          "# Welcome to your encrypted vault\n\nYour notes are encrypted before they touch the disk.\n\n* Write naturally in **Live Preview**\n* Add _emphasis_, **strong ideas**, and `[[double brackets]]`\n* [ ] Try the interactive checklist\n* Create a note with **Ctrl + N**\n\n> Collapsible project\n>> [ ] First task\n>>> [ ] Nested task—use Tab and Shift+Tab to change its level\n>> [ ] Another task\n\nThis vault locks automatically after 15 minutes of inactivity.",
        );
        await refreshNotes(saved.id);
      } else {
        await refreshNotes();
      }
      if (linkedOnOpen && completedAction !== "create") {
        setSyncing(true);
        try {
          await VaultService.PullNow();
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
              // note may have been replaced by the merge; refresh will resync
            }
          }
        } catch {
          // offline or unreachable: stay on local data, user can sync manually
        } finally {
          setSyncing(false);
        }
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
      setError("Link this vault to GitHub in Settings before syncing.");
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

  const selectNote = async (id: string) => {
    if (note?.id === id) {
      setSidebarOpen(false);
      return;
    }
    setError("");
    try {
      await persistCurrent();
      const loaded = await VaultService.GetNote(id);
      setNote(loaded);
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
      updateSummary(moved);
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

  const visibleNotes = useMemo(
    () =>
      query.trim() || selectedFolderID === "all"
        ? notes
        : notes.filter((item) => item.folderId === selectedFolderID),
    [notes, query, selectedFolderID],
  );

  const currentFolder = folders.find((folder) => folder.id === note?.folderId);

  const openWikilinkTitle = async (title: string) => {
    const matches = (await VaultService.SearchNotes(title)) ?? [];
    const linked = matches.find(
      (item) => item.title.toLocaleLowerCase() === title.toLocaleLowerCase(),
    );
    if (linked) await selectNote(linked.id);
    else setError(`No note named “${title}” exists yet.`);
  };

  const openSettings = async () => {
    setTitlebarMenu(null);
    setSettingsOpen(true);
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
      setSettingsOpen(false);
      setError(errorText(reason));
    } finally {
      setSettingsBusy(false);
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
        <div className="brand-glyph"><Icon name="book" size={26} /></div>
        <p>Preparing your vault…</p>
      </main>
    );
  }

  if (session.locked) {
    return (
      <main className="welcome-screen">
        <section className="welcome-card">
          <div className="brand-row">
            <div className="brand-glyph"><Icon name="book" size={26} /></div>
            <span>Cipherleaf</span>
          </div>
          <p className="eyebrow">Local-first · end-to-end encrypted</p>
          <h1>Your thoughts,<br /><em>kept yours.</em></h1>
          <p className="welcome-copy">
            A quiet Markdown workspace where every title, note, and link is encrypted
            locally before it reaches disk.
          </p>
          <div className="welcome-actions">
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
    <main className="workspace">
      <header className="app-menubar">
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
                setViewThemeOpen(false);
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
                <button role="menuitem" disabled={!syncLinked || syncing} title={!syncLinked ? "Link this vault in Settings first" : syncing ? "Syncing…" : "Pull then push the vault to GitHub"} onClick={() => {
                  setTitlebarMenu(null);
                  void syncNow();
                }}>
                  Sync vault <kbd>Ctrl + Shift + R</kbd>
                </button>
                <button role="menuitem" onClick={() => void openSettings()}>
                  Settings…
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
          <div className="titlebar-menu">
            <button
              className={titlebarMenu === "view" ? "active" : ""}
              aria-haspopup="menu"
              aria-expanded={titlebarMenu === "view"}
              onClick={() => {
                setViewThemeOpen(false);
                setTitlebarMenu((current) => current === "view" ? null : "view")
              }}
            >
              View
            </button>
            {titlebarMenu === "view" && (
              <div className="titlebar-menu-popover view-menu" role="menu">
                <div className="titlebar-submenu">
                  <button
                    className={viewThemeOpen ? "active" : ""}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={viewThemeOpen}
                    onClick={() => setViewThemeOpen((current) => !current)}
                  >
                    Theme
                    <span className="submenu-arrow">›</span>
                  </button>
                  {viewThemeOpen && (
                    <div
                      className="titlebar-menu-popover titlebar-submenu-popover theme-menu"
                      role="menu"
                      aria-label="Theme"
                    >
                      {THEME_OPTIONS.map((item) => (
                        <button
                          key={item.value}
                          role="menuitemradio"
                          aria-checked={theme === item.value}
                          onClick={() => {
                            setTheme(item.value);
                            setViewThemeOpen(false);
                            setTitlebarMenu(null);
                          }}
                        >
                          <span className={`theme-swatch ${item.swatch}`} />
                          {item.label}
                          {theme === item.value && <span className="menu-check">✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
          <div className="brand-glyph small"><Icon name="book" size={19} /></div>
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
            <small>{notes.length}</small>
          </button>
          <button
            className={`folder-list-item ${selectedFolderID === "" ? "active" : ""}`}
            onClick={() => {
              setSelectedFolderID("");
              setQuery("");
            }}
          >
            <Icon name="folder" size={15} />
            <span>Unfiled</span>
            <small>{notes.filter((item) => !item.folderId).length}</small>
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              className={`folder-list-item ${selectedFolderID === folder.id ? "active" : ""}`}
              onClick={() => {
                setSelectedFolderID(folder.id);
                setQuery("");
              }}
              onContextMenu={(event) =>
                showContextMenu(event, {
                  kind: "folder",
                  id: folder.id,
                  label: folder.name,
                })
              }
            >
              <Icon name="folder" size={15} />
              <span>{folder.name}</span>
              <small>{notes.filter((item) => item.folderId === folder.id).length}</small>
            </button>
          ))}
        </nav>
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
          <button className="icon-button" onClick={() => void createNote()} aria-label="Create note" title="New note (Ctrl + N)">
            <Icon name="plus" size={17} />
          </button>
        </div>
        <nav className="note-list" aria-label="Notes">
          {visibleNotes.map((item) => (
            <button
              key={item.id}
              className={`note-list-item ${note?.id === item.id ? "active" : ""}`}
              onClick={() => void selectNote(item.id)}
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
            <span>{folderName(session.path)}</span>
            {currentFolder && <><b>/</b><span>{currentFolder.name}</span></>}
            {note && <><b>/</b><strong>{note.title || "Untitled"}</strong></>}
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
                  ? "Link this vault to GitHub in Settings first"
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
              {(["live", "write", "preview", "split"] as EditorView[]).map((item) => (
                <button
                  key={item}
                  role="tab"
                  aria-selected={view === item}
                  className={view === item ? "active" : ""}
                  onClick={() => setView(item)}
                >
                  {item === "live"
                    ? "Live Preview"
                    : item === "write"
                      ? "Source"
                      : item[0].toUpperCase() + item.slice(1)}
                </button>
              ))}
            </div>
            <div className={`document-body view-${view}`}>
              {view === "live" && (
                <LiveMarkdownEditor
                  key={note.id}
                  value={note.content}
                  onChange={(content) => editNote({ content })}
                  onSave={() => void persistCurrent()}
                  onOpenWikilink={(title) => void openWikilinkTitle(title)}
                  scrollToOffset={scrollToOffset}
                />
              )}
              {(view === "write" || view === "split") && (
                <textarea
                  className="markdown-editor"
                  value={note.content}
                  onChange={(event) => editNote({ content: event.target.value })}
                  spellCheck
                  aria-label="Markdown editor"
                  placeholder="Begin writing…"
                />
              )}
              {(view === "preview" || view === "split") && (
                <article className="markdown-preview">
                  <NotionOutlinePreview
                    content={note.content}
                    onChange={(content) => editNote({ content })}
                    onOpenWikilink={(title) => void openWikilinkTitle(title)}
                  />
                </article>
              )}
            </div>
            <footer className="document-footer">
              <span>{note.content.trim() ? note.content.trim().split(/\s+/).length : 0} words</span>
              <span>Revision {note.revision}</span>
              <span className="footer-encryption"><Icon name="lock" size={12} /> Encrypted at rest</span>
            </footer>
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
      {settingsOpen && (
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
                setSettingsOpen(false);
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
