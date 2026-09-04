import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { memoryUsage } from "node:process";
import { EditorState } from "@codemirror/state";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appendCardContentJournal, appendCardJournalToMainEditor } from "../src/cardJournal.ts";
import {
  boardCardsForColumns,
  boardMarker,
  BOARD_COLUMNS,
  newCardMetadata,
  serializeCardDocument,
} from "../src/cards.ts";
import { relationshipLinks } from "../src/graphRelationships.ts";
import { parseObjectDocument } from "../src/objectDocument.ts";

const editorDocument = Array.from({ length: 10_000 }, (_, index) => `Line ${index}`).join("\n");
const graphNotes = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `note-${index}`,
  title: `Note ${index}`,
  outgoingLinks: [`Note ${(index + 1) % count}`],
}));

function benchmark<T>(name: string, run: () => T, metrics: (result: T) => string[] = () => []): T {
  let result = run();
  for (let index = 0; index < 10; index++) {
    globalThis.gc?.();
    const heapBefore = memoryUsage().heapUsed;
    const started = performance.now();
    result = run();
    const milliseconds = performance.now() - started;
    const memory = memoryUsage();
    const retainedBytes = Math.max(0, memory.heapUsed - heapBefore);
    console.log(
      [
        `BenchmarkFrontend/${name}`,
        index + 1,
        `${milliseconds.toFixed(6)} ms/op`,
        `${retainedBytes} heap-delta-B/op`,
        `rss-B=${memory.rss}`,
        `frame-miss=${milliseconds > 1000 / 60 ? 1 : 0}`,
        ...metrics(result),
      ].join(" "),
    );
  }
  return result;
}

assert.equal(
  benchmark(
    "editor_parse_10000_lines",
    () => parseObjectDocument(editorDocument),
    (document) => [`objects=${document.objects.length}`],
  ).objects.length,
  10_000,
);

let editorState = EditorState.create({ doc: editorDocument });
assert.equal(
  benchmark(
    "editor_typing_10000_lines",
    () => {
      editorState = editorState.update({ changes: { from: editorState.doc.length, insert: "x" } }).state;
      return parseObjectDocument(editorState.doc.toString());
    },
    (document) => [`parse-count=1`, `objects=${document.objects.length}`],
  ).objects.length,
  10_000,
);

for (const count of [100, 1_000, 10_000]) {
  const notes = graphNotes(count);
  assert.equal(
    benchmark(
      `link_graph_${count}_notes`,
      () => relationshipLinks(notes),
      (links) => [`edges=${links.length}`],
    ).length,
    count,
  );
}

const noteRows = Array.from({ length: 1_000 }, (_, index) =>
  React.createElement("li", { key: index }, `Note ${index}`),
);
assert.match(
  benchmark(
    "react_ssr_note_list_1000",
    () => renderToStaticMarkup(React.createElement("ul", null, noteRows)),
    () => [`commit-count=1`, `dom-nodes=1001`],
  ),
  /Note 999/,
);

const graphElements = [
  ...Array.from({ length: 1_000 }, (_, index) =>
    React.createElement("circle", { key: `node-${index}`, cx: index, cy: index, r: 1 }),
  ),
  ...Array.from({ length: 1_000 }, (_, index) =>
    React.createElement("line", { key: `edge-${index}`, x1: index, y1: index, x2: index + 1, y2: index + 1 }),
  ),
];
assert.match(
  benchmark(
    "react_ssr_graph_1000",
    () => renderToStaticMarkup(React.createElement("svg", null, graphElements)),
    () => [`commit-count=1`, `dom-nodes=2001`],
  ),
  /circle/,
);

const cardScaleDate = new Date("2026-09-03T12:00:00.000Z");
const cardScale = (count: number) => {
  const ids = Array.from({ length: count }, (_, index) => `card-${index}`);
  const cards = new Map(ids.map((id, index) => [
    id,
    {
      ...newCardMetadata(id, cardScaleDate),
      title: `Card ${index}`,
      status: BOARD_COLUMNS[index % BOARD_COLUMNS.length],
      boardID: "board-1",
    },
  ]));
  const metadata = {
    ...newCardMetadata("card-0", cardScaleDate),
    title: "Card 0",
    tags: ["Work"],
    boardID: "board-1",
  };
  const previousBody = "> Root\n  > Existing";
  const nextBody = "> Root\n  > Updated";
  const mainContent = [
    boardMarker("board-1", ids, "Main"),
    "> 2026-09-03",
    "  > Work",
    "    [ ] [card](note:card-0)",
    "      > Root",
    "        > Existing",
  ].join("\n");
  return { ids, cards, metadata, previousBody, nextBody, mainContent };
};

for (const count of [1, 10, 100, 1_000, 10_000]) {
  const { ids, cards, metadata, previousBody, nextBody, mainContent } = cardScale(count);
  assert.match(
    benchmark(
      `card_write_journal_${count}_cards`,
      () => appendCardContentJournal(previousBody, nextBody, metadata),
      (result) => [`payload-B=${result?.length ?? 0}`],
    ) ?? "",
    /Updated/,
  );
  assert.match(
    benchmark(
      `card_save_serialize_${count}_cards`,
      () => serializeCardDocument(metadata, nextBody),
      (result) => [`payload-B=${result.length}`],
    ),
    /cipherleaf-card: true/,
  );
  assert.equal(
    benchmark(
      `board_update_group_${count}_cards`,
      () => boardCardsForColumns(cards, ids),
      (result) => [`items/op=${[...result.values()].reduce((total, column) => total + column.length, 0)}`],
    ).get("not-started")?.length ?? 0,
    Math.ceil(count / BOARD_COLUMNS.length),
  );
  assert.match(
    benchmark(
      `main_editor_update_${count}_cards`,
      () => appendCardJournalToMainEditor(mainContent, previousBody, nextBody, metadata, cardScaleDate),
      (result) => [`payload-B=${result?.length ?? 0}`],
    ) ?? "",
    /Updated/,
  );
}
