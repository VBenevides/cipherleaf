import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { Events, getTransport, setTransport, type RuntimeTransport } from "@wailsio/runtime";
import Scratchpad from "../src/Scratchpad";
import LiveMarkdownEditor from "../src/LiveMarkdownEditor";
import type { ScratchpadState } from "../bindings/cipherleaf/internal/app/models";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const changed = "cipherleaf:scratchpad-changed";
const cleared = "cipherleaf:scratchpad-cleared";
const noteSaved = "cipherleaf:note-saved";
const getScratchpadMethod = 687321542;
const saveScratchpadMethod = 2199009165;
const hideScratchpadMethod = 3062824244;
const listNotesMethod = 888598820;
const getNoteMethod = 1503400201;
const getScratchpadTargetMethod = 3332482185;
const getSessionMethod = 355925843;
const saveNoteMethod = 2770680190;

const previousTransport = getTransport();
const runtimeWindow = globalThis.window as unknown as {
  addEventListener: (type: string, listener: (event: any) => void) => void;
  removeEventListener: (type: string, listener: (event: any) => void) => void;
  _wails?: unknown;
};
const previousAddEventListener = runtimeWindow.addEventListener;
const previousRemoveEventListener = runtimeWindow.removeEventListener;
const previousWails = runtimeWindow._wails;
const globalScope = globalThis as typeof globalThis & { Element?: unknown };
const previousElement = globalScope.Element;
const keydownListeners = new Set<(event: any) => void>();
const eventRuntime = await import("../node_modules/@wailsio/runtime/dist/listener.js") as {
  eventListeners: Map<string, Array<{ dispatch: (event: unknown) => void }>>;
};

class TestElement {
  constructor(private readonly dialog: boolean) {}

  closest() {
    return this.dialog ? this : null;
  }
}

const state = (content: string, generation: number, revision: number, caretOffset = 0): ScratchpadState => ({
  content,
  caretOffset,
  generation,
  revision,
});

let getCalls = 0;
const initialGet = deferred<ScratchpadState>();
const saveRequests: Array<{ request: any; result: Deferred<ScratchpadState> }> = [];
const noteSaveRequests: Array<{ request: any; result: Deferred<any> }> = [];
let shortcutTarget = "scratchpad";
let cardRevision = 1;
let cardTitle = "Board card";
let cardStatus = "in-progress";
let cardTags: string[] = [];
let newCardVisible = false;
let targetRevision = 1;
let targetContent = "first";
let currentState = state("initial", 1, 1, 2);
let windowHideCalls = 0;
const transport: RuntimeTransport = {
  call: async (objectID, method, _windowName, request) => {
    if (objectID === 6 && method === 11) {
      windowHideCalls++;
      return null;
    }
    switch (request?.methodID) {
      case getScratchpadMethod:
        getCalls++;
        return getCalls === 1 ? initialGet.promise : currentState;
      case saveScratchpadMethod: {
        const result = deferred<ScratchpadState>();
        saveRequests.push({ request, result });
        return result.promise;
      }
      case getScratchpadTargetMethod:
        return shortcutTarget;
      case getSessionMethod:
        return { locked: false, path: "/vault", vaultId: "vault-1", noteCount: 1 };
      case getNoteMethod: {
        const noteID = request?.args?.[0];
        if (noteID === "card" || noteID === "new-card") {
          const isNewCard = noteID === "new-card";
          return {
            id: noteID,
            title: isNewCard ? "New card" : cardTitle,
            folderId: "folder",
            order: 0,
            content: "",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            modifiedAt: 2,
            revision: isNewCard ? 1 : cardRevision,
          };
        }
        return {
          id: "target-note",
          title: "Target",
          folderId: "folder",
          order: 0,
          content: targetContent,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          modifiedAt: 1,
          revision: targetRevision,
        };
      }
      case saveNoteMethod: {
        const result = deferred<any>();
        noteSaveRequests.push({ request, result });
        return result.promise;
      }
      case hideScratchpadMethod:
        throw new Error("hide failed");
      case listNotesMethod:
        return [
          {
            id: "card",
            title: cardTitle,
            folderId: "folder",
            order: 0,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            modifiedAt: 2,
            revision: cardRevision,
            attachmentIds: [],
            outgoingLinks: [],
            properties: {
              "cipherleaf-card": true,
              "cipherleaf-card-status": cardStatus,
              "cipherleaf-card-tags": cardTags,
              "cipherleaf-card-created-at": "2026-01-01T00:00:00Z",
            },
          },
          {
            id: "target-note",
            title: "Target",
            folderId: "folder",
            order: 2,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            modifiedAt: 1,
            revision: targetRevision,
            attachmentIds: [],
            outgoingLinks: [],
            properties: {},
          },
          ...(newCardVisible ? [{
            id: "new-card",
            title: "New card",
            folderId: "folder",
            order: 1,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            modifiedAt: 2,
            revision: 1,
            attachmentIds: [],
            outgoingLinks: [],
            properties: {
              "cipherleaf-card": true,
              "cipherleaf-card-status": "in-progress",
              "cipherleaf-card-tags": [],
              "cipherleaf-card-created-at": "2026-01-01T00:00:00Z",
            },
          }] : []),
        ];
      default:
        return null;
    }
  },
};

setTransport(transport);
runtimeWindow.addEventListener = (type, listener) => {
  if (type === "keydown") keydownListeners.add(listener);
  previousAddEventListener.call(runtimeWindow, type, listener);
};
runtimeWindow.removeEventListener = (type, listener) => {
  if (type === "keydown") keydownListeners.delete(listener);
  previousRemoveEventListener.call(runtimeWindow, type, listener);
};
runtimeWindow._wails = {};
Object.defineProperty(globalThis, "Element", { configurable: true, value: TestElement });

const emit = (name: string, data: unknown) => {
  for (const listener of eventRuntime.eventListeners.get(name) ?? []) listener.dispatch({ data });
};
const editorOf = (renderer: ReturnType<typeof create>) => renderer.root.findByType(LiveMarkdownEditor);
const alertText = (renderer: ReturnType<typeof create>) => renderer.root.findByProps({ role: "alert" }).findByType("span").children[0] as string;

try {
  let error: unknown;
  let renderer!: ReturnType<typeof create>;
  renderer = create(createElement(Scratchpad, { onError: (reason) => { error = reason; } }));
  assert.match(JSON.stringify(renderer.toJSON()), /Loading scratchpad/);

  await act(async () => {
    emit(changed, null);
    emit(changed, { generation: "invalid", revision: 1, content: "ignored" });
    initialGet.resolve(currentState);
    await flush();
  });
  assert.equal(editorOf(renderer).props.value, "initial");
  assert.equal(editorOf(renderer).props.caretOffset, 2);

  await act(async () => {
    emit(changed, { generation: 1, revision: 4, content: 5, caretOffset: "bad" });
  });
  assert.equal(editorOf(renderer).props.value, "initial");
  assert.equal(editorOf(renderer).props.caretOffset, 2);
  currentState = state("", 1, 5, 0);
  await act(async () => {
    emit(cleared, currentState);
  });

  const updateWithCaret = editorOf(renderer).props.onChangeWithCaret as (content: string, caret: number) => void;
  const firstSave = saveRequests.length;
  await act(async () => {
    updateWithCaret("local", 99);
    await flush();
  });
  assert.equal(saveRequests.length, firstSave + 1);
  assert.deepEqual(saveRequests[firstSave].request.args, ["local", 5, 1, 5]);
  saveRequests[firstSave].result.resolve(state("saved", 1, 6, 5));
  await act(async () => { await flush(); });
  currentState = state("saved", 1, 6, 5);
  assert.equal(editorOf(renderer).props.value, "saved");

  const caretSave = saveRequests.length;
  await act(async () => {
    editorOf(renderer).props.onCaretChange(-3);
    await flush();
  });
  assert.equal(saveRequests.length, caretSave + 1);
  assert.deepEqual(saveRequests[caretSave].request.args, ["saved", 0, 1, 6]);
  saveRequests[caretSave].result.resolve(state("saved", 1, 7, 0));
  await act(async () => { await flush(); });
  await act(async () => { editorOf(renderer).props.onCaretChange(0); });

  const rejectedSave = saveRequests.length;
  await act(async () => {
    editorOf(renderer).props.onChangeWithCaret("failed", 2);
    await flush();
  });
  assert.equal(saveRequests.length, rejectedSave + 1);
  const saveError = new Error("save failed");
  saveRequests[rejectedSave].result.reject(saveError);
  await act(async () => { await flush(); });
  assert.equal(error, saveError);
  assert.match(alertText(renderer), /save failed/);
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Dismiss error" }).props.onClick();
  });
  assert.throws(() => renderer.root.findByProps({ role: "alert" }));

  currentState = state("saved", 1, 7, 0);
  await act(async () => {
    emit(changed, state("event local", 1, 8, 4));
  });
  assert.equal(editorOf(renderer).props.value, "failed");
  assert.equal(editorOf(renderer).props.caretOffset, 2);

  const oldUpdate = editorOf(renderer).props.onChangeWithCaret as (content: string, caret: number) => void;
  currentState = state("new generation", 2, 1, 1);
  await act(async () => {
    emit(changed, null);
    await flush();
    oldUpdate("ignored", 0);
    emit(changed, { generation: 1, revision: 99, content: "stale generation" });
    emit(changed, { generation: 2, revision: 0, content: "stale revision" });
    await flush();
  });
  assert.equal(editorOf(renderer).props.value, "new generation");
  assert.equal(editorOf(renderer).props.noteID, "scratchpad:2");
  const staleSave = saveRequests.length;
  await act(async () => {
    editorOf(renderer).props.onChangeWithCaret("pending", 99);
    await flush();
  });
  assert.equal(saveRequests.length, staleSave + 1);
  saveRequests[staleSave].result.resolve(state("stale response", 1, 99, 1));
  await act(async () => { await flush(); });
  assert.equal(editorOf(renderer).props.value, "pending");
  await act(async () => { renderer.unmount(); });
  assert.equal(keydownListeners.size, 0);
  assert.equal(eventRuntime.eventListeners.get(changed)?.length ?? 0, 0);
  assert.equal(eventRuntime.eventListeners.get(cleared)?.length ?? 0, 0);

  let closed = 0;
  let normal!: ReturnType<typeof create>;
  normal = create(createElement(Scratchpad, { onClose: () => { closed++; } }));
  await act(async () => { await flush(); });
  const sendEscape = (event: any) => keydownListeners.forEach((listener) => listener(event));
  const guarded = (overrides: Record<string, unknown> = {}) => {
    const event = {
      key: "Escape",
      defaultPrevented: false,
      isComposing: false,
      target: null,
      preventDefault() { this.defaultPrevented = true; },
      ...overrides,
    };
    sendEscape(event);
    return event;
  };
  guarded({ target: new TestElement(true) });
  guarded({ defaultPrevented: true });
  guarded({ isComposing: true });
  guarded({ key: "Enter" });
  assert.equal(closed, 0);
  const normalEscape = guarded();
  assert.equal(normalEscape.defaultPrevented, true);
  assert.equal(closed, 1);
  await act(async () => { normal.unmount(); });
  assert.equal(keydownListeners.size, 0);

  let overlay!: ReturnType<typeof create>;
  shortcutTarget = "note:target-note";
  overlay = create(createElement(Scratchpad, { overlay: true }));
  await act(async () => { await flush(); });
  cardRevision = 2;
  cardTitle = "Renamed card";
  cardStatus = "finished";
  cardTags = ["done"];
  assert.equal(editorOf(overlay).props.cardData.get("card").title, "Board card");
  assert.equal(editorOf(overlay).props.cardTitles.get("card"), "Board card");
  await act(async () => {
    emit(noteSaved, { vaultId: "vault-1", noteId: "card", revision: 2 });
  });
  assert.equal(editorOf(overlay).props.cardData.get("card").title, "Renamed card");
  assert.equal(editorOf(overlay).props.cardData.get("card").status, "finished");
  assert.deepEqual(editorOf(overlay).props.cardData.get("card").tags, ["done"]);
  newCardVisible = true;
  await act(async () => {
    emit(noteSaved, { vaultId: "vault-1", noteId: "new-card", revision: 1 });
    await flush();
  });
  assert.equal(editorOf(overlay).props.cardData.get("new-card").title, "New card");
  await act(async () => {
    emit(noteSaved, { vaultId: "wrong-vault", noteId: "card", revision: 3 });
    emit(noteSaved, { vaultId: "vault-1", revision: 3 });
    emit(noteSaved, { vaultId: "vault-1", noteId: "card", revision: "bad" });
    emit(noteSaved, { vaultId: "vault-1", noteId: "card", revision: 1 });
  });
  assert.equal(editorOf(overlay).props.cardData.get("card").title, "Renamed card");
  targetRevision = 2;
  targetContent = "saved";
  await act(async () => {
    emit(noteSaved, { vaultId: "vault-1", noteId: "target-note", revision: 2 });
    await flush();
  });
  assert.equal(editorOf(overlay).props.value, "saved");
  await act(async () => {
    emit(noteSaved, { vaultId: "vault-1", noteId: "target-note", revision: 1 });
  });
  assert.equal(editorOf(overlay).props.value, "saved");
  await act(async () => {
    emit("cipherleaf:scratchpad-overlay-refresh", null);
    await flush();
    await flush();
  });
  assert.equal(editorOf(overlay).props.value, "saved");
  const targetEditor = editorOf(overlay);
  await act(async () => {
    targetEditor.props.onChangeWithCaret("first ", 6);
    await flush();
  });
  targetRevision = 3;
  targetContent = "remote while dirty";
  await act(async () => {
    emit(noteSaved, { vaultId: "vault-1", noteId: "target-note", revision: 3 });
    await flush();
  });
  assert.equal(editorOf(overlay).props.value, "first ");
  const noteSave = noteSaveRequests.at(-1);
  assert.ok(noteSave);
  assert.equal(noteSave.request.args[2], "first ");
  assert.equal(noteSave.request.args[3], 2);
  noteSave.result.resolve({
    note: {
      id: "target-note",
      title: "Target",
      folderId: "folder",
      order: 0,
      content: "first",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      modifiedAt: 2,
      revision: 4,
    },
    summary: {
      id: "target-note",
      title: "Target",
      folderId: "folder",
      order: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      modifiedAt: 2,
      revision: 4,
      attachmentIds: [],
      outgoingLinks: [],
      properties: {},
    },
  });
  await act(async () => { await flush(); });
  assert.equal(editorOf(overlay).props.value, "first ");
  const rapidStart = noteSaveRequests.length;
  await act(async () => {
    editorOf(overlay).props.onChangeWithCaret("rapid one", 9);
    await flush();
    editorOf(overlay).props.onChangeWithCaret("rapid two", 9);
    await flush();
  });
  assert.equal(noteSaveRequests.length, rapidStart + 1);
  assert.equal(noteSaveRequests[rapidStart].request.args[2], "rapid one");
  assert.equal(noteSaveRequests[rapidStart].request.args[3], 4);
  noteSaveRequests[rapidStart].result.resolve({
    note: { id: "target-note", title: "Target", folderId: "folder", order: 0, content: "rapid one", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", modifiedAt: 3, revision: 5 },
    summary: { id: "target-note", title: "Target", folderId: "folder", order: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", modifiedAt: 3, revision: 5, attachmentIds: [], outgoingLinks: [], properties: {} },
  });
  await act(async () => { await flush(); });
  assert.equal(noteSaveRequests.length, rapidStart + 2);
  assert.equal(noteSaveRequests[rapidStart + 1].request.args[2], "rapid two");
  assert.equal(noteSaveRequests[rapidStart + 1].request.args[3], 5);
  noteSaveRequests[rapidStart + 1].result.resolve({
    note: { id: "target-note", title: "Target", folderId: "folder", order: 0, content: "rapid two", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", modifiedAt: 4, revision: 6 },
    summary: { id: "target-note", title: "Target", folderId: "folder", order: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", modifiedAt: 4, revision: 6, attachmentIds: [], outgoingLinks: [], properties: {} },
  });
  await act(async () => { await flush(); });
  assert.equal(editorOf(overlay).props.value, "rapid two");
  await act(async () => {
    overlay.root.findByProps({ "aria-label": "Hide scratchpad" }).props.onClick();
    await flush();
  });
  assert.equal(windowHideCalls, 1);
  await act(async () => {
    guarded();
    await flush();
  });
  assert.equal(windowHideCalls, 2);
  await act(async () => { overlay.unmount(); });
  assert.equal(keydownListeners.size, 0);
  assert.equal(eventRuntime.eventListeners.get(noteSaved)?.length ?? 0, 0);
} finally {
  Events.Off(changed, cleared);
  Events.Off(noteSaved);
  setTransport(previousTransport);
  runtimeWindow.addEventListener = previousAddEventListener;
  runtimeWindow.removeEventListener = previousRemoveEventListener;
  runtimeWindow._wails = previousWails;
  if (previousElement === undefined) delete globalScope.Element;
  else Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
}
