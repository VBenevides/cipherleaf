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
const getScratchpadMethod = 687321542;
const saveScratchpadMethod = 2199009165;
const hideScratchpadMethod = 3062824244;

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
      case hideScratchpadMethod:
        throw new Error("hide failed");
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
  for (const listener of [...(eventRuntime.eventListeners.get(name) ?? [])]) listener.dispatch({ data });
};
const editorOf = (renderer: ReturnType<typeof create>) => renderer.root.findByType(LiveMarkdownEditor);
const alertText = (renderer: ReturnType<typeof create>) => String(renderer.root.findByProps({ role: "alert" }).children[0]);

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
  assert.equal(editorOf(renderer).props.value, "");
  assert.equal(editorOf(renderer).props.caretOffset, 0);
  await act(async () => {
    emit(cleared, state("restored", 1, 5, 3));
  });

  const updateWithCaret = editorOf(renderer).props.onChangeWithCaret as (content: string, caret: number) => void;
  const firstSave = saveRequests.length;
  await act(async () => {
    updateWithCaret("local", 99);
    await flush();
  });
  assert.equal(saveRequests.length, firstSave + 1);
  assert.deepEqual(saveRequests[firstSave].request.args, ["local", 5, 1]);
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
  assert.deepEqual(saveRequests[caretSave].request.args, ["saved", 0, 1]);
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

  await act(async () => {
    emit(changed, state("event local", 1, 8, 4));
  });
  assert.equal(editorOf(renderer).props.value, "failed");
  assert.equal(editorOf(renderer).props.caretOffset, 2);

  const oldUpdate = editorOf(renderer).props.onChangeWithCaret as (content: string, caret: number) => void;
  await act(async () => {
    emit(changed, state("new generation", 2, 1, 1));
    oldUpdate("ignored", 0);
    emit(changed, state("stale generation", 1, 99, 0));
    emit(changed, state("stale revision", 2, 0, 0));
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
  overlay = create(createElement(Scratchpad, { overlay: true }));
  await act(async () => { await flush(); });
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
} finally {
  Events.Off(changed, cleared);
  setTransport(previousTransport);
  runtimeWindow.addEventListener = previousAddEventListener;
  runtimeWindow.removeEventListener = previousRemoveEventListener;
  runtimeWindow._wails = previousWails;
  if (previousElement === undefined) delete globalScope.Element;
  else Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
}
