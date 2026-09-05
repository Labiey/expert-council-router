import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const outfile = "packages/codex-integration/plugin/expert-council/dist/server.mjs";
const bundledPiManifest = JSON.parse(await readFile(
  "node_modules/@earendil-works/pi-coding-agent/package.json",
  "utf8",
));

await build({
  entryPoints: ["packages/codex-integration/server-entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  define: {
    BUNDLED_PI_SDK_VERSION: JSON.stringify(bundledPiManifest.version),
  },
  // Some bundled Pi dependencies still use CommonJS dynamic require for Node
  // built-ins. Supplying a module-relative require keeps the single-file ESM
  // artifact executable after Codex copies it into the plugin cache.
  banner: {
    js: `import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`,
  },
});

// Keep the committed release artifact stable under Git's whitespace checks.
const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/[\t ]+$/gm, ""), "utf8");
