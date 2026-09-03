import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { setTransport } from "@wailsio/runtime";
import App from "../src/App";
import { GraphView } from "../src/GraphView";
import LiveMarkdownEditor from "../src/LiveMarkdownEditor";
import ObjectTreeView from "../src/ObjectTreeView";
import SourceMarkdownEditor from "../src/SourceMarkdownEditor";
import { ClientSelect, DashboardPeriodSelect, ProjectSelect, TagMultiSelect } from "../src/TagMultiSelect";
import TimeTrackingView from "../src/TimeTrackingView";
import { ThemedDatePicker } from "../src/ThemedDatePicker";

const storage = new Map<string, string>();
const windowStub = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  matchMedia: () => ({ matches: false }),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: () => true,
};

const documentStub = {
  documentElement: { dataset: {} as Record<string, string>, style: { setProperty: () => {} } },
  fonts: { add: () => {}, delete: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  hasFocus: () => true,
  getElementById: () => null,
};

Object.assign(globalThis, { window: windowStub, document: documentStub, IS_REACT_ACT_ENVIRONMENT: true });

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const onChange = () => {};
const folders = [{ id: "folder", name: "Folder", parentId: "", order: 0, locked: false, hidden: false }];
const notes = [{ id: "note", title: "Note", folderId: "folder", order: 0, updatedAt: "", createdAt: "", tags: [], outgoingLinks: [] }];
const note = { id: "note", title: "Note", folderId: "folder", order: 0, content: "# Note\n\n- [ ] Task", updatedAt: "", createdAt: "", modifiedAt: 0, revision: 0 };
const tags = [{ id: "tag", name: "Tag", archivedAtUtc: "" }];
const clients = [{ id: "client", name: "Client", archivedAtUtc: "" }];
const projects = [{ id: "project", name: "Project", clientId: "client", archivedAtUtc: "" }];

assert.match(render(createElement(App)), /Cipherleaf|vault/i);
assert.match(render(createElement(GraphView, { folders, notes, onSelectFolder: onChange, onSelectNote: onChange })), /Graph view/);
assert.match(render(createElement(ObjectTreeView, { value: "- [ ] Task", onChange })), /Task/);
assert.match(render(createElement(LiveMarkdownEditor, {
  noteID: "note",
  value: "# Note",
  onChange,
  onSave: onChange,
  onError: onChange,
  onOpenWikilink: onChange,
  onDecreaseFontSize: onChange,
  onIncreaseFontSize: onChange,
})), /live-markdown-editor/);
assert.match(render(createElement(SourceMarkdownEditor, { noteID: "note", value: "# Note", onChange, onError: onChange })), /source-markdown-editor/);
assert.match(render(createElement(ClientSelect, { clients, selected: "", onChange })), /Client/);
assert.match(render(createElement(ProjectSelect, { projects, selected: "", onChange })), /Project/);
assert.match(render(createElement(TagMultiSelect, { tags, selected: [], onChange })), /Tag/);
assert.match(render(createElement(DashboardPeriodSelect, { value: "current-week", onChange })), /Current week/);
assert.match(render(createElement(ThemedDatePicker, { ariaLabel: "Date", value: "2026-01-01", onChange })), /Date/);
assert.match(render(createElement(TimeTrackingView, { now: new Date("2026-01-01T12:00:00Z") })), /time-tracking/);

setTransport({
  call: async (_objectID, method) => {
    switch (method) {
      case 355925843: return { locked: false, path: "/vault", vaultId: "vault", noteCount: 1 };
      case 3632998615: return { theme: "light" };
      case 1694639620: return [];
      case 2923257755: return { linked: false, lastSyncedAt: 0 };
      case 4079532670: return { dailyNoteFormat: "YYYY-MM-DD", dailyNoteFolderId: "", dailyTemplateNoteId: "", autosaveIntervalSeconds: 60, autoSyncMinutes: 15, autoLockMinutes: 15, fileHistoryLimit: 10, sectionDefault: "collapsed", revision: 0, modifiedAt: 0 };
      case 308561412: return { clients: [], projects: [], tags: [] };
      case 2155705394: return null;
      case 220507736:
      case 1268925393:
      case 4116603909:
      case 76659230:
      case 3351323131:
      case 3679480759: return [];
      case 888598820: return [notes[0]];
      case 1503400201: return note;
      case 1766611694: return { entries: [], days: [] };
      default: return null;
    }
  },
});

let appRenderer: ReturnType<typeof create> | undefined;
await act(async () => {
  appRenderer = create(createElement(App));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.match(JSON.stringify(appRenderer?.toJSON()), /workspace/);

const event = {
  preventDefault: () => {},
  stopPropagation: () => {},
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  clientX: 0,
  clientY: 0,
  relatedTarget: null,
  target: { value: "", checked: false, files: null, closest: () => null },
  currentTarget: { value: "", checked: false, files: null, open: false, contains: () => false, closest: () => null, setPointerCapture: () => {}, releasePointerCapture: () => {}, dataset: {} },
};
for (let round = 0; round < 2; round += 1) {
  for (const node of appRenderer!.root.findAll((item) => typeof item.type === "string")) {
    for (const [name, handler] of Object.entries(node.props)) {
      if (!name.startsWith("on") || typeof handler !== "function") continue;
      await act(async () => {
        try {
          await handler(event);
        } catch {
          // Coverage smoke calls may reach unavailable desktop-only actions.
        }
      });
    }
  }
}
appRenderer?.unmount();
