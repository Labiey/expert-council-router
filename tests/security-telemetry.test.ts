import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseCouncilConfig, withModelAvailabilityMarker } from "../packages/core/src/index.js";
import {
  JsonCouncilStateStore,
  JsonlTelemetryStore,
  JsonModelAssessmentStore,
  SplitCouncilStateStore,
  WorkspaceBoundary,
} from "../packages/pi-runtime/src/index.js";

const execFileAsync = promisify(execFile);

describe("workspace isolation", () => {
  it("runs mutation in a detached Git worktree and reports changes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "expert-council-repo-"));
    const isolated: string[] = [];
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
      isolated.push(prepared.root);
      expect(prepared.isolated).toBe(true);
      expect(prepared.root).not.toBe(repo);
      await writeFile(path.join(prepared.cwd, "file.txt"), "after\n", "utf8");
      expect(await boundary.changedFiles(prepared)).toEqual(["file.txt"]);
      isolated.push((await boundary.prepare(repo, false, executionId)).root);
      isolated.push((await boundary.prepare(repo, false, executionId)).root);
      const restartedBoundary = new WorkspaceBoundary(repo, config.security);
      const cleanup = await restartedBoundary.cleanupExecution(executionId);
      expect(cleanup).toMatchObject({ status: "cleaned", removedCount: 3 });
      expect(cleanup.workspaces).toEqual(expect.arrayContaining(isolated));
      for (const worktree of isolated) await expect(access(worktree)).rejects.toThrow();
      isolated.length = 0;
    } finally {
      for (const worktree of isolated) {
        await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", worktree]).catch(() => undefined);
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
  it("persists a reusable model capability and billing assessment independently of workspace state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-assessment-"));
    const file = path.join(directory, "model-assessment.json");
    try {
      const store = new JsonModelAssessmentStore(file);
      const assessment = {
        asOf: "2026-09-02T00:00:00.000Z",
        sources: ["https://livebench.ai/"],
        models: { "p/model": { coding: 8, toolReliability: 7 } },
        billing: { p: { billingType: "metered" as const, costMultiplier: 1.0 } },
      };
      await store.save(assessment);
      expect(await new JsonModelAssessmentStore(file).load()).toEqual(assessment);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies targeted availability updates against the latest stored snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-assessment-update-"));
    const file = path.join(directory, "model-assessment.json");
    try {
      const store = new JsonModelAssessmentStore(file);
      // No stored snapshot yet: a targeted update is a no-op instead of manufacturing one.
      await store.update((current) => (current
        ? withModelAvailabilityMarker(current, "p/model", "model_not_found")
        : undefined));
      await expect(store.load()).resolves.toBeUndefined();

      const assessment = {
        asOf: "2026-09-03T00:00:00.000Z",
        sources: ["https://livebench.ai/"],
        models: { "p/model": { coding: 8, toolReliability: 7 } },
      };
      await store.save(assessment);
      await store.update((current) => current
        ? withModelAvailabilityMarker(current, "p/model", "provider returned model_not_found", "2026-09-03T01:00:00.000Z")
        : undefined);
      const loaded = await new JsonModelAssessmentStore(file).load();
      expect(loaded?.modelAvailability?.["p/model"]).toMatchObject({
        callable: false,
        source: "runtime-failure",
      });
      expect(loaded?.models).toEqual(assessment.models);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses one shared assessment across different workspace state stores", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-split-state-"));
    try {
      const assessmentFile = path.join(directory, "model-assessment.json");
      const firstWorkspaceFile = path.join(directory, "workspace-a", "state.json");
      const secondWorkspaceFile = path.join(directory, "workspace-b", "state.json");
      const assessment = {
        asOf: "2026-09-02T00:00:00.000Z",
        sources: ["https://livebench.ai/"],
        models: { "p/model": { coding: 9 } },
      };
      const first = new SplitCouncilStateStore(
        new JsonCouncilStateStore(firstWorkspaceFile),
        new JsonModelAssessmentStore(assessmentFile),
      );
      await first.save({ version: 1, plans: [], executions: [], results: [], modelAssessment: assessment });
      expect((await new JsonCouncilStateStore(firstWorkspaceFile).load())?.modelAssessment).toBeUndefined();

      const second = new SplitCouncilStateStore(
        new JsonCouncilStateStore(secondWorkspaceFile),
        new JsonModelAssessmentStore(assessmentFile),
      );
      expect((await second.load())?.modelAssessment).toEqual(assessment);

      const newerAssessment = {
        ...assessment,
        asOf: "2026-09-02T01:00:00.000Z",
        models: { "p/model": { coding: 10 } },
      };
      await first.save(
        { version: 1, plans: [], executions: [], results: [], modelAssessment: newerAssessment },
        { replaceModelAssessment: true },
      );
      await second.save(
        { version: 1, plans: [], executions: [], results: [], modelAssessment: assessment },
        { replaceModelAssessment: false },
      );
      expect((await new JsonModelAssessmentStore(assessmentFile).load())).toEqual(newerAssessment);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("round-trips availability reporting through the strict state schema", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expert-council-state-availability-"));
    const file = path.join(directory, "state.json");
    try {
      const store = new JsonCouncilStateStore(file);
      const snapshot = {
        version: 1 as const,
        plans: [],
        executions: [],
        results: [{
          executionId: "exec_test",
          result: {
            status: "failed" as const,
            role: "scout" as const,
            model: "p/dead",
            summary: "403: access to model denied",
            executionMetadata: {
              attempts: 1,
              failureType: "provider_error" as const,
              unavailableModels: ["p/dead"],
            },
          },
        }],
      };
      await store.save(snapshot);
      expect(await store.load()).toEqual(snapshot);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
