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

const assets = files(fileURLToPath(new URL("../dist", import.meta.url)));
const metrics = assets.map((path) => {
  const data = readFileSync(path);
  return { path, raw: statSync(path).size, gzip: gzipSync(data).length };
});
const javascript = metrics.filter(({ path }) => path.endsWith(".js"));
const total = (key) => metrics.reduce((sum, item) => sum + item[key], 0);

console.log(
  `BenchmarkBundle/assets raw-B=${total("raw")} gzip-B=${total("gzip")} files=${metrics.length} js-chunks=${javascript.length} lazy-chunks=${Math.max(0, javascript.length - 1)}`,
);
for (const item of javascript.filter(({ path }) =>
  /\/(index|LiveMarkdownEditor|GraphView|ObjectTreeView|SourceMarkdownEditor|TimeTrackingView)-/.test(path),
)) {
  const name = basename(item.path).replace(/-[A-Za-z0-9_-]+\.js$/, "");
  console.log(`BenchmarkBundle/${name} raw-B=${item.raw} gzip-B=${item.gzip}`);
}
