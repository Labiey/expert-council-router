import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseCouncilConfig } from "../packages/core/src/index.js";
import { JsonCouncilStateStore, JsonlTelemetryStore, WorkspaceBoundary } from "../packages/pi-runtime/src/index.js";

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
      const executionId = `test-${Date.now()}`;
      const prepared = await boundary.prepare(repo, false, executionId);
      isolated = prepared.root;
      expect(prepared.isolated).toBe(true);
      expect(prepared.root).not.toBe(repo);
      await writeFile(path.join(prepared.cwd, "file.txt"), "after\n", "utf8");
      expect(await boundary.changedFiles(prepared)).toEqual(["file.txt"]);
      const restartedBoundary = new WorkspaceBoundary(repo, config.security);
      expect(await restartedBoundary.cleanupExecution(executionId)).toMatchObject({ status: "cleaned", workspace: isolated });
      await expect(access(isolated)).rejects.toThrow();
      isolated = undefined;
    } finally {
      if (isolated) {
        await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", isolated]).catch(() => undefined);
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reports fail-closed mutation capability with an actionable in-place opt-in", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-nongit-"));
    try {
      const config = parseCouncilConfig({ security: { workspaceStrategy: "auto", allowInPlaceMutations: false } });
      const capability = await new WorkspaceBoundary(directory, config.security).mutationCapability();
      expect(capability.mutation).toBe(false);
      expect(capability.workspaceIsolation).toBe("none");
      expect(capability.limitations.join(" ")).toContain("allowInPlaceMutations=true");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("warns when detached mutation worktrees would omit source changes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "expert-council-dirty-repo-"));
    try {
      await execFileAsync("git", ["init", repo]);
      await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@example.invalid"]);
      await execFileAsync("git", ["-C", repo, "config", "user.name", "Expert Council Tests"]);
      await writeFile(path.join(repo, "file.txt"), "committed\n", "utf8");
      await execFileAsync("git", ["-C", repo, "add", "file.txt"]);
      await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
      await writeFile(path.join(repo, "file.txt"), "uncommitted\n", "utf8");
      await writeFile(path.join(repo, "new.txt"), "untracked\n", "utf8");

      const config = parseCouncilConfig({ security: { workspaceStrategy: "auto", allowInPlaceMutations: false } });
      const capability = await new WorkspaceBoundary(repo, config.security).mutationCapability();
      expect(capability).toMatchObject({
        mutation: true,
        workspaceIsolation: "git-worktree",
        sourceWorkspaceDirty: true,
      });
      expect(capability.limitations.join(" ")).toContain("will not include them");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("durable council state", () => {
  it("writes snapshots atomically and restores them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-state-"));
    const file = path.join(directory, "state.json");
    try {
      const store = new JsonCouncilStateStore(file);
      const snapshot = { version: 1 as const, plans: [], executions: [], results: [] };
      await store.save(snapshot);
      expect(await store.load()).toEqual(snapshot);
      expect(await readFile(file, "utf8")).not.toContain(".tmp");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects structurally invalid nested plans and results", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-state-invalid-"));
    const file = path.join(directory, "state.json");
    try {
      await writeFile(file, JSON.stringify({
        version: 1,
        plans: [{ id: "forged", task: "missing required plan fields" }],
        executions: [],
        results: [],
      }), "utf8");
      await expect(new JsonCouncilStateStore(file).load()).rejects.toThrow("plans.0");
    } finally {
      await rm(directory, { recursive: true, force: true });
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
