import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Automated runs create real Git worktrees. Without isolation they register in
// the same per-user temporary namespace as live experts, where the retention
// window keeps them until a later mutation run prunes them, so a few test loops
// leave dozens of worktrees behind. Route them to a throwaway directory that
// tests/global-setup.ts wipes before and after the suite.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    env: { EXPERT_COUNCIL_WORKTREES: path.join(tmpdir(), "ecwt") },
    globalSetup: ["tests/global-setup.ts"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
