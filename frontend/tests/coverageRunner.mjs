import { Buffer } from "node:buffer";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runInThisContext } from "node:vm";
import { stopCoverage, takeCoverage } from "node:v8";
import { createServer, loadEnv } from "vite";
import { ViteNodeServer } from "vite-node/server";
import { ViteNodeRunner } from "vite-node/client";

// Node does not attach source maps for vite-node's VM modules to V8 reports.
// Supply the actual transform maps and generated line lengths to c8, without
// changing any execution counts, exclusions, or coverage thresholds.
const sourceMaps = {};
class CoverageRunner extends ViteNodeRunner {
  async runModule(context, transformed) {
    const code = `'use strict';async (${Object.keys(context).join(",")})=>{{\n${transformed}\n}}`;
    const inlineMap =
      /\/\/# sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)\s*$/.exec(
        transformed,
      );
    const map = inlineMap
      ? JSON.parse(Buffer.from(inlineMap[1], "base64").toString("utf8"))
      : null;
    if (map) {
      sourceMaps[pathToFileURL(context.__filename).href] = {
        data: { ...map, mappings: `;${map.mappings}` },
        lineLengths: code.split("\n").map((line) => line.length),
        url: null,
      };
    } else if (
      context.__filename.startsWith(join(this.options.root, "src") + "/")
    ) {
      throw new Error(`Missing coverage source map: ${context.__filename}`);
    }
    await runInThisContext(code, { filename: context.__filename })(
      ...Object.values(context),
    );
  }
}

const coverageDirectory = process.env.NODE_V8_COVERAGE;
if (!coverageDirectory) throw new Error("Run coverageRunner.mjs through c8");
process.once("exit", () => {
  takeCoverage();
  stopCoverage();
  for (const file of readdirSync(coverageDirectory)) {
    if (!file.startsWith(`coverage-${process.pid}-`) || !file.endsWith(".json"))
      continue;
    const path = join(coverageDirectory, file);
    const report = JSON.parse(readFileSync(path, "utf8"));
    report["source-map-cache"] = {
      ...report["source-map-cache"],
      ...sourceMaps,
    };
    writeFileSync(path, JSON.stringify(report));
  }
});

const server = await createServer({
  configFile: "vite.config.ts",
  logLevel: "error",
  server: { hmr: false, watch: null },
});
try {
  await server.environments.client.pluginContainer.buildStart({});
  const env = loadEnv(server.config.mode, server.config.envDir, "");
  for (const key in env) process.env[key] ??= env[key];
  const node = new ViteNodeServer(server);
  const runner = new CoverageRunner({
    root: server.config.root,
    base: server.config.base,
    fetchModule: (id) => node.fetchModule(id),
    resolveId: (id, importer) => node.resolveId(id, importer),
  });
  await runner.executeId("/@vite/env");
  await runner.executeFile("tests/coverage.tsx");
} finally {
  await server.close();
}
