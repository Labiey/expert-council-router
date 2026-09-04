import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const outfile = "packages/codex-integration/plugin/expert-council/dist/server.mjs";

await build({
  entryPoints: ["packages/codex-integration/server-entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  external: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
});

// Keep the committed release artifact stable under Git's whitespace checks.
const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/[\t ]+$/gm, ""), "utf8");
