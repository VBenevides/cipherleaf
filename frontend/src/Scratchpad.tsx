import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events, Window } from "@wailsio/runtime";
import type { StateEffect } from "@codemirror/state";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { ScratchpadState } from "../bindings/cipherleaf/internal/app/models";
import type { Note } from "../bindings/cipherleaf/internal/vault/models";
import { errorText } from "./errors";
import { createSerialTaskRunner } from "./serialTask";
import { cardMetadataFromSummary, type BoardColumn, type CardMetadata, type CardStatus } from "./cards";
import {
  markdownFromCanonicalObjectDocument,
  parseCanonicalObjectDocumentText,
  prepareNoteContent,
} from "./objectDocument";

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

type PendingTargetDraft = {
  readonly note: Note;
  readonly draftSequence: number;
};

type SavedScrollSnapshot = {
  readonly snapshot: StateEffect<unknown>;
  readonly document: string;
};

function targetNoteKey(vaultId: string, noteID: string): string {
  return JSON.stringify([vaultId, noteID]);
}

const EMPTY_STATE: ScratchpadState = {
  content: "",
  caretOffset: 0,
  generation: 0,
  revision: 0,
};

const DEFAULT_SCRATCHPAD_SHORTCUT_TARGET = "scratchpad";

function noteIDForShortcutTarget(target: string): string | null {
  return target.startsWith("note:") && target.length > "note:".length ? target.slice("note:".length) : null;
}

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
  if (!Number.isFinite(state.generation) || !Number.isFinite(state.revision)) return null;
  return {
    content: typeof state.content === "string" ? state.content : "",
    caretOffset: Number.isFinite(state.caretOffset) ? Math.max(0, Math.floor(state.caretOffset!)) : 0,
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
  const targetVaultIDRef = useRef("");
  const targetDraftsRef = useRef(new Map<string, PendingTargetDraft>());
  const persistedDraftSequencesRef = useRef(new Map<string, number>());
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
        const saved = scratchpadState(await VaultService.SaveScratchpad(content, caretOffset, generation));
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
        const vaultId = targetVaultIDRef.current;
        const saved = await VaultService.SaveNote(note.id, note.title, markdownForEditing(content));
        if (vaultId) {
          void Events.Emit("cipherleaf:scratchpad-note-changed", {
            vaultId,
            note: saved.note,
            summary: saved.summary,
          }).catch(() => {});
        }
        if (request !== targetRequestRef.current) return;
        const prepared = noteForEditing(saved.note);
        if (targetNoteRef.current?.id === note.id && targetContentRef.current === content) {
          const current = { ...prepared, content };
          targetNoteRef.current = current;
          setTargetNote(current);
          targetDirtyRef.current = false;
        }
      } catch (reason) {
        reportError(reason);
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
    loadedRef.current = false;
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
        for (const summary of summaries) {
          const metadata = cardMetadataFromSummary(summary);
          if (metadata) cards.set(summary.id, metadata);
        }
        setOverlayCardData(cards);
      }
      const noteID = noteIDForShortcutTarget(target);
      if (noteID) {
        let loadedNote = noteForEditing(await VaultService.GetNote(noteID));
        if (request !== targetRequestRef.current) return;
        const key = targetNoteKey(targetVaultIDRef.current, loadedNote.id);
        const pending = targetDraftsRef.current.get(key);
        const persistedDraftSequence = persistedDraftSequencesRef.current.get(key) ?? 0;
        if (
          pending &&
          pending.draftSequence > persistedDraftSequence &&
          pending.note.revision >= loadedNote.revision
        ) {
          loadedNote = { ...pending.note };
        } else if (pending && pending.note.revision < loadedNote.revision) {
          targetDraftsRef.current.delete(key);
        }
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
      targetDraftsRef.current.clear();
      setTargetNote(null);
      setTargetContent("");
      applyState(next);
      loadedRef.current = true;
      setLoaded(true);
    } catch (reason) {
      if (request !== targetRequestRef.current) return;
      targetNoteRef.current = null;
      targetDirtyRef.current = false;
      targetDraftsRef.current.clear();
      targetVaultIDRef.current = "";
      setOverlayCardData(new Map());
      setTargetNote(null);
      try {
        const fallback = scratchpadState(await VaultService.GetScratchpad());
        if (request !== targetRequestRef.current) return;
        if (fallback) applyState(fallback);
      } catch {
        // Keep the editor cleared when the vault is unavailable.
      }
      if (request !== targetRequestRef.current) return;
      loadedRef.current = true;
      setLoaded(true);
      reportError(reason);
    }
  }, [applyState, overlay, reportError]);

  const clearTarget = useCallback(() => {
    targetRequestRef.current++;
    targetNoteRef.current = null;
    targetContentRef.current = "";
    targetDirtyRef.current = false;
    setTargetNote(null);
    setTargetContent("");
    setLoaded(false);
    void loadTarget();
  }, [loadTarget]);

  useEffect(() => {
    let active = true;
    const applyChanged = (event: unknown) => {
      const next = scratchpadState(event);
      if (active && !targetNoteRef.current && next) {
        const preserveLocal = next.generation === stateRef.current.generation &&
          localChangeRef.current > lastSavedLocalChangeRef.current;
        applyState(next, preserveLocal);
        loadedRef.current = true;
        setLoaded(true);
      }
    };
    const offChanged = Events.On("cipherleaf:scratchpad-changed", applyChanged);
    const applyTargetNoteEvent = (event: unknown, draft: boolean) => {
      if (!overlay || !active) return;
      const raw = event && typeof event === "object" && "data" in event ? event.data : event;
      if (!raw || typeof raw !== "object") return;
      const payload = raw as { vaultId?: unknown; note?: unknown; draftSequence?: unknown };
      const changedNote = payload.note && typeof payload.note === "object" ? payload.note as Note : null;
      const draftSequence = typeof payload.draftSequence === "number" && Number.isSafeInteger(payload.draftSequence)
        ? payload.draftSequence
        : 0;
      if (typeof payload.vaultId !== "string" || !changedNote || (draft && draftSequence <= 0)) return;
      const key = targetNoteKey(payload.vaultId, changedNote.id);
      const pending = targetDraftsRef.current.get(key);
      if (draft) {
        if (!pending || draftSequence > pending.draftSequence) {
          targetDraftsRef.current.set(key, { note: changedNote, draftSequence });
        }
      } else {
        const persisted = persistedDraftSequencesRef.current.get(key) ?? 0;
        if (draftSequence > persisted) persistedDraftSequencesRef.current.set(key, draftSequence);
      }
      if (!loadedRef.current) {
        if (!draft) {
          void loadTarget();
        }
        return;
      }
      const current = targetNoteRef.current;
      if (
        payload.vaultId !== targetVaultIDRef.current ||
        !current ||
        changedNote.id !== current.id ||
        changedNote.revision < current.revision
      ) return;
      if (draft) {
        const latest = targetDraftsRef.current.get(key);
        const persisted = persistedDraftSequencesRef.current.get(key) ?? 0;
        if (latest?.draftSequence !== draftSequence || draftSequence <= persisted || targetDirtyRef.current) return;
      } else {
        const latest = targetDraftsRef.current.get(key);
        if (latest && latest.draftSequence > draftSequence) {
          if (!targetDirtyRef.current) {
            targetNoteRef.current = { ...latest.note };
            targetContentRef.current = latest.note.content;
            setTargetNote(targetNoteRef.current);
            setTargetContent(latest.note.content);
          }
          return;
        }
        targetDraftsRef.current.delete(key);
        if (changedNote.revision <= current.revision || targetDirtyRef.current) return;
      }
      const prepared = draft ? { ...changedNote } : noteForEditing(changedNote);
      targetNoteRef.current = prepared;
      targetContentRef.current = prepared.content;
      targetDirtyRef.current = false;
      setTargetNote(prepared);
      setTargetContent(prepared.content);
    };
    const offTargetNoteChanged = Events.On("cipherleaf:scratchpad-note-changed", (event) => applyTargetNoteEvent(event, false));
    const offTargetNoteDraftChanged = Events.On("cipherleaf:scratchpad-note-draft-changed", (event) => applyTargetNoteEvent(event, true));
    const offCleared = Events.On("cipherleaf:scratchpad-cleared", () => {
      if (active) clearTarget();
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
      offTargetNoteChanged();
      offTargetNoteDraftChanged();
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
              onScrollSnapshotChange={overlay ? (snapshot, document) => scrollSnapshotsRef.current.set(editorScrollKey, { snapshot, document }) : undefined}
              showToolbar
              defaultSectionsCollapsed={defaultSectionsCollapsed}
            />
          </Suspense> : <div className="settings-loading">Loading scratchpad...</div>}
      </div>
    </section>
  );
}
