import { build } from "esbuild";

await build({
  entryPoints: ["packages/codex-integration/server-entry.ts"],
  outfile: "packages/codex-integration/plugin/expert-council/dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  external: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
});
