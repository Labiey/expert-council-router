import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Pairs with vitest.config.ts: expert worktrees created by the suite live in this
// throwaway directory so they never register inside the shared per-user
// production namespace, where the retention window would keep them alive.
const scratch = path.join(tmpdir(), "ecwt");

function removeScratch(): void {
  try {
    // Node accepts extended-length paths on Windows, which dodges MAX_PATH on
    // deeply nested worktree checkouts.
    rmSync(process.platform === "win32" ? `\\\\?\\${scratch}` : scratch, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  } catch {
    // A leftover directory here is harmless OS temp churn.
  }
}

export default async function setup() {
  removeScratch();
  mkdirSync(scratch, { recursive: true });
  return () => {
    removeScratch();
    try {
      // The checkouts are gone; drop their stale registrations from this repo.
      execFileSync("git", ["worktree", "prune"], { stdio: "ignore", timeout: 30_000 });
    } catch {
      // Pruning is housekeeping, never a test failure.
    }
  };
}
