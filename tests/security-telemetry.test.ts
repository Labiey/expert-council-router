import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseCouncilConfig } from "../packages/core/src/index.js";
import { JsonlTelemetryStore, WorkspaceBoundary } from "../packages/pi-runtime/src/index.js";

const execFileAsync = promisify(execFile);

describe("workspace isolation", () => {
  it("runs mutation in a detached Git worktree and reports changes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "expert-council-repo-"));
    let isolated: string | undefined;
    try {
      await execFileAsync("git", ["init", repo]);
      await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@example.invalid"]);
      await execFileAsync("git", ["-C", repo, "config", "user.name", "Expert Council Tests"]);
      await writeFile(path.join(repo, "file.txt"), "before\n", "utf8");
      await execFileAsync("git", ["-C", repo, "add", "file.txt"]);
      await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
      const config = parseCouncilConfig({ security: { workspaceStrategy: "auto", allowInPlaceMutations: false } });
      const boundary = new WorkspaceBoundary(repo, config.security);
      const prepared = await boundary.prepare(repo, false, `test-${Date.now()}`);
      isolated = prepared.root;
      expect(prepared.isolated).toBe(true);
      expect(prepared.root).not.toBe(repo);
      await writeFile(path.join(prepared.cwd, "file.txt"), "after\n", "utf8");
      expect(await boundary.changedFiles(prepared)).toEqual(["file.txt"]);
    } finally {
      if (isolated) {
        await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", isolated]).catch(() => undefined);
      }
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("local JSONL telemetry", () => {
  it("persists only sanitized outcomes and aggregates them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-telemetry-"));
    const file = path.join(directory, "telemetry.jsonl");
    try {
      const store = new JsonlTelemetryStore(file);
      await store.record({
        timestamp: new Date().toISOString(),
        model: "m",
        provider: "p",
        role: "verifier",
        taskCategory: "normal",
        success: true,
        firstPass: true,
        toolErrors: 0,
        retryCount: 0,
        timedOut: false,
        verificationPassed: true,
        escalationCount: 0,
        attempts: 1,
        hostType: "test",
        ...({ prompt: "must not persist" } as object),
      });
      expect(await readFile(file, "utf8")).not.toContain("must not persist");
      expect(await store.aggregate()).toMatchObject([{ samples: 1, verificationPassRate: 1 }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
