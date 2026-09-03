import { readFileSync } from "node:fs";

const samples = new Map();
const bundles = [];

function add(name, operations, milliseconds, metrics = {}) {
  const values = samples.get(name) ?? [];
  values.push({ operations, milliseconds, metrics });
  samples.set(name, values);
}

function equalsMetrics(text) {
  const metrics = {};
  for (const token of text.trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator < 1) continue;
    metrics[token.slice(0, separator)] = Number(token.slice(separator + 1));
  }
  return metrics;
}

for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  const match = line.match(/^Benchmark(.+)-\d+\s+(\d+)\s+([\d.]+)\s+ns\/op(.*)$/);
  if (!match) continue;
  const metrics = {};
  const metricTokens = match[4].trim().split(/\s+/);
  for (let index = 0; index + 1 < metricTokens.length; index += 2) {
    metrics[metricTokens[index + 1]] = Number(metricTokens[index]);
  }
  add(`go/${match[1]}`, Number(match[2]), Number(match[3]) / 1e6, metrics);
}

for (const line of readFileSync(process.argv[3], "utf8").split("\n")) {
  const match = line.match(
    /^BenchmarkFrontend\/(\S+)\s+\d+\s+([\d.]+)\s+ms\/op\s+(\d+)\s+heap-delta-B\/op(.*)$/,
  );
  if (match) add(`frontend/${match[1]}`, 1, Number(match[2]), {
    "B/op": Number(match[3]),
    ...equalsMetrics(match[4]),
  });
}

for (const line of readFileSync(process.argv[4], "utf8").split("\n")) {
  if (!line.startsWith("BenchmarkBundle/")) continue;
  const [name, ...metricTokens] = line.slice("BenchmarkBundle/".length).trim().split(/\s+/);
  bundles.push({ name, metrics: equalsMetrics(metricTokens.join(" ")) });
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length === 1
    ? 0
    : values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return {
    average,
    stdDev: Math.sqrt(variance),
    median: sorted.length % 2
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
    cv: average === 0 ? 0 : Math.sqrt(variance) / average * 100,
  };
}

function metric(values, name) {
  const metrics = values.flatMap((value) => value.metrics[name] === undefined ? [] : [value.metrics[name]]);
  return metrics.length ? stats(metrics).average : null;
}

function number(value, digits = 0) {
  return value === null ? "-" : value.toFixed(digits);
}

if (samples.size === 0) throw new Error("no benchmark samples found");

console.log("# Benchmark summary\n");
console.log("## Latency\n");
console.log("| type | runs | measured | mean | std dev | median | p95 | min | max | CV | ops/s | µs/unit | frame misses |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const [name, values] of samples) {
  const times = stats(values.map(({ milliseconds }) => milliseconds));
  const measured = values.reduce((sum, { operations, milliseconds }) => sum + operations * milliseconds, 0);
  const frameMisses = values.reduce((sum, value) => sum + (value.metrics["frame-miss"] ?? 0), 0);
  const units = metric(values, "items/op") ?? metric(values, "edges") ?? metric(values, "objects") ?? metric(values, "dom-nodes");
  const unitsText = units === null ? "-" : (times.average * 1000 / units).toFixed(3);
  const frameMissText = name.startsWith("frontend/") ? `${frameMisses}/${values.length}` : "-";
  console.log(
    `| ${name} | ${values.length} | ${(measured / 1000).toFixed(2)} s | ${times.average.toFixed(3)} ms | ${times.stdDev.toFixed(3)} ms | ${times.median.toFixed(3)} ms | ${times.p95.toFixed(3)} ms | ${times.min.toFixed(3)} ms | ${times.max.toFixed(3)} ms | ${times.cv.toFixed(1)}% | ${(1000 / times.average).toFixed(1)} | ${unitsText} | ${frameMissText} |`,
  );
}

console.log("\n## Resources and workload counters\n");
console.log("| type | bytes/op | allocs/op | GC/op | GC pause ns/op | heap sys B | RSS B | parse count | commits | DOM nodes | results/op | payload B | bucket reads/op | changed files/op | vault B | vault files |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const [name, values] of samples) {
  console.log(
    `| ${name} | ${number(metric(values, "B/op"))} | ${number(metric(values, "allocs/op"), 1)} | ${number(metric(values, "gc/op"), 3)} | ${number(metric(values, "gc-pause-ns/op"))} | ${number(metric(values, "heap-sys-B"))} | ${number(metric(values, "rss-B"))} | ${number(metric(values, "parse-count"), 1)} | ${number(metric(values, "commit-count"), 1)} | ${number(metric(values, "dom-nodes"))} | ${number(metric(values, "results/op"), 1)} | ${number(metric(values, "payload-B"))} | ${number(metric(values, "bucket-reads/op"), 2)} | ${number(metric(values, "changed-files/op"), 1)} | ${number(metric(values, "vault-B"))} | ${number(metric(values, "vault-files"))} |`,
  );
}

if (bundles.length) {
  console.log("\n## Bundle\n");
  console.log("| asset | raw B | gzip B | files | JS chunks | lazy chunks |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const { name, metrics } of bundles) {
    console.log(
      `| ${name} | ${number(metrics["raw-B"] ?? null)} | ${number(metrics["gzip-B"] ?? null)} | ${number(metrics.files ?? null)} | ${number(metrics["js-chunks"] ?? null)} | ${number(metrics["lazy-chunks"] ?? null)} |`,
    );
  }
}
