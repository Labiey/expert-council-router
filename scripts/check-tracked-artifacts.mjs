#!/usr/bin/env node
/**
 * A tracked build artifact that lags its source is a release defect with a delay: the repository's
 * own tests pass, `npm pack` regenerates the file during validate, and yet the committed bundle
 * that everyone reads on GitHub is stale. This happened in reality - a reasoning-redaction fix
 * landed in source and the committed Codex plugin bundle still carried the unfiltered call -
 * because the build was always run with its output discarded and its exit code never checked.
 *
 * Run after `npm run build`. Fails when the working tree's tracked generated files do not match
 * what a fresh build just produced. `--ignore-cr-at-eol` keeps a CRLF checkout from reporting
 * churn that has no content difference at all.
 */
import { execFileSync } from "node:child_process";

const PATHS = [
  "packages/codex-integration/plugin/expert-council/dist",
  "packages/codex-integration/plugin/expert-council/skills",
  "packages/pi-package/skills",
];

let output = "";
try {
  output = execFileSync("git", ["diff", "--ignore-cr-at-eol", "--name-only", "--", ...PATHS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  console.error(`check-tracked-artifacts: git diff failed: ${error.message}`);
  process.exit(2);
}

const stale = output.split(/\r?\n/).filter((line) => line.trim() !== "");
if (stale.length > 0) {
  console.error("check-tracked-artifacts: these tracked generated files do not match a fresh build:");
  for (const file of stale) console.error(`  ${file}`);
  console.error("Run `npm run build` and commit the result.");
  process.exit(1);
}
console.log(`check-tracked-artifacts: tracked generated artifacts are current (${PATHS.length} paths checked)`);
