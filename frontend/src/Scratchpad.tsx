import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Events, Window } from "@wailsio/runtime";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { ScratchpadState } from "../bindings/cipherleaf/internal/app/models";
import { errorText } from "./errors";
import { createSerialTaskRunner } from "./serialTask";
import type { BoardColumn, CardMetadata, CardStatus } from "./cards";

const LiveMarkdownEditor = lazy(() => import("./LiveMarkdownEditor"));

type ScratchpadProps = {
  readonly overlay?: boolean;
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
  readonly onChangeBoardColumns?: (boardID: string, columns: readonly BoardColumn[]) => void;
  readonly onDecreaseFontSize?: () => void;
  readonly onIncreaseFontSize?: () => void;
  readonly defaultSectionsCollapsed?: boolean;
};

const EMPTY_STATE: ScratchpadState = {
  content: "",
  caretOffset: 0,
  generation: 0,
  revision: 0,
};

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
  onDecreaseFontSize = () => {},
  onIncreaseFontSize = () => {},
  defaultSectionsCollapsed = true,
}: ScratchpadProps) {
  const [state, setState] = useState<ScratchpadState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const stateRef = useRef(state);
  const generationRef = useRef(state.generation);
  const loadedRef = useRef(false);
  const localChangeRef = useRef(0);
  const lastSavedLocalChangeRef = useRef(0);
  const save = useRef(createSerialTaskRunner()).current;

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
        if (!saved || saved.generation !== generationRef.current) return;
        const latestLocalChange = localChange === localChangeRef.current;
        if (latestLocalChange) lastSavedLocalChangeRef.current = localChange;
        applyState(saved, !latestLocalChange);
      } catch (reason) {
        reportError(reason, generation);
      }
    });
  }, [applyState, reportError, save]);

  const updateContent = (content: string, generation: number, caretOffset = stateRef.current.caretOffset) => {
    if (!loadedRef.current || generation !== generationRef.current) return;
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

  useEffect(() => {
    let active = true;
    const applyEvent = (event: unknown) => {
      const next = scratchpadState(event);
      if (active && next) {
        const preserveLocal = next.generation === stateRef.current.generation &&
          localChangeRef.current > lastSavedLocalChangeRef.current;
        applyState(next, preserveLocal);
        loadedRef.current = true;
        setLoaded(true);
      }
    };
    const offChanged = Events.On("cipherleaf:scratchpad-changed", applyEvent);
    const offCleared = Events.On("cipherleaf:scratchpad-cleared", applyEvent);
    VaultService.GetScratchpad()
      .then((loaded) => {
        if (active) {
          const next = scratchpadState(loaded);
          if (next) applyState(next);
          loadedRef.current = true;
          setLoaded(true);
        }
      })
      .catch((reason) => {
        if (active) {
          loadedRef.current = true;
          setLoaded(true);
          reportError(reason);
        }
      });
    return () => {
      active = false;
      generationRef.current += 1;
      offChanged();
      offCleared();
    };
  }, [applyState, reportError]);

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

  const editorGeneration = state.generation;
  return (
    <section className={overlay ? "editor-shell scratchpad-overlay-shell" : "scratchpad-editor"} aria-labelledby="scratchpad-title">
      <header className="scratchpad-heading">
        <h1 id="scratchpad-title">Scratchpad</h1>
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
      {error && <div className="scratchpad-alert" role="alert">{error}</div>}
      <div className="document-body scratchpad-editor-body">
        {loaded ? <Suspense fallback={<div className="settings-loading">Loading editor...</div>}>
            <LiveMarkdownEditor
              key={editorGeneration}
              noteID={`scratchpad:${editorGeneration}`}
              value={state.content}
              onChange={(content) => updateContent(content, editorGeneration)}
              onChangeWithCaret={(content, caretOffset) => updateContent(content, editorGeneration, caretOffset)}
              onSave={() => {}}
              onError={(reason) => reportError(reason, editorGeneration)}
              onOpenWikilink={onOpenWikilink}
              onOpenCard={onOpenCard}
              cardTitles={cardTitles}
              cardData={cardData}
              onCreateCard={onCreateCard}
              onCreateBoard={onCreateBoard}
              onMoveCard={onMoveCard}
              onMoveCardInBoard={onMoveCardInBoard}
              onAddCardToBoard={onAddCardToBoard}
              onChangeBoardTitle={onChangeBoardTitle}
              onChangeBoardColumns={onChangeBoardColumns}
              onDecreaseFontSize={onDecreaseFontSize}
              onIncreaseFontSize={onIncreaseFontSize}
              caretOffset={state.caretOffset}
              onCaretChange={(offset) => updateCaret(offset, editorGeneration)}
              showToolbar
              defaultSectionsCollapsed={defaultSectionsCollapsed}
            />
          </Suspense> : <div className="settings-loading">Loading scratchpad...</div>}
      </div>
    </section>
  );
}
