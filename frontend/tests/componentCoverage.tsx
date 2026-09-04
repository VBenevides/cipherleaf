import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { setTransport } from "@wailsio/runtime";
import App, { Icon, RunningTimerText, VaultStatisticsGrid, buildBreadcrumbItems, changedLineNumbers, cardMetadataFromSummary, folderIsHidden, folderIsLocked, folderLineage, folderName, formatStorageSize, isSameDay, isStructuredSummary, markdownForEditing, noteForEditing, startOfMonth, vaultSubmissionError } from "../src/App";
import { GraphView } from "../src/GraphView";
import LiveMarkdownEditor from "../src/LiveMarkdownEditor";
import ObjectTreeView from "../src/ObjectTreeView";
import SourceMarkdownEditor from "../src/SourceMarkdownEditor";
import { ClientSelect, DashboardPeriodSelect, ProjectSelect, TagMultiSelect } from "../src/TagMultiSelect";
import TimeTrackingView from "../src/TimeTrackingView";
import { ThemedDatePicker } from "../src/ThemedDatePicker";
import { SNIPPETS, completeCodeFenceElement, expandSnippet, expandSnippetWithContext, rollLastDatedSection } from "../src/snippets";
import { canonicalObjectDocumentFromMarkdown } from "../src/objectDocument";

const storage = new Map<string, string>();
const windowListeners = new Map<string, Set<(event: any) => void>>();
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
  addEventListener: (type: string, listener: (event: any) => void) => { const listeners = windowListeners.get(type) ?? new Set(); listeners.add(listener); windowListeners.set(type, listeners); },
  removeEventListener: (type: string, listener: (event: any) => void) => { windowListeners.get(type)?.delete(listener); },
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
const dispatchWindow = (type: string, event: any) => windowListeners.get(type)?.forEach((listener) => listener(event));

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const textContent = (node: { children: unknown[] }): string => node.children.map((child) => {
  if (typeof child === "string") return child;
  if (child && typeof child === "object" && "children" in child) return textContent(child as { children: unknown[] });
  return "";
}).join(" ");
const buttonNamed = (renderer: ReturnType<typeof create>, name: string) => renderer.root.findAll((node) => node.type === "button" && [textContent(node), node.props["aria-label"], node.props.title].some((value) => String(value ?? "").includes(name)))[0];
const onChange = () => {};
const folders = [{ id: "folder", name: "Folder", parentId: "", order: 0, locked: false, hidden: false }];
const notes = [{ id: "note", title: "Note", folderId: "folder", order: 0, updatedAt: "", createdAt: "", tags: [], outgoingLinks: [] }];
const note = { id: "note", title: "Note", folderId: "folder", order: 0, content: "# Note\n\n- [ ] Task", updatedAt: "", createdAt: "", modifiedAt: 0, revision: 0 };
const cardNote = { id: "card", title: "Card", folderId: "folder", order: 0, content: [
  "---", "cipherleaf-card: true", "cipherleaf-card-status: not-started", "cipherleaf-card-tags: [work]", "cipherleaf-card-created-at: 2026-01-01T12:00:00", "cipherleaf-card-started-at: 2026-01-02T12:00:00", "cipherleaf-card-finished-at: 2026-01-04T12:00:00", "---", "Card body",
].join("\n") };
const tags = [{ id: "tag", name: "Tag", archivedAtUtc: "" }];
const clients = [{ id: "client", name: "Client", archivedAtUtc: "" }];
const projects = [{ id: "project", name: "Project", clientId: "client", archivedAtUtc: "" }];
const archivedProject = { ...projects[0], id: "old-project", name: "Old project", archivedAtUtc: "2026-01-01" };
const archivedTag = { ...tags[0], id: "old-tag", name: "Old tag", archivedAtUtc: "2026-01-01" };
const archivedProjectResult = { ...projects[0], id: "archived-project", name: "Archived project", archivedAtUtc: "2026-01-01" };
const archivedTagResult = { ...tags[0], id: "archived-tag", name: "Archived tag", archivedAtUtc: "2026-01-01" };
const timeEntry = { id: "entry", name: "Task", clientId: "client", projectId: "project", tagIds: ["tag"], startedAtUtc: "2026-08-31T10:00:00Z", endedAtUtc: "2026-08-31T11:00:00Z", createdAtUtc: "2026-08-31T10:00:00Z", updatedAtUtc: "2026-08-31T11:00:00Z", modifiedAt: 1, revision: 1 };
const timeRange = { entry: timeEntry, startedAtUtc: timeEntry.startedAtUtc, endedAtUtc: timeEntry.endedAtUtc, totalSeconds: 3600 };
const syncResult = { linked: true, message: "Sync complete", warning: "", branch: "main", lastCommit: "commit", pull: { linked: true, message: "Pulled", warning: "", branch: "main", lastCommit: "commit", stagingPath: "", temporary: false }, push: { linked: true, message: "Pushed", warning: "", branch: "main", lastCommit: "commit", upToDate: true, localMilliseconds: 1, transportMilliseconds: 1, transportPerformed: true }, merge: { pulledNotes: 0, updatedNotes: 0, deletedNotes: 0, pulledFolders: 0, deletedFolders: 0, updatedSettings: false, upToDate: true, conflicts: [], trackingConflicts: [] }, timings: { pullMilliseconds: 1, mergeMilliseconds: 1, pushMilliseconds: 1, totalMilliseconds: 3, transportMilliseconds: 1, localMilliseconds: 2 }, git: { sshConnectionReuse: true, sshConnectionPersistSeconds: 1, transportOperations: 1, gitBytes: 1, repositoryFilesBytes: 1, platform: "test", architecture: "test", gitVersion: "git", openSshVersion: "ssh", usedPrefetch: true, repositoryPath: "/repo" } };
let conflictNext = false;
let timeTrackingMode: "normal" | "empty" | "error" = "normal";
const richFolders = [
  { id: "folder", name: "Folder", parentId: "", order: 0, locked: false, hidden: false },
  { id: "nested", name: "Nested", parentId: "folder", order: 0, locked: true, hidden: false },
];
const richNotes = [
  { ...notes[0], title: "Linked note", outgoingLinks: ["note", "Missing"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", modifiedAt: 1, revision: 1, attachmentIds: [] },
  { ...notes[0], id: "other-note", title: "Other note", outgoingLinks: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", modifiedAt: 2, revision: 1, attachmentIds: [] },
];
const richMarkdown = [
  "> Section",
  "  > [ ] Nested task",
  "- bullet",
  "- [x] checked",
  "```ts",
  "const value = 1;",
  "```",
  "![file](attachment:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
].join("\n");

assert.match(render(createElement(App)), /Cipherleaf|vault/i);
for (const name of ["book", "clock", "copy", "dots", "eye", "file", "folder", "graph", "lock", "plus", "search", "trash", "x", "menu"] as const) {
  assert.match(render(createElement(Icon, { name })), /svg/);
}
assert.match(render(createElement(RunningTimerText, { startedAtUtc: "2026-01-01T00:00:00Z" })), /\d/);
assert.match(render(createElement(VaultStatisticsGrid, { statistics: null })), /Notes/);
assert.match(render(createElement(VaultStatisticsGrid, { statistics: { notesBytes: 1, attachmentsBytes: 1024, timeTrackingBytes: 1024 ** 2, gitBytes: 1024 ** 3 } })), /Attachments/);
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
assert.match(render(createElement(GraphView, { folders: richFolders, notes: richNotes, onSelectFolder: onChange, onSelectNote: onChange })), /Knowledge links/);
assert.match(render(createElement(ObjectTreeView, { value: richMarkdown, onChange })), /Nested task/);
assert.match(render(createElement(GraphView, { folders: [], notes: [], onSelectFolder: onChange, onSelectNote: onChange })), /Create notes/);
assert.match(render(createElement(ObjectTreeView, { value: JSON.stringify({ format: "cipherleaf.object-document", version: 1, objects: [] }), onChange })), /No objects yet/);
assert.match(render(createElement(ObjectTreeView, { value: "[report.pdf](attachment:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)", onChange })), /Attachment syntax/);
assert.match(render(createElement(ThemedDatePicker, { ariaLabel: "Invalid date", value: "invalid", onChange })), /Select date/);

const graphRenderer = create(createElement(GraphView, { folders: richFolders, notes: richNotes, onSelectFolder: onChange, onSelectNote: onChange }));
await act(async () => { for (let i = 0; i < 20; i++) buttonNamed(graphRenderer, "Zoom out").props.onClick(); for (let i = 0; i < 20; i++) buttonNamed(graphRenderer, "Zoom in").props.onClick(); buttonNamed(graphRenderer, "Reset zoom").props.onClick(); buttonNamed(graphRenderer, "Folders").props.onClick(); });
const graphNodes = graphRenderer.root.findAll((node) => typeof node.props.onClick === "function" && String(node.props.className ?? "").includes("graph-node"));
await act(async () => { graphNodes.forEach((node) => { node.props.onClick(); node.props.onKeyDown({ key: "Enter", preventDefault: onChange }); }); });
await act(async () => { graphNodes.forEach((node) => { node.props.onKeyDown({ key: " ", preventDefault: onChange }); node.props.onKeyDown({ key: "Escape", preventDefault: onChange }); }); });
graphRenderer.unmount();

const tagRenderer = create(createElement(TagMultiSelect, { tags, selected: [], onChange }));
await act(async () => { tagRenderer.root.findAll((node) => node.type === "input")[0]?.props.onChange({ target: { checked: true } }); });
tagRenderer.unmount();
const selectedTagRenderer = create(createElement(TagMultiSelect, { tags, selected: ["tag"], onChange }));
await act(async () => { selectedTagRenderer.root.findAll((node) => node.type === "input")[0]?.props.onChange({ target: { checked: false } }); });
selectedTagRenderer.unmount();
const emptyTagRenderer = create(createElement(TagMultiSelect, { tags: [], selected: [], onChange }));
emptyTagRenderer.unmount();
for (const element of [
  createElement(ClientSelect, { clients, selected: "client", onChange, disabled: true }),
  createElement(ProjectSelect, { projects, selected: "project", onChange, disabled: true }),
  createElement(TagMultiSelect, { tags, selected: ["tag"], onChange, disabled: true }),
]) {
  const renderer = create(element);
  await act(async () => { renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } }); });
  renderer.unmount();
}
const clientRenderer = create(createElement(ClientSelect, { clients, selected: "", onChange }));
await act(async () => { clientRenderer.root.findAll((node) => node.type === "button")[0]?.props.onClick(); clientRenderer.root.findAll((node) => node.type === "button")[1]?.props.onClick(); });
clientRenderer.unmount();
const projectRenderer = create(createElement(ProjectSelect, { projects, selected: "", onChange }));
await act(async () => { projectRenderer.root.findAll((node) => node.type === "button")[0]?.props.onClick(); projectRenderer.root.findAll((node) => node.type === "button")[1]?.props.onClick(); });
projectRenderer.unmount();
const periodRenderer = create(createElement(DashboardPeriodSelect, { value: "current-week", onChange }));
for (const option of periodRenderer.root.findAll((node) => node.type === "button")) await act(async () => { option.props.onClick(); });
periodRenderer.unmount();
const filterClientRenderer = create(createElement(ClientSelect, { label: "Filter client", clients, selected: "missing", onChange }));
await act(async () => { filterClientRenderer.root.findAll((node) => node.type === "button")[0]?.props.onClick(); });
filterClientRenderer.unmount();
const filterProjectRenderer = create(createElement(ProjectSelect, { label: "Filter project", projects, selected: "missing", onChange }));
await act(async () => { filterProjectRenderer.root.findAll((node) => node.type === "button")[0]?.props.onClick(); });
filterProjectRenderer.unmount();
const dateRenderer = create(createElement(ThemedDatePicker, { ariaLabel: "Date", value: "2026-01-01", onChange }));
await act(async () => { dateRenderer.root.findByProps({ className: "themed-date-picker-trigger" }).props.onClick(); });
await act(async () => { dateRenderer.root.findAll((node) => node.type === "button").slice(1, 3).forEach((node) => node.props.onClick()); dateRenderer.root.findAll((node) => node.type === "button").at(-1)?.props.onClick(); });
dateRenderer.unmount();

const clone = { repository: "repo", sshKey: "key", branch: "main", passphrase: "secret", repositoryPrivate: true };
assert.equal(vaultSubmissionError("open", "", "", false, false, clone), null);
assert.match(vaultSubmissionError("create", "", "secret", true, true, clone) ?? "", /name/);
assert.match(vaultSubmissionError("create", "vault", "", false, false, clone) ?? "", /Copy/);
assert.match(vaultSubmissionError("clone", "vault", "secret", true, true, { ...clone, repositoryPrivate: false }) ?? "", /private/);
assert.equal(vaultSubmissionError("create", "vault", "secret", true, true, clone), null);
assert.equal(vaultSubmissionError("clone", "vault", "secret", true, true, clone), null);
assert.equal(folderName("/vault/"), "vault");
assert.equal(folderName(""), "Encrypted vault");
const folderMap = new Map(richFolders.map((item) => [item.id, item]));
assert.deepEqual(folderLineage("nested", folderMap).map((item) => item.id), ["folder", "nested"]);
assert.deepEqual(folderLineage("missing", folderMap), []);
assert.equal(folderIsLocked("nested", folderMap, new Set()), true);
assert.equal(folderIsLocked("nested", folderMap, new Set(["nested"])), false);
assert.equal(folderIsHidden("nested", folderMap), false);
assert.equal(folderIsHidden("hidden", new Map([["hidden", { ...folders[0], id: "hidden", hidden: true }]])), true);
assert.deepEqual(buildBreadcrumbItems([], "/vault", richFolders[0], note).map((item) => item.title), ["vault", "Folder", "Note"]);
assert.deepEqual(buildBreadcrumbItems([{ id: "note", title: "Trail" }], "/vault", undefined, null), [{ id: "note", title: "Trail" }]);
assert.deepEqual(buildBreadcrumbItems([], "/vault", undefined, { ...note, title: "" }).map((item) => item.title), ["vault", "Untitled"]);
assert.equal(startOfMonth(new Date(2026, 3, 24)).getDate(), 1);
assert.equal(isSameDay(new Date(2026, 3, 24), new Date(2026, 3, 24, 23)), true);
assert.equal(isSameDay(new Date(2026, 3, 24), new Date(2026, 3, 25)), false);
assert.equal(formatStorageSize(512), "512 B");
assert.equal(formatStorageSize(1024), "1.0 KB");
assert.equal(formatStorageSize(1024 ** 2), "1.0 MB");
assert.equal(formatStorageSize(1024 ** 3 * 10), "10 GB");
assert.equal(formatStorageSize(1024 ** 4 * 10), "10 TB");
assert.equal(markdownForEditing("plain"), "plain");
assert.equal(markdownForEditing(JSON.stringify(canonicalObjectDocumentFromMarkdown("> Stored"))), "> Stored");
const preparedNote = noteForEditing(note);
assert.equal(preparedNote.note.id, "note");
assert.equal(preparedNote.migrated, true);
assert.equal(noteForEditing({ ...note, content: JSON.stringify(canonicalObjectDocumentFromMarkdown("> Stored")) }).migrated, false);
assert.equal(cardMetadataFromSummary({ ...notes[0], properties: { "cipherleaf-card": true, "cipherleaf-card-status": "in-progress", "cipherleaf-card-tags": ["Tag", 1], "cipherleaf-card-started-at": "2026-01-01" } }).status, "in-progress");
assert.equal(cardMetadataFromSummary({ ...notes[0], properties: { "cipherleaf-card": true, "cipherleaf-card-write-changes-to-editor": true } }).writeChangesToEditor, true);
assert.equal(cardMetadataFromSummary({ ...notes[0], properties: { "cipherleaf-card": false } }), null);
assert.equal(cardMetadataFromSummary({ ...notes[0], properties: { "cipherleaf-card": true, "cipherleaf-card-status": "invalid" } }), null);
assert.equal(cardMetadataFromSummary({ ...notes[0], title: "", properties: { "cipherleaf-card": "true" } }).title, "Untitled");
assert.equal(cardMetadataFromSummary({ ...notes[0], properties: undefined }), null);
assert.equal(isStructuredSummary({ ...notes[0], properties: { "cipherleaf-card-template": "true" } }), true);
assert.equal(isStructuredSummary({ ...notes[0], properties: {} }), false);
assert.equal(isStructuredSummary({ ...notes[0], properties: { "cipherleaf-card": true } }), true);
assert.deepEqual([...changedLineNumbers("a\nb", "a\nc\nd")], [2, 3]);
assert.equal(completeCodeFenceElement("```"), "```txt\n\n```");
assert.equal(completeCodeFenceElement("- ```"), "```txt\n\n```");
assert.equal(completeCodeFenceElement("plain"), null);
assert.match(rollLastDatedSection("> 2026-01-01\n  > [ ] keep\n  > [x] done", new Date(2026, 0, 2)) ?? "", /2026-01-02/);
assert.equal(expandSnippet("unknown"), "/unknown");
for (const snippet of SNIPPETS) assert.ok(expandSnippet(snippet.trigger).length > 0);
assert.match(expandSnippetWithContext("rollb", "> 2026-01-01\n  > [ ] keep", "", new Date(2026, 0, 2)), /2026-01-02/);
assert.equal(expandSnippetWithContext("rollf", "", "> 2026-01-01\n  > [ ] next", new Date(2026, 0, 2)), "> 2026-01-02\n  > [ ] next");

let openCardMode = false;
let emptyAppMode = false;
let linkedAppMode = false;
let lockedAction: "create" | "clone" = "create";
setTransport({
  call: async (_objectID, _method, _windowName, request) => {
    if (timeTrackingMode === "error" && [308561412, 1766611694, 2155705394, 259867052].includes(request?.methodID ?? -1)) throw new Error("time tracking failed");
    switch (request?.methodID) {
      case 355925843: return { locked: false, path: "/vault", vaultId: "vault", noteCount: 2 };
      case 3632998615: return { path: "/vault", theme: "light" };
      case 1694639620: return ["/vault", "/other-vault"];
      case 2923257755: return linkedAppMode ? { linked: true, lastSyncedAt: 1, repositorySsh: "git@github.com:owner/repo.git", privateKeyPath: "/key", branch: "main", repositoryPrivate: true } : { linked: false, lastSyncedAt: 0 };
      case 4079532670: return { dailyNoteFormat: "YYYY-MM-DD", dailyNoteFolderId: "folder", dailyTemplateNoteId: "", autosaveIntervalSeconds: 60, autoSyncMinutes: 15, autoLockMinutes: 15, fileHistoryLimit: 10, sectionDefault: "collapsed", revision: 1, modifiedAt: 1 };
      case 308561412: return timeTrackingMode === "empty" ? { clients: [], projects: [], tags: [] } : { clients: [...clients, { id: "old-client", name: "Old client", archivedAtUtc: "2026-01-01" }], projects: [...projects, archivedProject], tags: [...tags, archivedTag] };
      case 259867052: return timeTrackingMode === "empty" ? { projectCount: 0, tagCount: 0, totalSeconds: 0, averageDaySeconds: 0, clients: [], projects: [], tags: [], tasks: [], days: [] } : { projectCount: 1, tagCount: 1, totalSeconds: 3600, averageDaySeconds: 600, clients: [{ id: "client", name: "Client", totalSeconds: 3600 }], projects: [{ id: "project", name: "Project", totalSeconds: 3600 }], tags: [{ id: "tag", name: "Tag", totalSeconds: 3600 }], tasks: [{ name: "Task", totalSeconds: 3600, entryCount: 1 }], days: [{ localDate: "2026-01-01", totalSeconds: 3600 }] };
      case 516244023: return [];
      case 2155705394: return null;
      case 220507736: return emptyAppMode ? [] : richFolders;
      case 888598820: return emptyAppMode ? [] : richNotes;
      case 1503400201: return openCardMode ? cardNote : note;
      case 715955408: return note;
      case 1766611694: return timeTrackingMode === "empty" ? { entries: [], days: [], totalSeconds: 0 } : { entries: [timeRange], days: [{ localDate: "2026-08-31", totalSeconds: 3600 }], totalSeconds: 3600 };
      case 1301789830: return { cpuPercent: 1, memoryBytes: 2, memoryUsage: [{ name: "cipherleaf", pid: 1, memoryBytes: 2 }] };
      case 3277829736: return { notesBytes: 2, attachmentsBytes: 3, timeTrackingBytes: 4, gitBytes: 5 };
      case 3351323131: return [{ id: "trash", kind: "note", title: "Deleted", deletedAt: "2026-01-01T00:00:00Z" }];
      case 2533964502: return [{ revision: 1, title: "Old", updatedAt: "2026-01-01T00:00:00Z" }];
      case 991868496: return [{ noteId: "note", title: "Note", folderId: "folder", field: "content", snippet: "Task", offset: 0, matchLength: 4, utf16Offset: 0, utf16MatchLength: 4 }];
      case 1932071061: return { replacedNotes: 1, replacements: 1 };
      case 2770680190: return { note, summary: richNotes[0] };
      case 814546393: return { locked: false, path: "/vault", vaultId: "vault", noteCount: 2 };
      case 2911480927: return note;
      case 239305947: return richFolders[0];
      case 4062770880: return clients[0];
      case 2039739724: return projects[0];
      case 1966438356:
      case 3548001575:
      case 1556478150: return projects[0];
      case 1532899813: return tags[0];
      case 2522910107: return tags[0];
      case 975015718: return clients[0];
      case 3424202037: return { id: "entry", name: "Task", startedAtUtc: "2026-01-01T11:00:00Z", endedAtUtc: "2026-01-01T12:00:00Z", tagIds: [] };
      case 4168033684: return archivedProjectResult;
      case 4267492704:
      case 1432466107: return timeEntry;
      case 2270152867: return null;
      case 2587329448: return { ...clients[0], archivedAtUtc: "2026-01-01" };
      case 2997005664: return clients[0];
      case 791124588: return projects[0];
      case 2265665421: return archivedTagResult;
      case 47787781: return tags[0];
      case 3410023864: {
        if (!conflictNext) return syncResult;
        conflictNext = false;
        return { ...syncResult, merge: { ...syncResult.merge, conflicts: [{ localNoteId: "note", remoteNoteId: "remote-note", title: "Merge conflict", message: "Remote edits need review.", localContent: "# Local\n", remoteContent: "# Remote\n" }], trackingConflicts: [{ id: "tracking", kind: "entry-edit", objectId: "entry", message: "Tracking entry changed remotely.", localEntry: timeEntry, remoteEntry: { ...timeEntry, name: "Remote task" } }] } };
      }
      case 974300788: return { linked: true, message: "Link complete", warning: "", branch: "main" };
      case 3947699405: return null;
      case 3056730288: return null;
      case 3801710036: return { locked: true, path: "/vault", vaultId: "", noteCount: 0 };
      case 4139522503: return { locked: true, path: "/vault", vaultId: "", noteCount: 0 };
      case 2182536893: return { id: "file", filename: "file.txt", mimeType: "text/plain", size: 12 };
      case 40245150: return "/export/file.txt";
      case 3438204788: return "/tmp/file.txt";
      case 1268925393: return [{ noteId: "other-note", title: "Other note", folderId: "folder", field: "content", snippet: "Linked note", offset: 0, matchLength: 4, utf16Offset: 0, utf16MatchLength: 4 }];
      case 4116603909: return [];
      case 3315011432: return "secret";
      case 1416189504: return { success: true, message: "Connection verified", warning: "", branch: "main" };
      case 3499492715: return { dailyNoteFormat: "YYYY-MM-DD", dailyNoteFolderId: "folder", dailyTemplateNoteId: "", autosaveIntervalSeconds: 60, autoSyncMinutes: 15, autoLockMinutes: 15, fileHistoryLimit: 10, sectionDefault: "collapsed", revision: 1, modifiedAt: 1 };
      case 1224618098: return "/backup";
      case 1927621820: return { notes: 1, attachments: 0, path: "/export" };
      case 1577812963: return { notes: 1, folders: 0, attachments: 0 };
      case 2357438882: return { linked: false, message: "Force push complete", warning: "", branch: "main", lastCommit: "", upToDate: true, localMilliseconds: 1, transportMilliseconds: 1, transportPerformed: true };
      case 3809458984: return "/vault";
      case 3679480759: return ["Arial", "Georgia"];
      case 76659230: return [];
      default: return null;
    }
  },
});

const trackingRenderer = create(createElement(TimeTrackingView, { now: new Date("2026-09-02T12:00:00Z") }));
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Month")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Dashboard")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 30)); });
await act(async () => {
  const task = trackingRenderer.root.findAll((node) => node.type === "button" && textContent(node).includes("Task"))[0];
  task?.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
await act(async () => {
  const task = trackingRenderer.root.findAll((node) => node.type === "button" && textContent(node).includes("Task"))[0];
  task?.props.onClick();
});
await act(async () => { buttonNamed(trackingRenderer, "Clients")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Archive")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Restore")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Delete")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { trackingRenderer.root.findAll((node) => node.type === "input" && String(node.props["aria-label"] ?? "").includes("client name"))[0]?.props.onChange({ target: { value: "New client" } }); trackingRenderer.root.findAll((node) => node.type === "form")[0]?.props.onSubmit({ preventDefault: onChange }); });
await act(async () => { buttonNamed(trackingRenderer, "Projects")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Edit")?.props.onClick(); });
await act(async () => { trackingRenderer.root.findAll((node) => node.type === "input" && String(node.props["aria-label"] ?? "").includes("project name"))[0]?.props.onChange({ target: { value: "Renamed project" } }); trackingRenderer.root.findAll((node) => node.type === "form")[0]?.props.onSubmit({ preventDefault: onChange }); });
await act(async () => { buttonNamed(trackingRenderer, "Archive")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Restore")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Delete")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { trackingRenderer.root.findAll((node) => node.type === "input" && String(node.props["aria-label"] ?? "").includes("project name"))[0]?.props.onChange({ target: { value: "New project" } }); trackingRenderer.root.findAll((node) => node.type === "form")[0]?.props.onSubmit({ preventDefault: onChange }); });
await act(async () => { buttonNamed(trackingRenderer, "Tags")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Edit")?.props.onClick(); });
await act(async () => { trackingRenderer.root.findAll((node) => node.type === "input" && String(node.props["aria-label"] ?? "").includes("tag name"))[0]?.props.onChange({ target: { value: "Renamed tag" } }); trackingRenderer.root.findAll((node) => node.type === "form")[0]?.props.onSubmit({ preventDefault: onChange }); });
await act(async () => { buttonNamed(trackingRenderer, "Archive")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Restore")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Delete")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Confirm")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { trackingRenderer.root.findAll((node) => node.type === "input" && String(node.props["aria-label"] ?? "").includes("tag name"))[0]?.props.onChange({ target: { value: "New tag" } }); trackingRenderer.root.findAll((node) => node.type === "form")[0]?.props.onSubmit({ preventDefault: onChange }); });
await act(async () => { buttonNamed(trackingRenderer, "Week")?.props.onClick(); });
await act(async () => {
  buttonNamed(trackingRenderer, "Previous")?.props.onClick();
  buttonNamed(trackingRenderer, "Current week")?.props.onClick();
  buttonNamed(trackingRenderer, "Next")?.props.onClick();
});
await act(async () => { trackingRenderer.root.findAll((node) => node.type === "form")[0]?.props.onSubmit({ preventDefault: onChange }); });
await act(async () => {
  trackingRenderer.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Task name")[0]?.props.onChange({ target: { value: "Running" } });
  trackingRenderer.root.findAll((node) => node.type === "form")[0]?.props.onSubmit({ preventDefault: onChange });
  await new Promise((resolve) => setTimeout(resolve, 0));
});
await act(async () => { buttonNamed(trackingRenderer, "Finish")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Finish timer")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(trackingRenderer, "Edit")?.props.onClick(); });
await act(async () => { buttonNamed(trackingRenderer, "Cancel")?.props.onClick(); });
await act(async () => { trackingRenderer.unmount(); });

const entryRenderer = create(createElement(TimeTrackingView, { now: new Date("2026-09-02T12:00:00Z") }));
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const entryDay = entryRenderer.root.findAll((node) => node.type === "button" && textContent(node).includes("Task"))[0];
await act(async () => { entryDay?.props.onClick(); });
await act(async () => { entryRenderer.root.findAll((node) => node.type === "button" && textContent(node) === "Edit")[0]?.props.onClick(); });
await act(async () => { entryRenderer.root.findAll((node) => node.type === "button" && textContent(node) === "Cancel").at(-1)?.props.onClick(); });
await act(async () => { entryRenderer.unmount(); });

timeTrackingMode = "error";
const errorTrackingRenderer = create(createElement(TimeTrackingView, { now: new Date("2026-09-02T12:00:00Z") }));
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(errorTrackingRenderer.root.findAll((node) => node.props.role === "alert").length, 1);
await act(async () => { buttonNamed(errorTrackingRenderer, "Month")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(errorTrackingRenderer, "Dashboard")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
errorTrackingRenderer.unmount();
timeTrackingMode = "empty";
const emptyTrackingRenderer = create(createElement(TimeTrackingView, { now: new Date("2026-09-02T12:00:00Z") }));
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); buttonNamed(emptyTrackingRenderer, "Dashboard")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { buttonNamed(emptyTrackingRenderer, "Custom")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
emptyTrackingRenderer.unmount();
timeTrackingMode = "normal";

let appRenderer: ReturnType<typeof create> | undefined;
await act(async () => {
  appRenderer = create(createElement(App));
  await new Promise((resolve) => setTimeout(resolve, 100));
});
assert.match(JSON.stringify(appRenderer?.toJSON()), /workspace/);
const appButton = (name: string) => appRenderer?.root.findAll((node) => node.type === "button" && [textContent(node), node.props["aria-label"], node.props.title].some((value) => String(value ?? "").trim() === name))[0];
const appButtonStarting = (name: string) => appRenderer?.root.findAll((node) => node.type === "button" && [textContent(node), node.props["aria-label"], node.props.title].some((value) => String(value ?? "").trim().startsWith(name)))[0];
const buttonEvent = { preventDefault: onChange, stopPropagation: onChange, currentTarget: { closest: () => ({ removeAttribute: onChange }) } };
const clickApp = async (name: string) => {
  const button = appButton(name);
  assert.ok(button, `missing app button: ${name}`);
  await act(async () => { button.props.onClick?.(buttonEvent); await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const clickAppStarting = async (name: string) => {
  const button = appButtonStarting(name);
  assert.ok(button, `missing app button: ${name}`);
  await act(async () => { button.props.onClick?.(buttonEvent); await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const clickAppContaining = async (name: string) => {
  const button = appRenderer?.root.findAll((node) => node.type === "button" && [textContent(node), node.props["aria-label"], node.props.title].some((value) => String(value ?? "").includes(name)))[0];
  assert.ok(button, `missing app button: ${name}`);
  await act(async () => { button.props.onClick?.(buttonEvent); await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const clickLastApp = async (name: string) => {
  const buttons = appRenderer?.root.findAll((node) => node.type === "button" && [textContent(node), node.props["aria-label"], node.props.title].some((value) => String(value ?? "").trim() === name));
  const button = buttons?.at(-1);
  assert.ok(button, `missing app button: ${name}`);
  await act(async () => { button.props.onClick?.(buttonEvent); await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const waitForApp = () => new Promise((resolve) => setTimeout(resolve, 10));
const completePrompt = async (trigger: string, value: string) => {
  await clickApp(trigger);
  await act(async () => {
    const input = appRenderer?.root.findAll((node) => node.type === "input" && node.props.type === "text").at(-1);
    input?.props.onChange({ target: { value } });
    appRenderer?.root.findAll((node) => node.type === "form" && String(node.props.className ?? "").includes("app-dialog-modal")).at(-1)?.props.onSubmit({ preventDefault: onChange });
  });
};
const completeFolderPassword = async (submitLabel: string) => {
  await act(async () => {
    const input = appRenderer?.root.findAll((node) => node.type === "input" && node.props.type === "password").at(-1);
    input?.props.onChange({ target: { value: "folder-secret" } });
    appRenderer?.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Show password").at(-1)?.props.onClick();
    appRenderer?.root.findAll((node) => node.type === "form" && String(node.props.className ?? "").includes("folder-password-modal")).at(-1)?.props.onSubmit({ preventDefault: onChange });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const submitAppDialog = async () => {
  await act(async () => {
    appRenderer?.root.findAll((node) => node.type === "form" && String(node.props.className ?? "").includes("app-dialog-modal")).at(-1)?.props.onSubmit({ preventDefault: onChange });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};
const liveEditor = appRenderer?.root.findAll((node) => typeof node.type === "function" && (node.type as Function).name === "LiveMarkdownEditor")[0];
assert.ok(liveEditor);
openCardMode = true;
await act(async () => { await liveEditor.props.onOpenCard("card"); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.ok(appRenderer?.root.findAll((node) => node.props["aria-label"] === "Card details").length);
assert.equal(textContent(appRenderer!.root.findByProps({ "aria-label": "Card dates" })), "Created At:  2026-01-01  | Started At:  2026-01-02  | Blocked on:  -  | Finished At:  2026-01-04");
const cardTitle = appRenderer?.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Title")[0];
await act(async () => { cardTitle?.props.onChange({ target: { value: "Updated card" } }); });
await act(async () => {
  dispatchWindow("keydown", { key: "Escape", preventDefault: onChange });
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.ok(appRenderer?.root.findAll((node) => node.props.children === "Discard unsaved changes?").length);
await submitAppDialog();
assert.equal(appRenderer?.root.findAll((node) => node.props["aria-label"] === "Card details").length, 0);
await act(async () => { await liveEditor.props.onOpenCard("card"); await new Promise((resolve) => setTimeout(resolve, 0)); });
const writeCardChanges = appRenderer?.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Write changes to editor")[0];
assert.equal(writeCardChanges?.props.checked, false);
await act(async () => { writeCardChanges?.props.onChange({ target: { checked: true } }); });
const cardStatus = appRenderer?.root.findAll((node) => node.type === "button" && node.props.role === "option")[0];
await act(async () => { cardStatus?.props.onClick(); });
const cardTagInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "New tag")[0];
await act(async () => { cardTagInput?.props.onChange({ target: { value: "urgent" } }); });
const addTag = appRenderer?.root.findAll((node) => node.type === "button" && textContent(node) === "Add tag")[0];
await act(async () => { addTag?.props.onClick(); });
await clickApp("Save card");
assert.equal(appRenderer?.root.findAll((node) => node.props["aria-label"] === "Card details").length, 0);
await act(async () => { await liveEditor.props.onOpenCard("card"); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => {
  dispatchWindow("keydown", {
    ctrlKey: true,
    metaKey: false,
    key: "s",
    target: { closest: (selector: string) => selector === ".card-sidebar" ? {} : null },
    preventDefault: onChange,
    stopPropagation: onChange,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.equal(appRenderer?.root.findAll((node) => node.props["aria-label"] === "Card details").length, 0);
await act(async () => { await liveEditor.props.onOpenCard("card"); await new Promise((resolve) => setTimeout(resolve, 0)); });
await clickApp("Save as template");
await clickApp("Delete template");
await clickApp("Delete card");
await clickLastApp("Delete card");
openCardMode = false;
const noteRow = appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("note-list-item"))[0];
await act(async () => { noteRow?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickApp("Open in a New Tab");
await clickLastApp("Close Note");
await act(async () => { noteRow?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickApp("Delete note");
await submitAppDialog();
const folderRow = appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("folder-list-item") && typeof node.props.onContextMenu === "function")[0];
await act(async () => { folderRow?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickApp("Rename folder");
await act(async () => {
  const input = appRenderer?.root.findAll((node) => node.type === "input" && node.props.value === "Folder")[0];
  input?.props.onChange({ target: { value: "Renamed" } });
});
await clickApp("Rename folder");
await completePrompt("Create folder", "New folder");
await act(async () => {
  const folder = appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("folder-list-item") && typeof node.props.onContextMenu === "function")[0];
  folder?.props.onContextMenu({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 });
});
await clickApp("Hide notes");
await act(async () => {
  const folder = appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("folder-list-item") && typeof node.props.onContextMenu === "function")[0];
  folder?.props.onContextMenu({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 });
});
await clickAppStarting("Sort:");
const nestedFolder = () => appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("folder-list-item") && textContent(node).includes("Nested"))[0];
await act(async () => { nestedFolder()?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickApp("Remove lock");
await completeFolderPassword("Remove lock");
const normalFolder = () => appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("folder-list-item") && textContent(node).includes("Folder") && !textContent(node).includes("Nested"))[0];
await act(async () => { normalFolder()?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickAppContaining("Lock folder");
await completeFolderPassword("Lock folder");
await act(async () => { normalFolder()?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickApp("New subfolder");
await act(async () => {
  const input = appRenderer?.root.findAll((node) => node.type === "input" && node.props.type === "text").at(-1);
  input?.props.onChange({ target: { value: "Child" } });
  appRenderer?.root.findAll((node) => node.type === "form" && String(node.props.className ?? "").includes("app-dialog-modal")).at(-1)?.props.onSubmit({ preventDefault: onChange });
});
await act(async () => { normalFolder()?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickApp("Delete empty folder");
await submitAppDialog();
const movableNote = () => appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("note-list-item"))[0];
await act(async () => { movableNote()?.props.onContextMenu?.({ preventDefault: onChange, stopPropagation: onChange, clientX: 10, clientY: 20 }); });
await clickApp("Unfiled");
await clickApp("Settings");
await clickApp("Settings…");
await clickApp("General");
await clickApp("Daily notes");
await clickApp("Auto-save");
await clickApp("Auto-sync");
await clickApp("Vault lock");
await clickApp("Section state");
await act(async () => {
  appRenderer?.root.findAll((node) => node.type === "input" && node.props.type !== "file").forEach((input) => input.props.onChange?.({ target: { value: input.props.type === "number" ? "2" : "changed", checked: true } }));
  appRenderer?.root.findAll((node) => node.type === "select").forEach((select) => select.props.onChange?.({ target: { value: "folder" } }));
});
await clickApp("Appearance");
await clickApp("Theme");
await clickApp("Dark (Nord)");
await clickApp("Guide lines");
await clickApp("Dotted");
await clickApp("Text size");
const originalWindowTimeout = windowStub.setTimeout;
windowStub.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => delay && delay >= 600_000 ? 0 : setTimeout(callback, delay, ...args)) as typeof windowStub.setTimeout;
await clickApp("Installed fonts…");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
await clickApp("Georgia");
windowStub.setTimeout = originalWindowTimeout;
await clickApp("Reset");
await clickApp("Close settings");
await clickApp("Settings");
await clickApp("Application statistics…");
await clickApp("Close statistics");
await clickApp("Settings");
await clickApp("Log");
await clickApp("Clear");
await clickApp("Close log");
await clickApp("File");
await clickAppContaining("New file");
await clickApp("File");
await clickApp("Attach encrypted file…");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
await clickApp("Export / open");
await clickApp("Remove");
await clickApp("File");
await clickApp("Import Markdown folder…");
await clickApp("File");
await clickApp("Export plaintext Markdown…");
await clickLastApp("Export plaintext");
await clickApp("Vault");
await clickApp("Vault Settings…");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
await clickApp("Forget remembered secret");
await clickApp("Test connection");
await act(async () => {
  const history = appRenderer?.root.findAll((node) => node.type === "input" && node.props.type === "number")[0];
  history?.props.onChange({ target: { value: "2" } });
});
await clickApp("Save");
await clickLastApp("Save");
await clickApp("Browse…");
await act(async () => {
  const backup = appRenderer?.root.findAll((node) => node.type === "input" && node.props.placeholder === "Disabled")[0];
  backup?.props.onChange({ target: { value: "/backup" } });
});
await clickLastApp("Save");
await act(async () => {
  const backup = appRenderer?.root.findAll((node) => node.type === "input" && node.props.placeholder === "Disabled")[0];
  backup?.props.onChange({ target: { value: "" } });
});
await clickLastApp("Save");
await clickApp("Pull remote and link");
await clickApp("Close settings");
await clickApp("Vault");
await clickApp("Trash and version history…");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
await clickApp("Restore");
await clickLastApp("Delete");
await clickLastApp("Delete permanently");
await clickApp("Close recovery");
await clickApp("Graph view");
await waitForApp();
await clickApp("Open sidebar");
await clickAppStarting("All notes");
await clickApp("Time tracking");
await waitForApp();
await clickApp("Dashboard");
await waitForApp();
await clickApp("Month");
await waitForApp();
await clickApp("Week");
await clickApp("Open sidebar");
await clickAppStarting("All notes");
await clickApp("Object Tree");
await waitForApp();
await clickApp("Markdown");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
await act(async () => {
  appRenderer?.root.findAll((node) => typeof node.type === "function" && (node.type as Function).name === "SourceMarkdownEditor").forEach((editor) => {
    editor.props.onChange?.("# Changed from source");
    editor.props.onError?.(new Error("source error"));
  });
  appRenderer?.root.findAll((node) => node.props["aria-label"] === "Backlinks").forEach((panel) => panel.findAll((child) => child.type === "button")[0]?.props.onClick?.(buttonEvent));
});
await clickApp("Live Preview");
const titleInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props.className === "title-input")[0];
await act(async () => { titleInput?.props.onChange({ target: { value: "Edited note" } }); });
await clickApp("Save this note (Ctrl + S)");
await act(async () => { appRenderer?.root.findByProps({ className: "new-note-tab" }).props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { appRenderer?.root.findAll((node) => node.props.role === "tab")[0]?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
await act(async () => { appRenderer?.root.findByProps({ "aria-label": "Close New tab" }).props.onClick(); });
const dragRect = { top: 0, height: 100 };
const noteRows = () => appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("note-list-item"));
await act(async () => {
  const rows = noteRows() ?? [];
  rows[0]?.props.onMouseDown({ button: 0 });
  rows[1]?.props.onMouseEnter({ buttons: 1, clientY: 80, currentTarget: { getBoundingClientRect: () => dragRect } });
  rows[1]?.props.onMouseUp({ clientY: 80, currentTarget: { getBoundingClientRect: () => dragRect } });
  await new Promise((resolve) => setTimeout(resolve, 10));
});
await act(async () => {
  const rows = appRenderer?.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("folder-list-item") && typeof node.props.onMouseDown === "function") ?? [];
  rows[0]?.props.onMouseDown({ button: 0 });
  rows[1]?.props.onMouseEnter({ buttons: 1, clientY: 20, currentTarget: { getBoundingClientRect: () => dragRect } });
  rows[1]?.props.onMouseUp({ clientY: 20, currentTarget: { getBoundingClientRect: () => dragRect } });
  await new Promise((resolve) => setTimeout(resolve, 10));
});
await clickAppStarting("Open calendar");
await clickApp("Previous month");
await clickApp("Next month");
await clickApp("Close calendar");
await clickAppStarting("Open calendar");
await clickApp("Today");
await act(async () => { appRenderer?.root.findAll((node) => node.type === "button" && String(node.props.className ?? "").includes("calendar-day"))[0]?.props.onClick?.(buttonEvent); });
await clickApp("Open daily note");
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: true, key: "P", preventDefault: onChange, target: { closest: () => null } });
await waitForApp();
const paletteInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Search commands")[0];
await act(async () => { paletteInput?.props.onChange({ target: { value: "sidebar" } }); });
await clickAppContaining("Toggle sidebar");
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: false, key: "k", preventDefault: onChange });
await waitForApp();
const quickInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props.placeholder === "Type a note title")[0];
await act(async () => { quickInput?.props.onChange({ target: { value: "Note" } }); quickInput?.props.onKeyDown({ key: "Enter" }); });
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: true, key: "P", preventDefault: onChange, target: { closest: () => null } });
await waitForApp();
const timerPaletteInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Search commands")[0];
await act(async () => { timerPaletteInput?.props.onChange({ target: { value: "Start timer" } }); });
await clickAppContaining("Start timer");
await act(async () => {
  const input = appRenderer?.root.findAll((node) => node.type === "input" && node.props.autoFocus)[0];
  input?.props.onChange({ target: { value: "Tracked task" } });
  appRenderer?.root.findAll((node) => node.type === "form").at(-1)?.props.onSubmit({ preventDefault: onChange });
  await new Promise((resolve) => setTimeout(resolve, 10));
});
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: true, key: "P", preventDefault: onChange, target: { closest: () => null } });
await waitForApp();
const finishPaletteInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Search commands")[0];
await act(async () => { finishPaletteInput?.props.onChange({ target: { value: "Finish timer" } }); });
await clickAppContaining("Finish timer");
await clickApp("Finish timer");
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: true, key: "f", preventDefault: onChange });
await waitForApp();
const searchInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props.placeholder?.startsWith("Search text"))[0];
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
await act(async () => { searchInput?.props.onChange({ target: { value: "Task" } }); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
const globalResult = appRenderer?.root.findAll((node) => node.type === "button" && node.props.className === "global-search-result")[0];
assert.ok(globalResult, "missing global search result");
await act(async () => { globalResult.props.onClick?.(buttonEvent); await new Promise((resolve) => setTimeout(resolve, 0)); });
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: true, key: "f", preventDefault: onChange });
await waitForApp();
await clickApp("Close");
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: false, key: "k", preventDefault: onChange });
await waitForApp();
const createQuickInput = appRenderer?.root.findAll((node) => node.type === "input" && node.props.placeholder === "Type a note title")[0];
await act(async () => { createQuickInput?.props.onChange({ target: { value: "Brand new" } }); await new Promise((resolve) => setTimeout(resolve, 0)); });
const createQuickResult = appRenderer?.root.findAll((node) => node.type === "button" && textContent(node).includes("Create"))[0];
assert.ok(createQuickResult, "missing quick create result");
await act(async () => { createQuickResult.props.onClick?.(buttonEvent); await new Promise((resolve) => setTimeout(resolve, 0)); });
dispatchWindow("keydown", { ctrlKey: true, metaKey: false, shiftKey: true, key: "h", preventDefault: onChange });
await waitForApp();
const replaceInputs = appRenderer?.root.findAll((node) => node.type === "input" && node.props.className === "global-search-input");
await act(async () => { replaceInputs?.[0]?.props.onChange({ target: { value: "Task" } }); replaceInputs?.[1]?.props.onChange({ target: { value: "Done" } }); await new Promise((resolve) => setTimeout(resolve, 250)); });
await clickApp("Replace all");
await clickLastApp("Replace");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
await clickApp("Close");
await act(async () => { appRenderer?.unmount(); });

linkedAppMode = true;
let linkedRenderer: ReturnType<typeof create> | undefined;
await act(async () => {
  linkedRenderer = create(createElement(App));
  await new Promise((resolve) => setTimeout(resolve, 100));
});
const linkedButton = (name: string) => linkedRenderer?.root.findAll((node) => node.type === "button" && [textContent(node), node.props["aria-label"], node.props.title].some((value) => String(value ?? "").includes(name)))[0];
const clickLinked = async (name: string) => {
  const button = linkedButton(name);
  assert.ok(button, `missing linked app button: ${name}`);
  await act(async () => { button.props.onClick?.(buttonEvent); await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const submitLinkedDialog = async () => {
  await act(async () => { linkedRenderer?.root.findAll((node) => node.type === "form" && String(node.props.className ?? "").includes("app-dialog-modal")).at(-1)?.props.onSubmit({ preventDefault: onChange }); await new Promise((resolve) => setTimeout(resolve, 20)); });
};
await clickLinked("File");
await clickLinked("Save file and sync");
conflictNext = true;
await clickLinked("Vault");
await clickLinked("Sync vault");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
await clickLinked("Save merged file");
await submitLinkedDialog();
await clickLinked("Keep local");
conflictNext = true;
await clickLinked("Vault");
await clickLinked("Sync vault");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
assert.match(JSON.stringify(linkedRenderer?.toJSON()), /Force push local vault/);
await clickLinked("Force push local vault");
await submitLinkedDialog();
await clickLinked("Vault");
await clickLinked("Vault Settings…");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
await clickLinked("Open Git terminal");
await clickLinked("Test connection");
await clickLinked("Unlink vault");
await submitLinkedDialog();
await clickLinked("Close settings");
await clickLinked("Vault");
await clickLinked("New vault");
await clickLinked("Vault");
await clickLinked("Change vault");
await clickLinked("File");
await clickLinked("Close application");
await clickLinked("Vault");
await clickLinked("Close vault");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
assert.match(JSON.stringify(linkedRenderer?.toJSON()), /Your thoughts/);
await act(async () => { linkedRenderer?.unmount(); });
linkedAppMode = false;

emptyAppMode = true;
const emptyRenderer = create(createElement(App));
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
assert.match(JSON.stringify(emptyRenderer.toJSON()), /A fresh page is waiting/);
const emptyButton = (name: string) => emptyRenderer.root.findAll((node) => node.type === "button" && textContent(node).includes(name))[0];
await act(async () => { emptyButton("New note")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.match(JSON.stringify(emptyRenderer.toJSON()), /Note|Untitled/);
await act(async () => { emptyRenderer.unmount(); });
emptyAppMode = false;

setTransport({
  call: async (_objectID, _method, _windowName, request) => {
    switch (request?.methodID) {
      case 355925843: return { locked: true, path: "/vault", vaultId: "", noteCount: 0 };
      case 3632998615: return { path: "/vault", theme: "light" };
      case 3809458984: return "/last-vault";
      case 2449201265:
      case 2686336143: return "/new-vault";
      case 3315011432: return "generated-secret";
      case 3868872474: return null;
      case 814546393: return lockedAction === "create" ? { locked: false, path: "/new-vault", vaultId: "new-vault", noteCount: 0 } : null;
      case 3036187677: return { session: { locked: false, path: "/cloned-vault", vaultId: "cloned-vault", noteCount: 0 }, warning: "", linked: true };
      case 2923257755: return { linked: false, lastSyncedAt: 0 };
      case 2911480927: return { id: "welcome", title: "Welcome", folderId: "", order: 0, content: "# Welcome", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", modifiedAt: 1, revision: 1 };
      case 2770680190: return { note: { id: "welcome", title: "Welcome", folderId: "", order: 0, content: "# Welcome", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", modifiedAt: 1, revision: 1 }, summary: { id: "welcome", title: "Welcome", folderId: "", order: 0, content: "# Welcome" } };
      default: return null;
    }
  },
});
let lockedRenderer: ReturnType<typeof create> | undefined;
await act(async () => {
  lockedRenderer = create(createElement(App));
  await new Promise((resolve) => setTimeout(resolve, 100));
});
assert.match(JSON.stringify(lockedRenderer?.toJSON()), /Your thoughts/);
const lockedButton = (name: string) => lockedRenderer?.root.findAll((node) => node.type === "button" && textContent(node).includes(name))[0];
await act(async () => { lockedButton("Create a new vault")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.match(JSON.stringify(lockedRenderer?.toJSON()), /Create a vault/);
await act(async () => {
  const inputs = lockedRenderer?.root.findAll((node) => node.type === "input") ?? [];
  inputs.find((input) => input.props.placeholder === "Personal notes")?.props.onChange({ target: { value: "New vault" } });
  lockedRenderer?.root.findAll((node) => node.type === "button" && textContent(node).includes("Copy"))[0]?.props.onClick();
  inputs.find((input) => input.props.type === "checkbox")?.props.onChange({ target: { checked: true } });
});
await act(async () => { lockedRenderer?.root.findAll((node) => node.type === "form").at(-1)?.props.onSubmit({ preventDefault: onChange }); await new Promise((resolve) => setTimeout(resolve, 50)); });
assert.match(JSON.stringify(lockedRenderer?.toJSON()), /workspace/);
await act(async () => { lockedRenderer?.unmount(); });

lockedAction = "clone";
let cloneRenderer: ReturnType<typeof create> | undefined;
await act(async () => {
  cloneRenderer = create(createElement(App));
  await new Promise((resolve) => setTimeout(resolve, 100));
});
const cloneButton = (name: string) => cloneRenderer?.root.findAll((node) => node.type === "button" && textContent(node).includes(name))[0];
await act(async () => { cloneButton("Clone from GitHub")?.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.match(JSON.stringify(cloneRenderer?.toJSON()), /Clone from GitHub/);
await act(async () => {
  const inputs = cloneRenderer?.root.findAll((node) => node.type === "input") ?? [];
  inputs.find((input) => input.props.placeholder === "Personal notes")?.props.onChange({ target: { value: "Clone" } });
  inputs.find((input) => input.props.placeholder?.startsWith("git@"))?.props.onChange({ target: { value: "git@github.com:owner/repo.git" } });
  inputs.find((input) => input.props.placeholder?.startsWith("/home"))?.props.onChange({ target: { value: "/key" } });
  inputs.find((input) => input.props.type === "password")?.props.onChange({ target: { value: "secret" } });
  inputs.find((input) => input.props.type === "checkbox")?.props.onChange({ target: { checked: true } });
});
await act(async () => { cloneRenderer?.root.findAll((node) => node.type === "form").at(-1)?.props.onSubmit({ preventDefault: onChange }); await new Promise((resolve) => setTimeout(resolve, 50)); });
assert.match(JSON.stringify(cloneRenderer?.toJSON()), /workspace/);
await act(async () => { cloneRenderer?.unmount(); });
