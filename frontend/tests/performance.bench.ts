import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { memoryUsage } from "node:process";
import { relationshipLinks } from "../src/graphRelationships.ts";
import { parseObjectDocument } from "../src/objectDocument.ts";

const editorDocument = Array.from({ length: 10_000 }, (_, index) => `Line ${index}`).join("\n");
const graphNotes = Array.from({ length: 1_000 }, (_, index) => ({
  id: `note-${index}`,
  title: `Note ${index}`,
  outgoingLinks: [`Note ${(index + 1) % 1_000}`],
}));

function benchmark<T>(name: string, iterations: number, run: () => T): T {
  run();
  globalThis.gc?.();
  const heapBefore = memoryUsage().heapUsed;
  const results: T[] = [];
  const started = performance.now();
  for (let index = 0; index < iterations; index++) results.push(run());
  const milliseconds = (performance.now() - started) / iterations;
  const retainedBytes = Math.max(0, memoryUsage().heapUsed - heapBefore) / iterations;
  console.log(`${name}\t${milliseconds.toFixed(2)} ms/op\t${Math.round(retainedBytes)} retained B/op`);
  return results[results.length - 1];
}

assert.equal(benchmark("editor_10000_lines", 5, () => parseObjectDocument(editorDocument)).objects.length, 10_000);
assert.equal(benchmark("link_graph_1000_notes", 5, () => relationshipLinks(graphNotes)).length, 1_000);
