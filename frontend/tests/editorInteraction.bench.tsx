import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import LiveMarkdownEditor from "../src/LiveMarkdownEditor";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
Object.defineProperties(dom.window.Range.prototype, {
  getClientRects: { value: () => [], configurable: true },
  getBoundingClientRect: {
    value: () => new dom.window.DOMRect(),
    configurable: true,
  },
});
class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "NodeFilter",
  "Window",
  "MutationObserver",
  "DOMRect",
] as const) {
  Object.defineProperty(globalThis, name, {
    value: dom.window[name],
    configurable: true,
  });
}
Object.defineProperties(globalThis, {
  ResizeObserver: { value: ResizeObserverStub, configurable: true },
  getComputedStyle: { value: dom.window.getComputedStyle, configurable: true },
  requestAnimationFrame: {
    value: dom.window.requestAnimationFrame.bind(dom.window),
    configurable: true,
  },
  cancelAnimationFrame: {
    value: dom.window.cancelAnimationFrame.bind(dom.window),
    configurable: true,
  },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
  configurable: true,
});

const operations = 100;
const runs = 10;
const quantile = (values: number[], fraction: number) =>
  values[Math.ceil(values.length * fraction) - 1];
try {
  for (const lines of [100, 1_000, 10_000]) {
    const doc = Array.from({ length: lines }, (_, index) =>
      index % 5 === 0
        ? `> Section ${index}`
        : `  - [ ] Task ${index} with editable text`,
    ).join("\n");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    let lastChange = doc;
    await act(async () => {
      root.render(
        createElement(LiveMarkdownEditor, {
          noteID: "interaction-benchmark",
          value: doc,
          showToolbar: false,
          defaultSectionsCollapsed: false,
          onChange: (value) => {
            lastChange = value;
          },
          onSave() {},
          onError(error) {
            throw error;
          },
          onOpenWikilink() {},
        }),
      );
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    const position = view.state.doc.line(Math.floor(lines / 2) + 2).to;
    try {
      for (const workload of ["typing", "caret_move"] as const) {
        // Run zero warms the same path; each measured run starts from identical content and selection.
        for (let run = 0; run <= runs; run++) {
          await act(async () => {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: doc },
              selection: EditorSelection.cursor(position),
            });
          });
          const timings: number[] = [];
          await act(async () => {
            for (let operation = 0; operation < operations; operation++) {
              const started = performance.now();
              if (workload === "typing") {
                view.dispatch({
                  ...view.state.replaceSelection("x"),
                  userEvent: "input.type",
                });
              } else {
                const event = new dom.window.KeyboardEvent("keydown", {
                  key: operation % 2 === 0 ? "ArrowLeft" : "ArrowRight",
                  bubbles: true,
                  cancelable: true,
                });
                view.contentDOM.dispatchEvent(event);
                assert.equal(event.defaultPrevented, true);
              }
              timings.push(performance.now() - started);
            }
          });
          if (workload === "typing") {
            assert.equal(
              view.state.doc.toString(),
              `${doc.slice(0, position)}${"x".repeat(operations)}${doc.slice(position)}`,
            );
            assert.equal(lastChange, view.state.doc.toString());
            assert.equal(view.state.selection.main.head, position + operations);
          } else {
            assert.equal(view.state.doc.toString(), doc);
            assert.equal(view.state.selection.main.head, position);
          }
          if (run === 0) continue;
          const average =
            timings.reduce((sum, value) => sum + value, 0) / operations;
          timings.sort((left, right) => left - right);
          console.log(
            [
              `BenchmarkFrontend/live_editor_${workload}_${lines}_lines`,
              run,
              `${average.toFixed(6)} ms/op`,
              `operations=${operations}`,
              `p50-ms=${quantile(timings, 0.5).toFixed(6)}`,
              `p95-ms=${quantile(timings, 0.95).toFixed(6)}`,
              `max-ms=${timings.at(-1)!.toFixed(6)}`,
              `frame-miss=${timings.filter((value) => value > 1000 / 60).length}`,
              "environment=jsdom",
            ].join(" "),
          );
        }
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  }
} finally {
  dom.window.close();
}
