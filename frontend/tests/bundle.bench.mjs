import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function bundleName(path) {
  const name = basename(path);
  const separator = name.lastIndexOf("-");
  return separator < 0 ? name : name.slice(0, separator);
}

const assets = files(fileURLToPath(new URL("../dist", import.meta.url)));
const metrics = assets.map((path) => {
  const data = readFileSync(path);
  return { path, raw: statSync(path).size, gzip: gzipSync(data).length };
});
const javascript = metrics.filter(({ path }) => path.endsWith(".js"));
const total = (key) => metrics.reduce((sum, item) => sum + item[key], 0);
const named = new Map(javascript.map((item) => [bundleName(item.path), item]));
const budgets = {
  assets: { raw: 2_500_000, gzip: 950_000 },
  index: { raw: 550_000, gzip: 170_000 },
  LiveMarkdownEditor: { raw: 160_000, gzip: 50_000 },
};

console.log(
  `BenchmarkBundle/assets raw-B=${total("raw")} gzip-B=${total("gzip")} files=${metrics.length} js-chunks=${javascript.length} lazy-chunks=${Math.max(0, javascript.length - 1)}`,
);
for (const item of javascript.filter(({ path }) =>
  /\/(index|LiveMarkdownEditor|GraphView|ObjectTreeView|SourceMarkdownEditor|TimeTrackingView)-/.test(path),
)) {
  const name = bundleName(item.path);
  console.log(`BenchmarkBundle/${name} raw-B=${item.raw} gzip-B=${item.gzip}`);
}

for (const [name, budget] of Object.entries(budgets)) {
  const actual = name === "assets"
    ? { raw: total("raw"), gzip: total("gzip") }
    : named.get(name);
  if (!actual || actual.raw > budget.raw || actual.gzip > budget.gzip) {
    throw new Error(
      `${name} bundle budget exceeded: ${actual?.raw ?? "missing"}/${actual?.gzip ?? "missing"} B ` +
      `(limits ${budget.raw}/${budget.gzip} B)`,
    );
  }
}
for (const required of ["LiveMarkdownEditor", "GraphView", "ObjectTreeView", "SourceMarkdownEditor", "TimeTrackingView"]) {
  if (!named.has(required)) throw new Error(`${required} must remain lazy-loaded`);
}
