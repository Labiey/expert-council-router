import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Pairs with vitest.config.ts: expert worktrees created by the suite live in this
// throwaway directory so they never register inside the shared per-user
// production namespace, where the retention window would keep them alive.
const scratch = path.join(tmpdir(), "ecwt");

// Where the fallback clone of the main checkout is materialised when the suite runs
// inside a worktree. Kept deliberately short: the whole point is a short `$GIT_DIR`.
const sourceClone = path.join(tmpdir(), "ectest");

// Handshake file. A globalSetup's `process.env` mutation does not reach vitest worker
// processes, so the resolved path is published to a file the tests read instead.
const sourceMarker = path.join(scratch, "git-source.txt");

function remove(target: string): void {
  try {
    // Node accepts extended-length paths on Windows, which dodges MAX_PATH on
    // deeply nested worktree checkouts.
    rmSync(process.platform === "win32" ? `\\\\?\\${target}` : target, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  } catch {
    // A leftover directory here is harmless OS temp churn.
  }
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    })?.trim();
  } catch {
    return undefined;
  }
}

/**
 * True when this checkout is a *linked* worktree rather than the main one. Compared as
 * resolved paths, because git prints one absolute and one repo-relative form; the path
 * string length is never consulted, since that is precisely the thing that lies here.
 */
function insideLinkedWorktree(): boolean {
  const gitDir = git(["rev-parse", "--absolute-git-dir"]);
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gitDir || !commonDir) return false;
  return path.resolve(gitDir) !== path.resolve(commonDir);
}

/** The main checkout, which is the only sane clone source from inside a worktree. */
function mainCheckout(): string | undefined {
  const listing = git(["worktree", "list", "--porcelain"]);
  const entry = listing?.split(/\r?\n/).find((line) => line.startsWith("worktree "));
  return entry ? entry.slice("worktree ".length).trim() : undefined;
}

/**
 * Clone the repository once into a short path so tests that need a real git source can
 * create worktrees from it. `git worktree add` derives `$GIT_DIR` from its source, and a
 * source that is itself a deeply nested worktree overflows that limit:
 * `fatal: '$GIT_DIR' too big`. That made the council's verification gate report a false
 * failure for expert work that was actually fine. `--local` hardlinks the object store, so
 * the copy is a one-off and mostly metadata, not a duplicated repository.
 */
function materialiseSourceClone(): string | undefined {
  const source = mainCheckout();
  if (!source) return undefined;
  remove(sourceClone);
  try {
    execFileSync("git", ["clone", "--local", "--quiet", source, sourceClone], {
      stdio: "ignore",
      timeout: 600_000,
    });
    return sourceClone;
  } catch {
    remove(sourceClone);
    return undefined;
  }
}

export default async function setup() {
  remove(scratch);
  mkdirSync(scratch, { recursive: true });

  let usedClone = false;
  if (insideLinkedWorktree() && !process.env.EXPERT_COUNCIL_TEST_WORKSPACE) {
    const clone = materialiseSourceClone();
    if (clone) {
      // Mutation tests read this instead of `process.cwd()`; see tests/pi-runtime.test.ts.
      process.env.EXPERT_COUNCIL_TEST_WORKSPACE = clone;
      try {
        writeFileSync(sourceMarker, `${clone}\n`, { encoding: "utf8" });
      } catch {
        // If the marker cannot be written the tests fall back and fail loudly, which is
        // better than silently testing a different code path than production runs.
      }
      usedClone = true;
    } else {
      console.warn(
        "[expert-council] running inside a worktree and could not clone the main checkout; " +
          "tests that create worktrees will fail with git's '$GIT_DIR too big' error.",
      );
    }
  }

  return () => {
    remove(scratch);
    if (usedClone) {
      remove(sourceClone);
      delete process.env.EXPERT_COUNCIL_TEST_WORKSPACE;
    }
    try {
      // The checkouts are gone; drop their stale registrations from this repo.
      execFileSync("git", ["worktree", "prune"], { stdio: "ignore", timeout: 30_000 });
    } catch {
      // Pruning is housekeeping, never a test failure.
    }
  };
}
