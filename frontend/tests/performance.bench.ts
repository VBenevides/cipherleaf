import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { memoryUsage } from "node:process";
import { EditorState } from "@codemirror/state";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
