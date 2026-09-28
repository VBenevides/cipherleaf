import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events, Window } from "@wailsio/runtime";
import type { StateEffect } from "@codemirror/state";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { ScratchpadState } from "../bindings/cipherleaf/internal/app/models";
import type { Note, NoteSummary } from "../bindings/cipherleaf/internal/vault/models";
import { errorText } from "./errors";
import { createSerialTaskRunner } from "./serialTask";
import { cardMetadataFromSummary, type BoardColumn, type CardMetadata, type CardStatus } from "./cards";
import {
  markdownFromCanonicalObjectDocument,
  parseCanonicalObjectDocumentText,
  prepareNoteContent,
} from "./objectDocument";

import { parseNoteSavedEvent } from "./noteSavedEvent";
const LiveMarkdownEditor = lazy(() => import("./LiveMarkdownEditor"));

type ScratchpadProps = {
  readonly overlay?: boolean;
  readonly isShortcutTarget?: boolean;
  readonly onSetShortcutTarget?: (target: string) => void;
  readonly onClose?: () => void;
  readonly onError?: (reason: unknown) => void;
  readonly onOpenWikilink?: (title: string) => void;
  readonly onOpenCard?: (id: string) => void;
  readonly cardTitles?: ReadonlyMap<string, string>;
  readonly cardData?: ReadonlyMap<string, CardMetadata>;
  readonly onCreateCard?: () => Promise<string | null>;
  readonly onCreateBoard?: () => Promise<string | null>;
  readonly onMoveCard?: (id: string, status: CardStatus) => void;
  readonly onMoveCardInBoard?: (boardID: string, cardID: string, columnID: string) => void;
  readonly onAddCardToBoard?: (boardID: string) => void;
  readonly onChangeBoardTitle?: (boardID: string, title: string) => void;
  readonly onChangeBoardColumns?: (boardID: string, columns: readonly BoardColumn[], deletedColumns?: readonly BoardColumn[], orphanCardIDs?: readonly string[]) => void;
  readonly cardTemplates?: readonly { id: string; name: string }[];
  readonly onChangeBoardTemplate?: (boardID: string, templateID: string) => void;
  readonly onOpenBoardTemplate?: (boardID: string, templateID: string) => void;
  readonly onCreateBoardTemplate?: (boardID: string) => void;
  readonly onDecreaseFontSize?: () => void;
  readonly onIncreaseFontSize?: () => void;
  readonly defaultSectionsCollapsed?: boolean;
};
type SavedScrollSnapshot = {
  readonly snapshot: StateEffect<unknown>;
  readonly document: string;
};



const EMPTY_STATE: ScratchpadState = {
  content: "",
  caretOffset: 0,
  generation: 0,
  revision: 0,
};

const MAX_NOTE_BYTES = 10 * 1024 * 1024;
const MAX_SCROLL_SNAPSHOTS = 8;



function noteIDForShortcutTarget(target: string): string | null {
  return target.startsWith("note:") && target.length > "note:".length ? target.slice("note:".length) : null;
}

const DEFAULT_SCRATCHPAD_SHORTCUT_TARGET = "scratchpad";


function noteForEditing(note: Note): Note {
  return { ...note, content: prepareNoteContent(note.content).canonicalText };
}

function markdownForEditing(content: string): string {
  const canonical = parseCanonicalObjectDocumentText(content);
  return canonical ? markdownFromCanonicalObjectDocument(canonical) : content;
}

function scratchpadState(value: unknown): ScratchpadState | null {
  const candidate = value && typeof value === "object" && "data" in value
    ? (value as { data?: unknown }).data
    : value;
  if (!candidate || typeof candidate !== "object") return null;
  const state = candidate as Partial<ScratchpadState>;
  if (
    !Number.isSafeInteger(state.generation) ||
    state.generation! < 0 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision! < 0 ||
    typeof state.content !== "string" ||
    state.content.length > MAX_NOTE_BYTES ||
    new TextEncoder().encode(state.content).byteLength > MAX_NOTE_BYTES
  ) return null;
  return {
    content: state.content,
    caretOffset: Number.isSafeInteger(state.caretOffset) ? Math.max(0, state.caretOffset!) : 0,
    generation: state.generation!,
    revision: state.revision!,
  };
}

export default function Scratchpad({
  overlay = false,
  isShortcutTarget = true,
  onSetShortcutTarget = () => {},
  onClose,
  onError,
  onOpenWikilink = () => {},
  onOpenCard,
  cardTitles,
  cardData,
  onCreateCard,
  onCreateBoard,
  onMoveCard,
  onMoveCardInBoard,
  onAddCardToBoard,
  onChangeBoardTitle,
  onChangeBoardColumns,
  cardTemplates,
  onChangeBoardTemplate,
  onOpenBoardTemplate,
  onCreateBoardTemplate,
  onDecreaseFontSize = () => {},
  onIncreaseFontSize = () => {},
  defaultSectionsCollapsed = true,
}: ScratchpadProps) {
  const [state, setState] = useState<ScratchpadState>(EMPTY_STATE);
  const [targetNote, setTargetNote] = useState<Note | null>(null);
  const [targetContent, setTargetContent] = useState("");
  const [overlayCardData, setOverlayCardData] = useState<ReadonlyMap<string, CardMetadata>>(new Map());
  const overlayCardRevisionsRef = useRef(new Map<string, number>());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const stateRef = useRef(state);
  const generationRef = useRef(state.generation);
  const loadedRef = useRef(false);
  const localChangeRef = useRef(0);
  const lastSavedLocalChangeRef = useRef(0);
  const save = useRef(createSerialTaskRunner()).current;
  const targetNoteRef = useRef<Note | null>(null);
  const targetContentRef = useRef("");
  const targetDirtyRef = useRef(false);
  const targetRequestRef = useRef(0);
  const targetNoteIDRef = useRef<string | null>(null);
  const targetVaultIDRef = useRef("");
  const scrollSnapshotsRef = useRef(new Map<string, SavedScrollSnapshot>());
  const overlayCardTitles = useMemo(
    () => new Map([...overlayCardData].map(([id, card]) => [id, card.title])),
    [overlayCardData],
  );

  const reportError = useCallback((reason: unknown, generation?: number) => {
    if (generation !== undefined && generation !== generationRef.current) return;
    onError?.(reason);
    setError(errorText(reason));
  }, [onError]);

  const applyState = useCallback((next: ScratchpadState, preserveLocal = false) => {
    const current = stateRef.current;
    if (next.generation < current.generation) return false;
    if (next.generation === current.generation && next.revision < current.revision) return false;
    const applied = preserveLocal
      ? { ...current, generation: next.generation, revision: next.revision }
      : next;
    stateRef.current = applied;
    generationRef.current = applied.generation;
    setState(applied);
    return true;
  }, []);

  const saveScratchpad = useCallback((content: string, caretOffset: number, generation: number, localChange = localChangeRef.current) => {
    if (!loadedRef.current || generation !== generationRef.current) return Promise.resolve();
    return save(async () => {
      if (generation !== generationRef.current) return;
      try {
        const saved = scratchpadState(await VaultService.SaveScratchpad(
          content,
          caretOffset,
          generation,
          stateRef.current.revision,
        ));
        if (saved?.generation !== generationRef.current) return;
        const latestLocalChange = localChange === localChangeRef.current;
        if (latestLocalChange) lastSavedLocalChangeRef.current = localChange;
        applyState(saved, !latestLocalChange);
      } catch (reason) {
        reportError(reason, generation);
      }
    });
  }, [applyState, reportError, save]);

  const saveTargetNote = useCallback((note: Note, content: string, request = targetRequestRef.current) => {
    return save(async () => {
      if (request !== targetRequestRef.current || targetNoteRef.current?.id !== note.id) return;
      try {
        const currentNote = targetNoteRef.current;
        if (!currentNote) return;
        const saved = await VaultService.SaveNote(
          currentNote.id,
          currentNote.title,
          markdownForEditing(content),
          currentNote.revision,
        );
        if (request !== targetRequestRef.current) return;
        const prepared = noteForEditing(saved.note);
        if (targetNoteRef.current?.id !== currentNote.id) return;
        const latestContent = targetContentRef.current;
        if (latestContent === content) {
          const current = { ...prepared, content };
          targetNoteRef.current = current;
          setTargetNote(current);
          targetDirtyRef.current = false;
        } else {
          targetNoteRef.current = {
            ...targetNoteRef.current,
            revision: Math.max(targetNoteRef.current.revision, prepared.revision),
          };
        }
      } catch (reason) {
        if (errorText(reason).startsWith("note was changed by another writer")) {
          setError("This note changed elsewhere. Copy the draft, then reload latest before retrying.");
        } else {
          reportError(reason);
        }
      }
    });
  }, [reportError, save]);

  const updateContent = (content: string, generation: number | string, caretOffset = stateRef.current.caretOffset) => {
    if (!loadedRef.current) return;
    if (typeof generation === "string") {
      const currentNote = targetNoteRef.current;
      if (!currentNote || currentNote.id !== generation) return;
      targetDirtyRef.current = true;
      targetContentRef.current = content;
      setTargetContent(content);
      void saveTargetNote(currentNote, content, targetRequestRef.current);
      return;
    }
    if (generation !== generationRef.current) return;
    const current = stateRef.current;
    const normalizedCaretOffset = Math.max(0, Math.min(Math.floor(caretOffset), content.length));
    const localChange = ++localChangeRef.current;
    const next = { ...current, content, caretOffset: normalizedCaretOffset };
    stateRef.current = next;
    setState(next);
    void saveScratchpad(content, normalizedCaretOffset, generation, localChange);
  };

  const updateCaret = (caretOffset: number, generation: number) => {
    if (!loadedRef.current || generation !== generationRef.current) return;
    const current = stateRef.current;
    const normalizedCaretOffset = Math.max(0, Math.floor(caretOffset));
    if (normalizedCaretOffset === current.caretOffset) return;
    const localChange = ++localChangeRef.current;
    const next = { ...current, caretOffset: normalizedCaretOffset };
    stateRef.current = next;
    setState(next);
    void saveScratchpad(current.content, next.caretOffset, generation, localChange);
  };

  const hideOverlay = useCallback(() => {
    void VaultService.HideScratchpad().catch(() => Window.Hide());
  }, []);

  const loadTarget = useCallback(async () => {
    const request = ++targetRequestRef.current;
    targetNoteRef.current = null;
    targetContentRef.current = "";
    targetDirtyRef.current = false;
    targetVaultIDRef.current = "";
    targetNoteIDRef.current = null;
    loadedRef.current = false;
    overlayCardRevisionsRef.current.clear();
    setOverlayCardData(new Map());
    setTargetNote(null);
    setTargetContent("");
    setLoaded(false);
    try {
      const targetPromise = overlay ? VaultService.GetScratchpadShortcutTarget() : Promise.resolve(DEFAULT_SCRATCHPAD_SHORTCUT_TARGET);
      const summariesPromise = overlay ? VaultService.ListNotes().catch(() => null) : Promise.resolve(null);
      const sessionPromise = overlay ? VaultService.GetSession() : Promise.resolve(null);
      const [target, summaries, currentSession] = await Promise.all([targetPromise, summariesPromise, sessionPromise]);
      if (request !== targetRequestRef.current) return;
      targetVaultIDRef.current = currentSession?.vaultId ?? "";
      if (summaries) {
        const cards = new Map<string, CardMetadata>();
        overlayCardRevisionsRef.current.clear();
        for (const summary of summaries) {
          overlayCardRevisionsRef.current.set(summary.id, summary.revision);
          const metadata = cardMetadataFromSummary(summary);
          if (metadata) cards.set(summary.id, metadata);
        }
        setOverlayCardData(cards);
      }
      const noteID = noteIDForShortcutTarget(target);
      targetNoteIDRef.current = noteID;
      if (noteID) {
        const loadedNote = noteForEditing(await VaultService.GetNote(noteID));
        if (request !== targetRequestRef.current) return;
        setError("");
        targetNoteRef.current = loadedNote;
        targetContentRef.current = loadedNote.content;
        targetDirtyRef.current = false;
        setTargetNote(loadedNote);
        setTargetContent(loadedNote.content);
        loadedRef.current = true;
        setLoaded(true);
        return;
      }
      const next = scratchpadState(await VaultService.GetScratchpad()) ?? EMPTY_STATE;
      if (request !== targetRequestRef.current) return;
      setError("");
      targetNoteRef.current = null;
      targetContentRef.current = "";
      targetDirtyRef.current = false;

      setTargetNote(null);
      setTargetContent("");
      applyState(next);
      loadedRef.current = true;
      setLoaded(true);
    } catch (reason) {
      if (request !== targetRequestRef.current) return;
      targetNoteRef.current = null;
      targetDirtyRef.current = false;
      targetVaultIDRef.current = "";
      targetNoteIDRef.current = null;
      overlayCardRevisionsRef.current.clear();
      setOverlayCardData(new Map());
      setTargetNote(null);
      try {
        const fallback = scratchpadState(await VaultService.GetScratchpad());
        if (request !== targetRequestRef.current) return;
        if (fallback) applyState(fallback);
      } catch (error_) {
        console.error(`Scratchpad fallback refresh failed: ${errorText(error_)}`);
      }
      if (request !== targetRequestRef.current) return;
      loadedRef.current = true;
      setLoaded(true);
      reportError(reason);
    }
  }, [applyState, overlay, reportError]);

  const clearTarget = useCallback((resetScratchpad = false) => {
    targetRequestRef.current++;
    targetNoteRef.current = null;
    targetContentRef.current = "";
    targetDirtyRef.current = false;
    targetNoteIDRef.current = null;
    scrollSnapshotsRef.current.clear();
    if (resetScratchpad) {
      stateRef.current = EMPTY_STATE;
      generationRef.current = EMPTY_STATE.generation;
      localChangeRef.current = 0;
      lastSavedLocalChangeRef.current = 0;
      setState(EMPTY_STATE);
    }
    setTargetNote(null);
    setTargetContent("");
    setLoaded(false);
    void loadTarget();
  }, [loadTarget]);

  useEffect(() => {
    let active = true;
    const applyChanged = async () => {
      const request = targetRequestRef.current;
      const generation = generationRef.current;
      const vaultID = targetVaultIDRef.current;
      if (!active || targetNoteRef.current) return;
      try {
        const next = scratchpadState(await VaultService.GetScratchpad());
        if (
          !active ||
          request !== targetRequestRef.current ||
          generation !== generationRef.current ||
          vaultID !== targetVaultIDRef.current ||
          targetNoteRef.current ||
          !next
        ) return;
        const preserveLocal = next.generation === stateRef.current.generation &&
          localChangeRef.current > lastSavedLocalChangeRef.current;
        applyState(next, preserveLocal);
        loadedRef.current = true;
        setLoaded(true);
      } catch (reason) {
        if (active) console.error(`Scratchpad refresh failed: ${errorText(reason)}`);
      }
    };
    const offChanged = Events.On("cipherleaf:scratchpad-changed", applyChanged);
    const applySavedNoteEvent = async (event: unknown) => {
      const payload = parseNoteSavedEvent(event);
      if (!overlay || !active || payload?.vaultId !== targetVaultIDRef.current) return;
      if (!payload) return;
      const { noteID, revision } = payload;
      const request = targetRequestRef.current;
      const vaultID = targetVaultIDRef.current;
      let authoritativeNote: Note;
      let summaries: readonly NoteSummary[];
      try {
        const [loadedNote, loadedSummaries] = await Promise.all([
          VaultService.GetNote(noteID),
          VaultService.ListNotes(),
        ]);
        if (!loadedNote || !loadedSummaries) throw new Error("authoritative note refresh returned incomplete data");
        authoritativeNote = loadedNote;
        summaries = loadedSummaries;
      } catch (reason) {
        if (active && request === targetRequestRef.current && vaultID === targetVaultIDRef.current) {
          console.error(`Scratchpad note refresh failed: ${errorText(reason)}`);
        }
        return;
      }
      if (
        !active ||
        request !== targetRequestRef.current ||
        vaultID !== targetVaultIDRef.current
      ) return;
      const authoritativeSummary = summaries.find((item) => item.id === noteID);
      if (
        !authoritativeSummary ||
        authoritativeNote.id !== noteID ||
        authoritativeNote.revision !== revision ||
        authoritativeSummary.revision !== revision
      ) return;
      const wasKnownCard = overlayCardRevisionsRef.current.has(noteID);
      const isTargetNote = noteID === targetNoteIDRef.current;
      const metadata = cardMetadataFromSummary(authoritativeSummary);
      if (!wasKnownCard && !isTargetNote && !metadata) return;
      const previousRevision = overlayCardRevisionsRef.current.get(noteID) ?? 0;
      if (authoritativeSummary.revision <= previousRevision) return;
      overlayCardRevisionsRef.current.set(noteID, authoritativeSummary.revision);
      setOverlayCardData((current) => {
        const next = new Map(current);
        if (metadata) next.set(noteID, metadata);
        else next.delete(noteID);
        return next;
      });
      const currentTarget = targetNoteRef.current;
      if (
        currentTarget?.id === authoritativeNote.id &&
        !targetDirtyRef.current &&
        authoritativeNote.revision > currentTarget.revision
      ) {
        const prepared = noteForEditing(authoritativeNote);
        targetNoteRef.current = prepared;
        targetContentRef.current = prepared.content;
        setTargetNote(prepared);
        setTargetContent(prepared.content);
      }
    };
    const offSaved = Events.On("cipherleaf:note-saved", applySavedNoteEvent);
    const offCleared = Events.On("cipherleaf:scratchpad-cleared", (event) => {
      if (!active) return;
      const raw = event && typeof event === "object" && "data" in event ? event.data : event;
      if (!raw || typeof raw !== "object") {
        clearTarget(true);
        return;
      }
      const payload = raw as { all?: unknown; vaultId?: unknown; folderIDs?: unknown };
      if (scratchpadState(raw)) {
        clearTarget(true);
        return;
      }
      if (payload.all === true) {
        clearTarget(true);
        return;
      }
      const folderIDs = Array.isArray(payload.folderIDs) && payload.folderIDs.every((id) => typeof id === "string")
        ? payload.folderIDs
        : [];
      if (
        typeof payload.vaultId === "string" &&
        payload.vaultId === targetVaultIDRef.current &&
        targetNoteRef.current &&
        folderIDs.includes(targetNoteRef.current.folderId)
      ) {
        clearTarget();
      }
    });
    const offTarget = Events.On("cipherleaf:scratchpad-overlay-refresh", () => {
      if (!active) return;
      void save(async () => {}).then(async () => {
        if (!targetDirtyRef.current || !targetNoteRef.current) return;
        await saveTargetNote(targetNoteRef.current, targetContentRef.current, targetRequestRef.current);
      }).then(() => {
        if (active && !targetDirtyRef.current) void loadTarget();
      });
    });
    void loadTarget();
    return () => {
      active = false;
      generationRef.current += 1;
      offChanged();
      offSaved();
      offCleared();
      offTarget();
    };
  }, [loadTarget]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest("dialog, [role=dialog]")) return;
      event.preventDefault();
      if (overlay) hideOverlay();
      else onClose?.();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [hideOverlay, onClose, overlay]);

  const editorGeneration = targetNote?.id ?? state.generation;
  const editorScrollKey = targetNote
    ? `note:${targetVaultIDRef.current}:${targetNote.id}`
    : `scratchpad:${state.generation}`;
  const editorCardData = cardData ?? overlayCardData;
  const editorCardTitles = cardTitles ?? overlayCardTitles;
  return (
    <section className={overlay ? "editor-shell scratchpad-overlay-shell" : "scratchpad-editor"} aria-labelledby="scratchpad-title">
      <header className="scratchpad-heading">
        <h1 id="scratchpad-title">{targetNote?.title || "Scratchpad"}</h1>
        {!overlay && (
          <label className="scratchpad-target-toggle">
            <input
              type="checkbox"
              checked={isShortcutTarget}
              onChange={() => onSetShortcutTarget(DEFAULT_SCRATCHPAD_SHORTCUT_TARGET)}
            />{" "}
            Open as scratchpad
          </label>
        )}
        {overlay && (
          <button
            type="button"
            className="icon-button scratchpad-close"
            aria-label="Hide scratchpad"
            title="Hide scratchpad"
            onClick={hideOverlay}
          >
            ×
          </button>
        )}
      </header>
      {error && (
        <div className="scratchpad-alert" role="alert">
          <span>{error}</span>
          {error.startsWith("This note changed elsewhere.") && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                targetDirtyRef.current = false;
                void loadTarget();
              }}
            >
              Reload latest
            </button>
          )}
          <button type="button" className="icon-button" onClick={() => setError("")} aria-label="Dismiss error">×</button>
        </div>
      )}
      <div className="document-body scratchpad-editor-body">
        {loaded ? <Suspense fallback={<div className="settings-loading">Loading editor...</div>}>
            <LiveMarkdownEditor
              key={editorGeneration}
              noteID={targetNote?.id ?? "scratchpad:" + editorGeneration}
              value={targetNote ? markdownForEditing(targetContent) : state.content}
              onChange={(content) => updateContent(content, editorGeneration)}
              onChangeWithCaret={(content, caretOffset) => updateContent(content, editorGeneration, caretOffset)}
              onSave={() => {}}
              onError={(reason) => reportError(reason, targetNote ? undefined : state.generation)}
              onOpenWikilink={onOpenWikilink}
              onOpenCard={onOpenCard}
              cardTitles={editorCardTitles}
              cardData={editorCardData}
              onCreateCard={onCreateCard}
              onCreateBoard={onCreateBoard}
              onMoveCard={onMoveCard}
              onMoveCardInBoard={onMoveCardInBoard}
              onAddCardToBoard={onAddCardToBoard}
              onChangeBoardTitle={onChangeBoardTitle}
              onChangeBoardColumns={onChangeBoardColumns}
              cardTemplates={cardTemplates}
              onChangeBoardTemplate={onChangeBoardTemplate}
              onOpenBoardTemplate={onOpenBoardTemplate}
              onCreateBoardTemplate={onCreateBoardTemplate}
              onDecreaseFontSize={onDecreaseFontSize}
              onIncreaseFontSize={onIncreaseFontSize}
              caretOffset={targetNote ? undefined : state.caretOffset}
              onCaretChange={targetNote ? undefined : (offset) => updateCaret(offset, state.generation)}
              scrollSnapshot={overlay ? scrollSnapshotsRef.current.get(editorScrollKey)?.snapshot : undefined}
              scrollSnapshotDocument={overlay ? scrollSnapshotsRef.current.get(editorScrollKey)?.document : undefined}
              onScrollSnapshotChange={overlay ? (snapshot, document) => {
                const snapshots = scrollSnapshotsRef.current;
                snapshots.delete(editorScrollKey);
                snapshots.set(editorScrollKey, { snapshot, document });
                while (snapshots.size > MAX_SCROLL_SNAPSHOTS) {
                  const oldest = snapshots.keys().next().value;
                  if (oldest === undefined) break;
                  snapshots.delete(oldest);
                }
              } : undefined}
              showToolbar
              defaultSectionsCollapsed={defaultSectionsCollapsed}
            />
          </Suspense> : <div className="settings-loading">Loading scratchpad...</div>}
      </div>
    </section>
  );
}
