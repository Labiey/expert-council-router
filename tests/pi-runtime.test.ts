import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCouncilConfig } from "../packages/core/src/index.js";
import { loadCouncilConfig } from "../packages/pi-runtime/src/config-loader.js";
import {
  applyVerificationGate,
  defaultCouncilDataRoot,
  defaultCouncilStoragePaths,
  detectProvisioningPlan,
  inferPiProviderBilling,
  PiExpertRuntime,
  planVerification,
  provisionWorkspace,
  scrubProvisioningEnv,
  validatePiSdk,
  worktreeMatchesExecutionId,
  worktreeNameEpochMs,
  type PiSdkLike,
} from "../packages/pi-runtime/src/index.js";

const roleDirectory = path.resolve("packages/core/src/roles/prompts");

/**
 * Mutation experts run inside an isolated worktree whose SOURCE is the repository the
 * suite is standing in. When the suite itself runs inside a worktree - which is exactly
 * what happens when the council delegates a mutation expert - git refuses to add a
 * nested worktree (`fatal: '$GIT_DIR' too big`), and the verification gate then reports a
 * false failure for work that is actually fine. tests/global-setup.ts clones the main
 * checkout to a short path in that case; every test that needs a real git source branches
 * from it instead of from `process.cwd()`, so it exercises the same code path a normal
 * checkout would. Ordinary checkouts leave the variable unset and behave as before.
 */
const gitSource = process.env.EXPERT_COUNCIL_TEST_WORKSPACE ?? publishedTestWorkspace() ?? process.cwd();

/**
 * The clone path published by tests/global-setup.ts. Read from a file rather than the
 * environment because a globalSetup's `process.env` changes never reach vitest workers.
 */
function publishedTestWorkspace(): string | undefined {
  try {
    const value = readFileSync(path.join(tmpdir(), "ecwt", "git-source.txt"), "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

class SafeResourceLoader {
  constructor(_options: Record<string, unknown>) {}
  async reload() {}
  getSkills() { return { skills: [], diagnostics: [] }; }
  getExtensions() { return { extensions: [], diagnostics: [] }; }
}

const safeResourceApis = {
  SettingsManager: { create: () => ({}) },
  DefaultResourceLoader: SafeResourceLoader,
  getAgentDir: () => path.resolve(".pi-test-agent"),
} satisfies Partial<PiSdkLike>;

describe("Pi SDK load failure diagnostics", () => {
  it("turns the Pi 0.85 pi-server split into an actionable install instruction", async () => {
    const { describeSdkLoadFailure } = await import("../packages/pi-runtime/src/pi-sdk.js");
    const message = describeSdkLoadFailure([
      "@earendil-works/pi-coding-agent: Cannot find package '@earendil-works/pi-server' imported from .../pi-coding-agent/dist/experimental/server.js",
    ]);
    expect(message).toContain("npm install -g @earendil-works/pi-server");
    expect(message).toContain("Pi 0.85 or later");
  });

  it("keeps the generic guidance for unrelated SDK failures", async () => {
    const { describeSdkLoadFailure } = await import("../packages/pi-runtime/src/pi-sdk.js");
    const message = describeSdkLoadFailure(["@mariozechner/pi-coding-agent: ENOENT"]);
    expect(message).not.toContain("pi-server");
    expect(message).toContain("Install a supported Pi coding-agent package");
  });
});

describe("model assessment persistence formatting", () => {
  it("writes the shared assessment as structured multi-line JSON", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { JsonModelAssessmentStore } = await import("../packages/pi-runtime/src/file-assessment.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "ec-assessment-"));
    try {
      const store = new JsonModelAssessmentStore(path.join(dir, "model-assessment.json"));
      await store.save({
        asOf: "2026-09-05T00:00:00.000Z",
        sources: ["https://livebench.ai/"],
        models: { "p/m": { coding: 8 } },
        modelAvailability: {
          "p/dead": { callable: false, kind: "quota-exhausted", observedAt: "2026-09-05T00:00:00.000Z", reason: "insufficient_quota", source: "runtime-failure" },
        },
        modelStatus: {
          "p/m": { state: "available", observedAt: "2026-09-05T00:00:00.000Z" },
        },
      });
      const raw = await readFile(path.join(dir, "model-assessment.json"), "utf8");
      expect(raw.split("\n").length).toBeGreaterThan(5);
      expect(raw).toContain("\n  \"sources\"");
      const parsed = JSON.parse(raw);
      expect(parsed.modelStatus["p/m"].state).toBe("available");
      expect(parsed.modelAvailability["p/dead"].kind).toBe("quota-exhausted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("route policy persistence", () => {
  it("reloads edited route-policy.json without a restart and prunes stale session entries", async () => {
    const { mkdtemp, readFile, rm, writeFile, utimes } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { JsonRoutePolicyStore } = await import("../packages/pi-runtime/src/file-route-policy.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "ec-route-policy-"));
    const filePath = path.join(dir, "route-policy.json");
    try {
      await writeFile(filePath, `${JSON.stringify({
        version: 1,
        system: { deny: ["bailian"] },
        sessions: {
          "old-session": { deny: ["zai"], updatedAt: "2020-01-01T00:00:00.000Z" },
          "fresh-session": { deny: ["deepseek"], updatedAt: new Date().toISOString() },
        },
      }, null, 2)}\n`, "utf8");
      const store = new JsonRoutePolicyStore(filePath);

      const first = await store.load();
      expect(first?.system?.deny).toEqual(["bailian"]);
      expect(first?.sessions?.["old-session"]).toBeUndefined();
      expect(first?.sessions?.["fresh-session"]).toBeDefined();
      // Pruning is written back so the file does not grow without bound.
      const onDisk = JSON.parse(await readFile(filePath, "utf8"));
      expect(onDisk.sessions["old-session"]).toBeUndefined();

      // Host edits the file: a newer mtime must be observed without a restart.
      await writeFile(filePath, `${JSON.stringify({ version: 1, system: { deny: ["zai"] } }, null, 2)}\n`, "utf8");
      const later = new Date(Date.now() + 5_000);
      await utimes(filePath, later, later);
      const second = await store.load();
      expect(second?.system?.deny).toEqual(["zai"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("usage ledger persistence", () => {
  it("creates usage-ledger.json lazily, accumulates weighted tokens, and reloads external edits", async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { JsonUsageLedgerStore, createProviderLimitsReader } = await import("../packages/pi-runtime/src/file-usage-ledger.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "ec-usage-ledger-"));
    const filePath = path.join(dir, "usage-ledger.json");
    try {
      const store = new JsonUsageLedgerStore(filePath);
      expect(await store.load()).toEqual({ providers: {}, updatedAt: "1970-01-01T00:00:00.000Z" });
      const now = new Date("2026-09-05T10:00:00.000Z");
      await store.record("p", 300, now);
      await store.record("p", 200, now);
      const ledger = await store.load();
      expect(ledger.providers.p).toEqual({
        day: { key: "2026-09-05", tokens: 500 },
        week: { key: "2026-W36", tokens: 500 },
      });
      const onDisk = JSON.parse(await readFile(filePath, "utf8"));
      expect(onDisk.providers.p.week.tokens).toBe(500);

      await writeFile(filePath, `${JSON.stringify({
        providers: { q: { day: { key: "2026-09-05", tokens: 7 }, week: { key: "2026-W36", tokens: 7 } } },
        updatedAt: now.toISOString(),
      })}\n`, "utf8");
      const fresh = new JsonUsageLedgerStore(filePath);
      expect((await fresh.load()).providers.q?.day.tokens).toBe(7);

      const reader = createProviderLimitsReader({
        load: async () => ({ version: 1 as const, providers: { p: { maxConcurrency: 1 } } }),
      });
      expect(await reader()).toEqual({ version: 1, providers: { p: { maxConcurrency: 1 } } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Pi runtime adapter", () => {
  it("recognizes named Pi plan catalogs without treating authentication alone as billing evidence", () => {
    expect(inferPiProviderBilling("qwen-token-plan-cn")).toMatchObject({
      policy: { billingType: "subscription", costMultiplier: 0.1 },
      source: "pi-provider-catalog",
    });
    expect(inferPiProviderBilling("zai", false, true)).toMatchObject({
      policy: { billingType: "metered", costMultiplier: 1.0 },
      source: "pi-model-catalog",
    });
    expect(inferPiProviderBilling("custom-api")).toMatchObject({
      policy: { billingType: "unknown" },
      source: "unverified",
    });
    expect(inferPiProviderBilling("custom-oauth", true)).toMatchObject({
      policy: { billingType: "subscription" },
      source: "pi-runtime",
    });
  });

  it("places default state outside the workspace and namespaces it deterministically", () => {
    const dataRoot = path.resolve(".test-expert-council-data");
    const first = defaultCouncilStoragePaths(process.cwd(), dataRoot);
    const repeated = defaultCouncilStoragePaths(process.cwd(), dataRoot);
    const other = defaultCouncilStoragePaths(path.resolve("tests"), dataRoot);
    expect(first).toEqual(repeated);
    expect(first.workspaceRoot.startsWith(dataRoot)).toBe(true);
    expect(first.statePath).not.toContain(`${path.sep}.expert-council${path.sep}`);
    expect(first.statePath).not.toBe(path.join(process.cwd(), ".expert-council", "state.json"));
    expect(other.workspaceRoot).not.toBe(first.workspaceRoot);
    expect(other.modelAssessmentPath).toBe(first.modelAssessmentPath);
    expect(other.telemetryPath).toBe(first.telemetryPath);
    // The interactive expert window must live under the operator's data root, never
    // inside the checked-out project an expert happens to work on.
    expect(first.observabilityDir).toBe(path.join(dataRoot, "observability"));
  });

  it("selects a writable per-user data root on Windows, macOS, and Linux", () => {
    const normalized = (value: string) => value.replaceAll("\\", "/");
    expect(normalized(defaultCouncilDataRoot("win32", { LOCALAPPDATA: "C:/Users/Alice/AppData/Local" }, "C:/Users/Alice")))
      .toBe("C:/Users/Alice/AppData/Local/ExpertCouncil");
    expect(normalized(defaultCouncilDataRoot("darwin", {}, "/Users/alice")))
      .toBe("/Users/alice/Library/Application Support/ExpertCouncil");
    expect(normalized(defaultCouncilDataRoot("linux", { XDG_STATE_HOME: "/var/user-state" }, "/home/alice")))
      .toBe("/var/user-state/expert-council");
    expect(normalized(defaultCouncilDataRoot("linux", {}, "/home/alice")))
      .toBe("/home/alice/.local/state/expert-council");
  });

  it("fails explicitly when an injected Pi SDK is contract-incompatible", () => {
    expect(() => validatePiSdk({ ModelRuntime: {} }, "test-sdk")).toThrow("ModelRuntime.create");
  });

  it("discovers runtime models and enforces read-only tool removal", async () => {
    let sessionOptions: Record<string, unknown> | undefined;
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{
        provider: "p",
        id: "m",
        name: "Mock",
        reasoning: true,
        contextWindow: 100_000,
        maxTokens: 4_000,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }],
      getModel: () => nativeModel,
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        sessionOptions = options;
        return {
          session: {
            prompt: async () => {},
            waitForIdle: async () => {},
            dispose: () => {},
            getAvailableThinkingLevels: () => ["low"],
            setThinkingLevel: () => {},
            state: {
              messages: [{
                role: "assistant",
                content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "scouted\u0000\u202e", findings: ["x\u0007"] }) }],
                usage: { input: 120, output: 30, cacheRead: 10, cacheWrite: 2, cost: { total: 0.02 } },
              }],
            },
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({
      cwd: gitSource,
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    expect(await runtime.listAvailableModels()).toMatchObject([{ provider: "p", id: "m", displayName: "Mock" }]);
    const result = await runtime.executeExpert({
      role: "scout",
      task: "Find the entrypoint",
      model: "p/m",
      tools: ["read", "grep", "edit", "write", "powershell"],
      skills: [],
      reasoningLevel: "low",
      readOnly: false,
      workspace: gitSource,
      timeoutMs: 1_000,
      attempt: 1,
    });
    expect(result).toMatchObject({ status: "success", summary: "scouted", findings: ["x"] });
    expect(result.executionMetadata?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
      estimatedCost: 0.02,
    });
    // Dynamic grants require registering the superset up front, so a read-only
    // execution registers every non-mutation built-in and activates only its role
    // seed. The security property that matters: mutating/shell tools are never
    // even registered for a read-only run, so no approval can reach them.
    expect(sessionOptions?.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "report_and_stop",
      "request_decision",
      "request_tool",
    ]);
    expect((sessionOptions?.tools as string[]).some((tool) => ["edit", "write", "bash", "powershell"].includes(tool))).toBe(false);
    expect((sessionOptions?.customTools as Array<{ name: string }> | undefined)?.[0]?.name).toBe("report_and_stop");
    expect(sessionOptions?.model).toBe(nativeModel);
  });

  it("narrows a read-only run to its role seed despite superset registration", async () => {
    const narrowCalls: string[][] = [];
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async () => ({
        session: {
          prompt: async () => undefined,
          waitForIdle: async () => {},
          dispose: () => {},
          subscribe: () => () => {},
          setActiveToolsByName: (names: string[]) => {
            narrowCalls.push([...names]);
          },
          state: {
            messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "narrowed", filesChanged: [], tests: [], findings: [] }) }] }],
          },
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      executionId: "exec_narrow",
      role: "scout",
      task: "narrow",
      model: "p/m",
      tools: ["read", "grep"],
      skills: [],
      readOnly: true,
      workspace: process.cwd(),
      timeoutMs: 20_000,
      attempt: 1,
    });
    expect(result.status).toBe("success");
    expect(narrowCalls.length).toBeGreaterThan(0);
    // Only the role seed plus interaction tools go active; other registered
    // read tools (find/ls) stay inactive until granted.
    expect(narrowCalls[0]).toEqual(["read", "grep", "report_and_stop", "request_decision", "request_tool"]);
    expect(narrowCalls[0]).not.toContain("find");
  });

  it("never attributes the host's uncommitted changes to a read-only expert", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "expert-council-dirty-repo-"));
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "tests@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Expert Council Tests"]);
    await writeFile(path.join(repo, "file.txt"), "committed\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "file.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    // The Main Agent's own in-progress edit, on disk while the expert runs.
    await writeFile(path.join(repo, "file.txt"), "dirty by the host\n", "utf8");
    try {
      const nativeModel = { provider: "p", id: "m" };
      const modelRuntime = {
        getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
        getModel: () => nativeModel,
      };
      const sdk: PiSdkLike = {
        ...safeResourceApis,
        ModelRuntime: { create: async () => modelRuntime },
        SessionManager: { inMemory: () => ({}) },
        createAgentSession: async () => ({
          session: {
            prompt: async () => undefined,
            waitForIdle: async () => {},
            dispose: () => {},
            subscribe: () => () => {},
            state: {
              messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "inspected", filesChanged: [], tests: [], findings: [] }) }] }],
            },
          },
        }),
      };
      const runtime = await PiExpertRuntime.create({ cwd: repo, config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
      const result = await runtime.executeExpert({
        executionId: "exec_dirty",
        role: "scout",
        task: "read-only inspection",
        model: "p/m",
        tools: ["read"],
        skills: [],
        readOnly: true,
        workspace: repo,
        timeoutMs: 20_000,
        attempt: 1,
      });
      expect(result.status).toBe("success");
      // The expert had no mutation tool, so the host's dirty file is not its work.
      expect(result.filesChanged).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("tells read-only experts that delivering content in the report is completion", async () => {
    let promptText = "";
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async () => ({
        session: {
          prompt: async (text: unknown) => {
            promptText = String(text);
          },
          waitForIdle: async () => {},
          dispose: () => {},
          subscribe: () => () => {},
          state: {
            messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "delivered", filesChanged: [], tests: [], findings: [] }) }] }],
          },
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      executionId: "exec_readonly_completion",
      role: "scout",
      task: "Condense the duty sentence and hand the text back.",
      model: "p/m",
      tools: ["read", "grep", "find", "ls"],
      skills: [],
      readOnly: true,
      workspace: process.cwd(),
      timeoutMs: 20_000,
      attempt: 1,
    });
    expect(result.status).toBe("success");
    // Regression: a read-only scout that delivered the requested text reported
    // partial + permission_error just because it could not write files, which
    // taught telemetry to punish a model for a correctly finished run.
    expect(promptText).toContain("inside your report IS completion");
    expect(promptText).toContain("writer-capable pass");
    expect(promptText).toContain("never downgrade a finished read-only deliverable");
  });

  it("delivers a structured partial result when the expert calls report_and_stop", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    let stopTool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        const custom = (options.customTools ?? []) as Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>;
        stopTool = custom.find((tool) => tool.name === "report_and_stop");
        expect(stopTool).toBeDefined();
        expect((options.tools as string[]).includes("report_and_stop")).toBe(true);
        return {
          session: {
            prompt: async () => {
              await stopTool!.execute("t1", {
                reason: "The worktree has no installed dependencies and the task requires running the test suite.",
                findings: ["src/entry.ts exports run()", "tests use vitest"],
                risks: ["retrying without provisioning will fail identically"],
                recommendedNextAction: "Dispatch with workspace provisioning enabled or run outside the isolated worktree.",
              });
            },
            waitForIdle: async () => {},
            dispose: () => {},
            state: { messages: [] },
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({
      cwd: gitSource,
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    const result = await runtime.executeExpert({
      role: "implementation-worker",
      task: "Run the test suite",
      model: "p/m",
      tools: ["read", "bash"],
      skills: [],
      reasoningLevel: "low",
      readOnly: false,
      workspace: gitSource,
      timeoutMs: 5_000,
      attempt: 1,
    });
    expect(result.status).toBe("partial");
    expect(result.summary).toContain("[Task stopped by expert]");
    expect(result.summary).toContain("no installed dependencies");
    expect(result.findings).toEqual(["src/entry.ts exports run()", "tests use vitest"]);
    expect(result.recommendedNextAction).toBe("Dispatch with workspace provisioning enabled or run outside the isolated worktree.");
    expect(result.executionMetadata).toMatchObject({ failureType: "missing_context", stoppedByExpert: true, attempts: 1 });
  });

  it("surfaces a request_decision interaction, applies the host answer, and continues the same session", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    let decisionTool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> } | undefined;
    let toolText = "";
    const state: { messages: Array<Record<string, unknown>> } = { messages: [] };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        const custom = (options.customTools ?? []) as Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
        decisionTool = custom.find((tool) => tool.name === "request_decision");
        expect(decisionTool).toBeDefined();
        expect((options.tools as string[]).includes("request_decision")).toBe(true);
        return {
          session: {
            prompt: async () => {
              const response = await decisionTool!.execute("t1", {
                question: "Retry in place or dispatch a fresh worker?",
                options: [{ label: "Retry in place", description: "keeps context" }, { label: "Fresh worker", description: "cleaner state" }],
              });
              toolText = response.content[0]!.text;
              state.messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: toolText }) }] }];
            },
            waitForIdle: async () => {},
            dispose: () => {},
            state,
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({
      cwd: gitSource,
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    const executionId = "exec_decision_test";
    const running = runtime.executeExpert({
      executionId,
      role: "implementation-worker",
      task: "Decide and proceed",
      model: "p/m",
      tools: ["read", "bash"],
      skills: [],
      reasoningLevel: "low",
      readOnly: false,
      workspace: gitSource,
      timeoutMs: 20_000,
      attempt: 1,
    });
    // Poll until the expert has raised the interaction (bounded, no fixed sleep race).
    let progress = await runtime.inspectExecution(executionId);
    for (let i = 0; i < 50 && !progress?.pendingInteraction; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      progress = await runtime.inspectExecution(executionId);
    }
    expect(progress?.pendingInteraction?.request.kind).toBe("decision");
    expect(progress?.pendingInteraction?.request.options?.map((o) => o.label)).toEqual(["Retry in place", "Fresh worker"]);
    // A kind-mismatch is rejected without resolving.
    expect((await runtime.respondToInteraction(executionId, { kind: "tool_approval", scope: "once" })).status).toBe("kind-mismatch");
    const resolved = await runtime.respondToInteraction(executionId, { kind: "decision", choice: "Retry in place" });
    expect(resolved).toMatchObject({ status: "resolved", kind: "decision" });
    const result = await running;
    expect(result.status).toBe("success");
    expect(toolText).toContain("Main Agent decision: Retry in place");
    expect(result.summary).toContain("Retry in place");
    // The interaction is cleared once answered.
    expect((await runtime.inspectExecution(executionId))?.pendingInteraction).toBeUndefined();
  });

  it("writes an interactive event stream another terminal can follow, redacted by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ec-observability-"));
    const streamDir = path.join(root, "observability");
    const SECRET = "npm publish --token=super-secret-value";
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };

    const runWith = async (redactToolArgs: boolean, executionId: string): Promise<string> => {
      let emit: ((event: Record<string, unknown>) => void) | undefined;
      const state: { messages: Array<Record<string, unknown>> } = { messages: [] };
      const sdk: PiSdkLike = {
        ...safeResourceApis,
        ModelRuntime: { create: async () => modelRuntime },
        SessionManager: { inMemory: () => ({}) },
        createAgentSession: async () => ({
          session: {
            subscribe: (listener: (event: Record<string, unknown>) => void) => {
              emit = listener;
              return () => { emit = undefined; };
            },
            prompt: async () => {
              emit!({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: SECRET } });
              emit!({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "checking\tthe\tbuild\nthen the tests" }] } });
              emit!({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: true });
              state.messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "streamed" }) }] }];
            },
            waitForIdle: async () => {},
            dispose: () => {},
            state,
          },
        }),
      };
      const runtime = await PiExpertRuntime.create({
        cwd: gitSource,
        config: parseCouncilConfig({ security: { observability: { expertWindow: "interactive", redactToolArgs } } }),
        sdk,
        modelRuntime,
        roleDirectory,
        observabilityDir: streamDir,
      });
      await runtime.executeExpert({
        executionId,
        role: "implementation-worker",
        task: "Produce a stream",
        model: "p/m",
        tools: ["read", "bash"],
        skills: [],
        reasoningLevel: "low",
        readOnly: false,
        workspace: gitSource,
        timeoutMs: 30_000,
        attempt: 1,
      });
      // closeObservabilityStream awaits the write chain, so no poll is needed here.
      return await readFile(path.join(streamDir, `${executionId}.jsonl`), "utf8");
    };

    try {
      const redacted = (await runWith(true, "exec_stream_redacted")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(redacted.map((line) => line.kind)).toEqual(["started", "tool_started", "assistant_text", "tool_finished", "completed"]);
      expect(redacted[1]).toMatchObject({ tool: "bash" });
      expect(redacted[1]).not.toHaveProperty("argsSummary");
      expect(redacted[3]).toMatchObject({ tool: "bash", ok: false });
      // Narration is collapsed onto one bounded line so the stream stays one event per line.
      expect(String(redacted[2]!.text)).toBe("checking the build then the tests");
      expect(JSON.stringify(redacted)).not.toContain(SECRET);

      const open = (await runWith(false, "exec_stream_open")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(String(open[1]!.argsSummary)).toContain("npm publish");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("bounces a stop report that carries no real findings and accepts a substantive one", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    let stopTool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> } | undefined;
    let bounceText = "";
    let acceptText = "";
    const state: { messages: Array<Record<string, unknown>> } = { messages: [] };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        const custom = (options.customTools ?? []) as Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
        stopTool = custom.find((tool) => tool.name === "report_and_stop");
        return {
          session: {
            prompt: async () => {
              // A "no blocker" stop with filler findings must not be credited as delivery.
              bounceText = (await stopTool!.execute("s1", {
                reason: "No blocker for the assigned inventory - the report is complete.",
                findings: ["placeholders", "   "],
                recommendedNextAction: "nothing",
              })).content[0]!.text;
              acceptText = (await stopTool!.execute("s2", {
                reason: "Cannot run the suite: this role has no shell tool.",
                findings: ["read tests/pi-runtime.test.ts", "TBD"],
                risks: ["counts are static, not executed"],
                recommendedNextAction: "dispatch an implementation worker to run vitest",
              })).content[0]!.text;
              state.messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "ignored, the stop report wins" }) }] }];
            },
            waitForIdle: async () => {},
            dispose: () => {},
            state,
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({
      cwd: process.cwd(),
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    const result = await runtime.executeExpert({
      executionId: "exec_stop_bounce",
      role: "scout",
      task: "Inventory then stop honestly",
      model: "p/m",
      tools: ["read"],
      skills: [],
      reasoningLevel: "low",
      readOnly: true,
      workspace: process.cwd(),
      timeoutMs: 30_000,
      attempt: 1,
    });
    expect(bounceText).toContain("Stop report rejected");
    expect(acceptText).toContain("Stop report recorded");
    expect(result.status).toBe("partial");
    expect(result.executionMetadata).toMatchObject({ stoppedByExpert: true, failureType: "missing_context" });
    // Filler entries are stripped from the accepted report too.
    expect(result.findings).toEqual(["read tests/pi-runtime.test.ts"]);
  }, 60_000);

  it("refuses a concurrent second interaction instead of orphaning the open one", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    let decisionTool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> } | undefined;
    let toolTexts: string[] = [];
    const state: { messages: Array<Record<string, unknown>> } = { messages: [] };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        const custom = (options.customTools ?? []) as Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
        decisionTool = custom.find((tool) => tool.name === "request_decision");
        return {
          session: {
            prompt: async () => {
              // Two decision requests raised from one assistant turn (parallel tool calls).
              const [first, second] = await Promise.all([
                decisionTool!.execute("t1", { question: "First?", options: [{ label: "f1" }, { label: "f2" }] }),
                decisionTool!.execute("t2", { question: "Second?", options: [{ label: "s1" }, { label: "s2" }] }),
              ]);
              toolTexts = [first.content[0]!.text, second.content[0]!.text];
              state.messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "both settled" }) }] }];
            },
            waitForIdle: async () => {},
            dispose: () => {},
            state,
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({
      cwd: gitSource,
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    const executionId = "exec_serialize_test";
    const running = runtime.executeExpert({
      executionId,
      role: "implementation-worker",
      task: "Ask two questions at once",
      model: "p/m",
      tools: ["read", "bash"],
      skills: [],
      reasoningLevel: "low",
      readOnly: false,
      workspace: gitSource,
      timeoutMs: 20_000,
      attempt: 1,
    });
    // Before the fix the second request overwrote pendingInteraction and the first
    // tool call hung until the 15-minute wait timeout: the host could never answer it.
    let progress = await runtime.inspectExecution(executionId);
    for (let i = 0; i < 50 && !progress?.pendingInteraction; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      progress = await runtime.inspectExecution(executionId);
    }
    expect(progress?.pendingInteraction?.request.question).toBe("First?");
    expect((await runtime.respondToInteraction(executionId, { kind: "decision", choice: "f1" })).status).toBe("resolved");
    const result = await running;
    expect(result.status).toBe("success");
    expect(toolTexts.filter((text) => text.includes("Main Agent decision: f1"))).toHaveLength(1);
    expect(toolTexts.filter((text) => text.includes("already awaiting the Main Agent"))).toHaveLength(1);
    // A refusal is not charged against the interaction budget.
    expect(result.executionMetadata?.interactionRounds).toBe(1);
  }, 30_000);

  it("respondToInteraction reports not-found for an unknown execution without throwing", async () => {
    const modelRuntime = {
      getAvailable: async () => [],
      getModel: () => undefined,
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async () => ({ session: { prompt: async () => {}, dispose: () => {}, state: { messages: [] } } }),
    };
    const runtime = await PiExpertRuntime.create({
      cwd: process.cwd(),
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    expect((await runtime.respondToInteraction("exec_missing", { kind: "decision", otherText: "x" })).status).toBe("not-found");
  });

  it("grants a requested tool once, activates it, and auto-revokes after its first use", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    let requestTool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> } | undefined;
    let fireEvent: ((event: unknown) => void) | undefined;
    let lastActive: string[] = [];
    let grantText = "";
    const state: { messages: Array<Record<string, unknown>> } = { messages: [] };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        const custom = (options.customTools ?? []) as Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
        requestTool = custom.find((tool) => tool.name === "request_tool");
        expect(requestTool).toBeDefined();
        return {
          session: {
            prompt: async () => {
              const res = await requestTool!.execute("t1", { tool: "grep", reason: "need to search the tree" });
              grantText = res.content[0]!.text;
              state.messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: grantText }) }] }];
            },
            waitForIdle: async () => {},
            dispose: () => {},
            subscribe: (listener: (event: unknown) => void) => { fireEvent = listener; return () => {}; },
            setActiveToolsByName: (names: string[]) => { lastActive = [...names]; },
            state,
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({ cwd: gitSource, config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const executionId = "exec_tool_once";
    const running = runtime.executeExpert({
      executionId, role: "implementation-worker", task: "Build it", model: "p/m",
      tools: ["read", "edit", "write"], skills: [], readOnly: false, workspace: gitSource, timeoutMs: 20_000, attempt: 1,
    });
    let progress = await runtime.inspectExecution(executionId);
    for (let i = 0; i < 50 && !progress?.pendingInteraction; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      progress = await runtime.inspectExecution(executionId);
    }
    expect(progress?.pendingInteraction?.request).toMatchObject({ kind: "tool_approval", tool: "grep" });
    expect((await runtime.respondToInteraction(executionId, { kind: "tool_approval", scope: "once" })).status).toBe("resolved");
    const result = await running;
    expect(result.status).toBe("success");
    expect(grantText).toContain("granted \"grep\" (once)");
    expect(lastActive).toContain("grep");
    // Simulate the tool completing once; the pump must deactivate it.
    fireEvent?.({ type: "tool_execution_end", toolName: "grep" });
    expect(lastActive).not.toContain("grep");
  });

  it("refuses to escalate a mutating tool to a read-only execution without raising an interaction", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    let requestTool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> } | undefined;
    let boundaryText = "";
    const state: { messages: Array<Record<string, unknown>> } = { messages: [] };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        const custom = (options.customTools ?? []) as Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
        requestTool = custom.find((tool) => tool.name === "request_tool");
        return {
          session: {
            prompt: async () => {
              const res = await requestTool!.execute("t1", { tool: "edit", reason: "want to write files" });
              boundaryText = res.content[0]!.text;
              state.messages = [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "done" }) }] }];
            },
            waitForIdle: async () => {},
            dispose: () => {},
            subscribe: () => () => {},
            setActiveToolsByName: () => {},
            state,
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    // A scout is a read-only role; requesting edit must be refused at the boundary, no pending interaction.
    const result = await runtime.executeExpert({
      executionId: "exec_ro_boundary", role: "scout", task: "Explore", model: "p/m",
      tools: ["read", "grep"], skills: [], readOnly: true, workspace: process.cwd(), timeoutMs: 20_000, attempt: 1,
    });
    expect(result.status).toBe("success");
    expect(boundaryText).toContain("read-only execution");
  });

  it("keeps expert sessions alive under security.expertLifetime detached and aborts them by default (host-bound)", async () => {
    const config = parseCouncilConfig({});
    expect(config.security.expertLifetime).toBe("host-bound");
    const detached = parseCouncilConfig({ security: { expertLifetime: "detached" } });
    expect(detached.security.expertLifetime).toBe("detached");
  });

  it("returns an evidence-bearing failed result when an expert times out", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async () => ({
        session: {
          prompt: () => new Promise(() => {}),
          waitForIdle: async () => {},
          dispose: () => {},
          abort: async () => {},
          state: { messages: [] },
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: gitSource, config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      role: "implementation-worker", task: "hang", model: "p/m", tools: ["read"], skills: [],
      reasoningLevel: "low", readOnly: false, workspace: gitSource, timeoutMs: 1_500, attempt: 1,
    });
    expect(result.status).toBe("failed");
    expect(result.executionMetadata?.failureType).toBe("timeout");
    expect(result.summary).toContain("timed out");
    expect(result.filesChanged === undefined || Array.isArray(result.filesChanged)).toBe(true);
  });

  it("returns an evidence-bearing failed result when the expert session throws", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async () => ({
        session: {
          prompt: async () => { throw new Error("boom"); },
          waitForIdle: async () => {},
          dispose: () => {},
          state: { messages: [] },
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: gitSource, config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      role: "implementation-worker", task: "throw", model: "p/m", tools: ["read"], skills: [],
      reasoningLevel: "low", readOnly: false, workspace: gitSource, timeoutMs: 5_000, attempt: 1,
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("boom");
  });

  it("runs a bounded verification command and reports the real exit code", async () => {
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      getModel: () => nativeModel,
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async () => ({ session: { prompt: async () => {}, waitForIdle: async () => {}, dispose: () => {}, state: { messages: [] } } }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const ok = await runtime.verifyCommand!({ workspace: process.cwd(), command: [process.execPath, "-e", "process.exit(3)"] });
    expect(ok.exitCode).toBe(3);
    expect(typeof ok.durationMs).toBe("number");
    const tooMany = await runtime.verifyCommand!({ workspace: process.cwd(), command: Array.from({ length: 13 }, () => "x") });
    expect(tooMany.exitCode).toBeNull();
    expect(tooMany.message).toMatch(/1 to 12/);
    const outside = await runtime.verifyCommand!({ workspace: path.parse(process.cwd()).root, command: [process.execPath, "-e", "process.exit(0)"] });
    expect(outside.exitCode).toBeNull();
    expect(outside.message).toMatch(/Workspace rejected|outside|allowed/i);
  });

  it("loads no extensions and exposes only user or explicitly allowlisted project Skills", async () => {
    let loaderOptions: Record<string, unknown> | undefined;
    let settingsOptions: { projectTrusted?: boolean } | undefined;
    class FilteringResourceLoader {
      private skills: Array<Record<string, unknown>> = [];
      constructor(private readonly options: Record<string, unknown>) { loaderOptions = options; }
      async reload(options?: { resolveProjectTrust?: (context: unknown) => Promise<boolean> }) {
        expect(await options?.resolveProjectTrust?.({})).toBe(true);
        const current = {
          skills: [
            { name: "user-skill", sourceInfo: { scope: "user" } },
            { name: "approved-project-skill", sourceInfo: { scope: "project" } },
            { name: "hostile-project-skill", sourceInfo: { scope: "project" } },
          ],
          diagnostics: [],
        };
        const override = this.options.skillsOverride as (value: typeof current) => typeof current;
        this.skills = override(current).skills;
      }
      getSkills() { return { skills: this.skills, diagnostics: [] }; }
      getExtensions() { return { extensions: [], diagnostics: [] }; }
    }
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m" }],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => { throw new Error("not used"); },
      SettingsManager: { create: (_cwd, _agentDir, options) => { settingsOptions = options; return {}; } },
      DefaultResourceLoader: FilteringResourceLoader,
      getAgentDir: () => path.resolve(".pi-test-agent"),
    };
    const runtime = await PiExpertRuntime.create({
      cwd: process.cwd(),
      config: parseCouncilConfig({ security: { trustedSkills: ["approved-project-skill"] } }),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    expect(await runtime.listSkills()).toMatchObject([
      { name: "user-skill", trusted: true },
      { name: "approved-project-skill", trusted: true },
    ]);
    expect(settingsOptions).toEqual({ projectTrusted: true });
    expect(loaderOptions).toMatchObject({
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });

  it("records Skill discovery failures as runtime limitations", async () => {
    class BrokenResourceLoader {
      constructor(_options: Record<string, unknown>) {}
      async reload() { throw new Error("skill index unreadable"); }
      getSkills() { return { skills: [], diagnostics: [] }; }
      getExtensions() { return { extensions: [], diagnostics: [] }; }
    }
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m" }],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => { throw new Error("not used"); },
      SettingsManager: { create: () => ({}) },
      DefaultResourceLoader: BrokenResourceLoader,
      getAgentDir: () => path.resolve(".pi-test-agent"),
    };
    const runtime = await PiExpertRuntime.create({
      cwd: process.cwd(),
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
      roleDirectory,
    });
    expect(await runtime.listSkills()).toEqual([]);
    expect((await runtime.getCapabilities()).limitations).toContain(
      "Pi Skill discovery failed: skill index unreadable",
    );
  });

  it("extracts the first balanced JSON object from prose instead of the greedy brace span", async () => {
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m" }],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => ({
        session: {
          prompt: async () => {},
          waitForIdle: async () => {},
          dispose: () => {},
          state: {
            messages: [{
              role: "assistant",
              content: [{
                type: "text",
                text: 'Plan {broken, not json} then result: {"status":"success","summary":"ok","findings":["brace } inside string"]} done.',
              }],
            }],
          },
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect files",
      model: "p/m",
      tools: ["read"],
      skills: [],
      readOnly: true,
      timeoutMs: 1_000,
      attempt: 1,
    });
    expect(result).toMatchObject({ status: "success", summary: "ok", findings: ["brace } inside string"] });
  });

  it("derives worktree age from the embedded name epoch, not directory mtime", async () => {
    const epoch = 1_788_400_000_000;
    const name = `repo-${epoch}-9a1b2c3d-exec_abc123_x9`;
    expect(worktreeNameEpochMs(path.join("base", name))).toBe(epoch);
    expect(worktreeNameEpochMs("legacy-worktree-without-epoch")).toBeUndefined();
    expect(worktreeNameEpochMs(`repo-notanepoch-9a1b2c3d-exec`)).toBeUndefined();
  });

  it("classifies malformed structured output as a reasoning failure", async () => {
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m" }],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => ({
        session: {
          prompt: async () => {},
          waitForIdle: async () => {},
          dispose: () => {},
          state: { messages: [{ role: "assistant", content: [{ type: "text", text: "not structured json" }] }] },
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect files",
      model: "p/m",
      tools: ["read"],
      skills: [],
      readOnly: true,
      timeoutMs: 1_000,
      attempt: 1,
    });
    expect(result).toMatchObject({ status: "partial", executionMetadata: { failureType: "reasoning_failure" } });
  });

  it("surfaces provider session errors instead of an empty-response result", async () => {
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m" }],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => ({
        session: {
          prompt: async () => {},
          waitForIdle: async () => {},
          dispose: () => {},
          state: {
            messages: [
              { role: "user", content: [{ type: "text", text: "task" }] },
              {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: '403: Access to model denied. Please make sure you are eligible for using the model.',
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
              },
            ],
          },
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect files",
      model: "p/m",
      tools: ["read"],
      skills: [],
      readOnly: true,
      timeoutMs: 1_000,
      attempt: 1,
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Access to model denied");
    expect(result.executionMetadata?.failureType).toBe("provider_error");
  });

  it("refreshes callable models before every execution", async () => {
    let discoveryCalls = 0;
    let sessionCalls = 0;
    const modelRuntime = {
      getAvailable: async () => discoveryCalls++ === 0 ? [{ provider: "p", id: "m" }] : [],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => {
        sessionCalls += 1;
        throw new Error("must not create a session for a stale model");
      },
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    expect(await runtime.listAvailableModels()).toHaveLength(1);
    const result = await runtime.executeExpert({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect files",
      model: "p/m",
      tools: ["read"],
      skills: [],
      readOnly: true,
      timeoutMs: 1_000,
      attempt: 1,
    });
    expect(result.executionMetadata?.failureType).toBe("provider_error");
    expect(sessionCalls).toBe(0);
  });

  it("applies the timeout to waitForIdle and aborts a stalled session", async () => {
    let abortCalls = 0;
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m" }],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => ({
        session: {
          prompt: async () => {},
          waitForIdle: async () => new Promise<void>(() => {}),
          abort: async () => { abortCalls += 1; },
          dispose: () => {},
        },
      }),
    };
    const runtime = await PiExpertRuntime.create({ cwd: process.cwd(), config: parseCouncilConfig({}), sdk, modelRuntime, roleDirectory });
    const result = await runtime.executeExpert({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect files",
      model: "p/m",
      tools: ["read"],
      skills: [],
      readOnly: true,
      timeoutMs: 25,
      attempt: 1,
    });
    expect(result.executionMetadata?.failureType).toBe("timeout");
    expect(abortCalls).toBeGreaterThan(0);
  });
});

describe("zombie-session abort regression", () => {
  it("forces a hung expert session to settle so dispose and cleanup always run", async () => {
    const { parseCouncilConfig } = await import("../packages/core/src/index.js");
    const { PiExpertRuntime } = await import("../packages/pi-runtime/src/pi-runtime.js");
    const config = parseCouncilConfig({});
    const disposeCalls: number[] = [];
    const modelRuntime = {
      getAvailable: async () => [{ provider: "p", id: "m" }],
      getModel: () => ({ id: "m", provider: "p" }),
    };
    // A Pi session whose prompt promise never settles: exactly the zombie
    // scenario behind repeated phantom "attempt 2/3/…" notifications.
    const hungSession = {
      prompt: () => new Promise<void>(() => {}),
      dispose: () => { disposeCalls.push(1); },
      messages: [],
      getAvailableThinkingLevels: () => ["default"],
    };
    const sdk = {
      ModelRuntime: { create: async () => modelRuntime },
      createAgentSession: async () => ({ session: hungSession }),
      DefaultResourceLoader: class {
        async reload() {}
        getSkills() { return { skills: [], diagnostics: [] }; }
        getExtensions() { return { extensions: [], diagnostics: [] }; }
      },
      SettingsManager: { create: () => ({}) },
      getAgentDir: () => "unused",
    };
    const { mkdtemp } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "ec-zombie-"));
    const runtime = await PiExpertRuntime.create({ cwd: dir, config, sdk, modelRuntime, roleDirectory: path.join(process.cwd(), "packages", "core", "dist", "roles") });

    const pending = runtime.executeExpert({
      executionId: "exec_zombie",
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect a tiny file",
      model: "p/m",
      tools: ["read"],
      skills: [],
      readOnly: true,
      timeoutMs: 300_000,
      attempt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Wait until the session is actually registered (first transform may be slow).
    for (let i = 0; i < 100; i += 1) {
      if (await runtime.inspectExecution("exec_zombie")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const requested = await runtime.abortExecution({ executionId: "exec_zombie", reason: "stop" });
    expect(requested.status).toBe("abort-requested");

    // The executeExpert promise must settle promptly instead of hanging until
    // the timeout, and the finally cleanup (delete + dispose) must run.
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("executeExpert did not settle after abort")), 2_000)),
    ]);
    expect(result.status).toBe("aborted");
    expect(result.summary).toContain("aborted by the Main Agent");
    expect(disposeCalls.length).toBe(1);
    expect(await runtime.inspectExecution("exec_zombie")).toBeUndefined();
  });
});

describe("council compositions persistence", () => {
  it("binds, unbinds, prunes stale bindings, and creates the file lazily", async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { JsonCompositionsStore } = await import("../packages/pi-runtime/src/file-compositions.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "ec-compositions-"));
    const filePath = path.join(dir, "council-compositions.json");
    try {
      const store = new JsonCompositionsStore(filePath);
      // A missing file is an empty feature, not an error.
      expect(await store.load()).toBeUndefined();

      const now = new Date("2026-09-07T00:00:00.000Z");
      await store.bind("session-a", "daily-cheap", now);
      // Lazy creation: the first bind writes the file.
      const onDisk = JSON.parse(await readFile(filePath, "utf8"));
      expect(onDisk.sessions["session-a"]).toEqual({ name: "daily-cheap", updatedAt: now.toISOString() });
      expect((await store.load())?.sessions?.["session-a"]?.name).toBe("daily-cheap");

      await store.unbind("session-a", now);
      expect((await store.load())?.sessions).toBeUndefined();

      // A stale binding is pruned on load and written back to disk.
      await writeFile(filePath, `${JSON.stringify({
        compositions: [{ name: "old" }],
        sessions: {
          stale: { name: "old", updatedAt: "2020-01-01T00:00:00.000Z" },
          fresh: { name: "old", updatedAt: now.toISOString() },
        },
      })}\n`, "utf8");
      const reloaded = new JsonCompositionsStore(filePath);
      const loaded = await reloaded.load();
      expect(loaded?.sessions?.stale).toBeUndefined();
      expect(loaded?.sessions?.fresh).toBeDefined();
      const prunedOnDisk = JSON.parse(await readFile(filePath, "utf8"));
      expect(prunedOnDisk.sessions.stale).toBeUndefined();
      expect(prunedOnDisk.sessions.fresh.name).toBe("old");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("worktree provisioning", () => {
  async function provisioningConfig(workspaceProvisioning: Record<string, unknown>) {
    return parseCouncilConfig({ security: { workspaceProvisioning } }).security.workspaceProvisioning;
  }

  it("derives install argv from the repository lockfile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ec-provision-detect-"));
    try {
      const auto = await provisioningConfig({ mode: "auto" });
      await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
      await expect(detectProvisioningPlan(root, auto)).resolves.toEqual({
        packageManager: "pnpm",
        argv: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"],
      });
      await rm(path.join(root, "pnpm-lock.yaml"));
      await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
      await expect(detectProvisioningPlan(root, auto)).resolves.toEqual({
        packageManager: "npm",
        argv: ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts"],
      });
      await rm(path.join(root, "package-lock.json"));
      await writeFile(path.join(root, "bun.lockb"), "binary\n", "utf8");
      await expect(detectProvisioningPlan(root, auto)).resolves.toEqual({
        packageManager: "bun",
        argv: ["bun", "install", "--frozen-lockfile"],
      });
      await rm(path.join(root, "bun.lockb"));
      await writeFile(path.join(root, "uv.lock"), "version = 1\n", "utf8");
      await expect(detectProvisioningPlan(root, auto)).resolves.toEqual({
        packageManager: "uv",
        argv: ["uv", "sync", "--frozen"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes mainstream non-node ecosystems from their global caches and delegates as-code backends", async () => {
    const auto = await provisioningConfig({ mode: "auto" });
    const asCode = await provisioningConfig({ mode: "auto", strategy: "as-code" });
    const inPlace = await provisioningConfig({ mode: "auto", strategy: "in-place" });
    const cases: Array<{ file: string; packageManager: string; cmd0: string }> = [
      { file: "Cargo.toml", packageManager: "cargo", cmd0: "cargo" },
      { file: "go.mod", packageManager: "go", cmd0: "go" },
      { file: "pom.xml", packageManager: "maven", cmd0: "mvn" },
      { file: "Gemfile.lock", packageManager: "bundler", cmd0: "bundle" },
      { file: "composer.lock", packageManager: "composer", cmd0: "composer" },
      { file: "mix.lock", packageManager: "mix", cmd0: "mix" },
      { file: "yarn.lock", packageManager: "yarn", cmd0: "yarn" },
      { file: "poetry.lock", packageManager: "poetry", cmd0: "poetry" },
    ];
    for (const c of cases) {
      const root = await mkdtemp(path.join(tmpdir(), "ec-provision-lang-"));
      try {
        await writeFile(path.join(root, c.file), "x\n", "utf8");
        const plan = await detectProvisioningPlan(root, auto);
        expect(plan.packageManager).toBe(c.packageManager);
        expect(plan.argv?.[0]).toBe(c.cmd0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    // as-code backend: nix is surfaced (not materialized) when strategy=as-code, before any driver.
    const nixRoot = await mkdtemp(path.join(tmpdir(), "ec-provision-nix-"));
    try {
      await writeFile(path.join(nixRoot, "flake.nix"), "{}\n", "utf8");
      await expect(detectProvisioningPlan(nixRoot, asCode)).resolves.toMatchObject({ packageManager: "nix" });
      // devcontainer surfaced only as a fallback when no driver matches.
      await rm(path.join(nixRoot, "flake.nix"));
      await mkdir(path.join(nixRoot, ".devcontainer"));
      await writeFile(path.join(nixRoot, ".devcontainer", "devcontainer.json"), "{}\n", "utf8");
      await expect(detectProvisioningPlan(nixRoot, auto)).resolves.toMatchObject({ packageManager: "devcontainer" });
    } finally {
      await rm(nixRoot, { recursive: true, force: true });
    }
    // in-place strategy never materializes.
    const nodeRoot = await mkdtemp(path.join(tmpdir(), "ec-provision-inplace-"));
    try {
      await writeFile(path.join(nodeRoot, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
      await expect(detectProvisioningPlan(nodeRoot, inPlace)).resolves.toMatchObject({ detail: expect.stringContaining("in-place") });
    } finally {
      await rm(nodeRoot, { recursive: true, force: true });
    }
  });

  it("uses a custom argv verbatim and reports unsupported ecosystems as skipped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ec-provision-custom-"));
    try {
      const custom = await provisioningConfig({ mode: "custom", command: ["npm", "install", "--ignore-scripts", "--omit=dev"] });
      await expect(detectProvisioningPlan(root, custom)).resolves.toEqual({
        packageManager: "npm",
        argv: ["npm", "install", "--ignore-scripts", "--omit=dev"],
      });
      const emptyCustom = await provisioningConfig({ mode: "custom" });
      await expect(detectProvisioningPlan(root, emptyCustom)).resolves.toMatchObject({
        detail: expect.stringContaining("non-empty command"),
      });
      const auto = await provisioningConfig({ mode: "auto" });
      await expect(provisionWorkspace(root, auto)).resolves.toMatchObject({ status: "skipped" });
      const none = await provisioningConfig({});
      await expect(provisionWorkspace(root, none)).resolves.toMatchObject({
        status: "skipped",
        detail: "security.workspaceProvisioning.mode is none.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scrubs the child environment down to a fixed allowlist", () => {
    const scrubbed = scrubProvisioningEnv({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      GIT_AUTHOR_NAME: "Tester",
      npm_config_registry: "https://registry.example",
      NPM_CONFIG_CACHE: "/tmp/cache",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      EXPERT_COUNCIL_CONFIG: "/tmp/secret-config.json",
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/tester");
    expect(scrubbed.GIT_AUTHOR_NAME).toBe("Tester");
    expect(scrubbed.npm_config_registry).toBe("https://registry.example");
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(scrubbed.EXPERT_COUNCIL_CONFIG).toBeUndefined();
  });

  it("matches reusable worktrees by execution-id suffix", () => {
    expect(worktreeMatchesExecutionId("/base/repo-1788-abc-exec_x9", "exec_x9")).toBe(true);
    expect(worktreeMatchesExecutionId("/base/repo-1788-abc-other", "exec_x9")).toBe(false);
    expect(worktreeMatchesExecutionId("/base/repo-1788-abc-exec_x9-other", "exec_x9")).toBe(false);
  });

  it("degrades to a failed status instead of throwing when provisioning fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ec-provision-fail-"));
    try {
      await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
      const auto = await provisioningConfig({ mode: "auto" });
      const failed = await provisionWorkspace(root, auto, {
        runner: async () => ({ exitCode: 1, stdout: "installing\n", stderr: "registry unreachable", timedOut: false }),
      });
      expect(failed).toMatchObject({ status: "failed", packageManager: "npm" });
      expect(failed.detail).toContain("registry unreachable");
      const threw = await provisionWorkspace(root, auto, {
        runner: async () => { throw new Error("spawn ENOENT"); },
      });
      expect(threw).toMatchObject({ status: "failed" });
      expect(threw.detail).toContain("spawn ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the configured removal timeout and verification argv", async () => {
    const config = parseCouncilConfig({
      security: { workspaceProvisioning: { removalTimeoutMs: 120_000, verifyCommand: ["npm", "run", "typecheck"] } },
    });
    expect(config.security.workspaceProvisioning.removalTimeoutMs).toBe(120_000);
    expect(planVerification(config.security.workspaceProvisioning)).toEqual([
      { command: ["npm", "run", "typecheck"], label: "npm run typecheck" },
    ]);
    const defaults = parseCouncilConfig({}).security.workspaceProvisioning;
    expect(planVerification(defaults)).toEqual([
      { command: ["npm", "run", "typecheck"], label: "npm run typecheck" },
      { command: ["npm", "test"], label: "npm test" },
    ]);
  });

  it("downgrades a verified success to partial with a test_failure", () => {
    const downgraded = applyVerificationGate({
      status: "success",
      role: "implementation-worker",
      model: "p/one",
      summary: "implemented",
      executionMetadata: {
        provisioning: { status: "ready", packageManager: "npm" },
        verification: [{ command: "npm test", status: "failed", summary: "exit code 1" }],
      },
    });
    expect(downgraded.status).toBe("partial");
    expect(downgraded.executionMetadata?.failureType).toBe("test_failure");
    const passed = applyVerificationGate({
      status: "success",
      role: "implementation-worker",
      model: "p/one",
      summary: "implemented",
      executionMetadata: { verification: [{ command: "npm test", status: "passed", summary: "exit code 0" }] },
    });
    expect(passed.status).toBe("success");
    expect(passed.executionMetadata?.failureType).toBeUndefined();
  });
});

describe("council-config default path", () => {
  it("falls back to the data-directory council-config.json without any environment variable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ec-config-default-"));
    const savedEnv = process.env.EXPERT_COUNCIL_CONFIG;
    delete process.env.EXPERT_COUNCIL_CONFIG;
    try {
      const missing = await loadCouncilConfig(undefined, path.join(dir, "council-config.json"));
      expect(missing.source).toBe("none");
      expect(missing.sourcePath).toBeUndefined();
      expect(missing.config.security.workspaceProvisioning.mode).toBe("none");

      const configPath = path.join(dir, "council-config.json");
      await writeFile(configPath, JSON.stringify({ security: { workspaceProvisioning: { mode: "auto" } } }));
      const present = await loadCouncilConfig(undefined, configPath);
      expect(present.source).toBe("default-file");
      expect(present.sourcePath).toBe(configPath);
      expect(present.config.security.workspaceProvisioning.mode).toBe("auto");

      // Malformed JSON in the default file still fails loudly (operator typo).
      await writeFile(configPath, "{ not json");
      await expect(loadCouncilConfig(undefined, configPath)).rejects.toThrow(/Invalid JSON/);

      // An explicit path that does not exist remains a hard error.
      await expect(loadCouncilConfig(path.join(dir, "absent.json"))).rejects.toThrow(/Unable to read/);
    } finally {
      if (savedEnv !== undefined) process.env.EXPERT_COUNCIL_CONFIG = savedEnv;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("python host interpreter fallback", () => {
  it("surfaces the host .venv interpreter path for Python ecosystems instead of a bare skip", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ec-py-worktree-"));
    const host = await mkdtemp(path.join(tmpdir(), "ec-py-host-"));
    try {
      const auto = parseCouncilConfig({ security: { workspaceProvisioning: { mode: "auto" } } }).security.workspaceProvisioning;
      await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = 'x'\n", "utf8");
      // No host interpreter: explicit guidance instead of a bare skip.
      const without = await detectProvisioningPlan(root, auto, host);
      expect(without.detail).toContain("no host .venv interpreter");
      // Windows-style host interpreter present: its absolute path is surfaced.
      const python = path.join(host, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
      await mkdir(path.dirname(python), { recursive: true });
      await writeFile(python, "", "utf8");
      const withVenv = await detectProvisioningPlan(root, auto, host);
      expect(withVenv.detail).toContain("invoke the host workspace interpreter directly");
      expect(withVenv.detail).toContain(python);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
    }
  });

});

describe("guardrails: observed tool failures, budget warnings, bounded nudges", () => {
  type Harness = {
    sdk: PiSdkLike;
    modelRuntime: { getAvailable: () => unknown[]; getModel: () => unknown };
    steers: string[];
  };

  function guardrailHarness(events: Array<Record<string, unknown>>, delayMs = 0): Harness {
    const steers: string[] = [];
    const state = {
      messages: [] as Array<{ role: string; content: Array<Record<string, unknown>> }>,
      model: { provider: "p", id: "m", name: "Mock", reasoning: true },
    };
    const modelRuntime = {
      getAvailable: () => [
        { provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      ],
      getModel: () => ({ provider: "p", id: "m" }),
    };
    const sdk: PiSdkLike = {
      ...safeResourceApis,
      ModelRuntime: { create: async () => modelRuntime } as unknown as PiSdkLike["ModelRuntime"],
      SessionManager: { inMemory: () => ({}) } as unknown as PiSdkLike["SessionManager"],
      createAgentSession: (async () => ({
        session: {
          prompt: async () => {
            for (const event of events) {
              (state as unknown as { fire?: (e: Record<string, unknown>) => void }).fire?.(event);
            }
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            state.messages = [
              { role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "Done.", findings: ["looked"] }) }] },
            ];
          },
          waitForIdle: async () => {},
          dispose: () => {},
          subscribe: (listener: (event: unknown) => void) => {
            (state as unknown as { fire?: (e: Record<string, unknown>) => void }).fire = listener;
            return () => {};
          },
          setActiveToolsByName: () => {},
          steer: async (text: string) => { steers.push(text); },
          state,
        },
      })) as PiSdkLike["createAgentSession"],
    };
    return { sdk, modelRuntime: modelRuntime as unknown as Harness["modelRuntime"], steers };
  }

  async function runGuardrail(harness: Harness, overrides: Record<string, unknown> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), "ec-guard-"));
    try {
      const runtime = await PiExpertRuntime.create({
        cwd: dir,
        config: parseCouncilConfig(overrides),
        sdk: harness.sdk,
        modelRuntime: harness.modelRuntime as never,
        roleDirectory,
        observabilityDir: dir,
      });
      return await runtime.executeExpert({
        executionId: "exec_guard", role: "scout", task: "Trace it", model: "p/m",
        tools: ["read"], skills: [], readOnly: true, workspace: dir, timeoutMs: 20_000, attempt: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const failures = (count: number, okFirst = true) =>
    Array.from({ length: count }, (_, i) => ({
      type: "tool_execution_end", toolName: "bash", toolCallId: `c${i}`,
      isError: okFirst ? i !== 0 : true,
    }));

  it("counts observed tool failures and raises one consecutive-failure warning with a bounded nudge", async () => {
    const harness = guardrailHarness(failures(4, false));
    const result = await runGuardrail(harness);
    expect(result.executionMetadata?.toolCalls).toBe(4);
    expect(result.executionMetadata?.toolErrors).toBe(4);
    const attention = result.executionMetadata?.attention ?? [];
    expect(attention.map((item) => item.code)).toEqual(["consecutive_tool_failures"]);
    expect(attention[0]!.detail).toContain("consecutive tool calls failed");
    expect(attention[0]!.nudgedExpert).toBe(true);
    // One nudge, not one per failing call, and it names the real escape hatches.
    expect(harness.steers).toHaveLength(1);
    expect(harness.steers[0]).toContain("Council guardrail");
    expect(harness.steers[0]).toContain("report_and_stop");
  });

  it("raises the failure-ratio rule once enough calls have been observed", async () => {
    // Alternating success/failure never reaches three in a row, so only the ratio fires.
    const alternating = Array.from({ length: 8 }, (_, i) => ({
      type: "tool_execution_end", toolName: "bash", toolCallId: `a${i}`, isError: i % 2 === 1,
    }));
    const harness = guardrailHarness(alternating);
    const result = await runGuardrail(harness);
    const codes = (result.executionMetadata?.attention ?? []).map((item) => item.code);
    expect(codes).toEqual(["failure_ratio_high"]);
    expect(harness.steers).toHaveLength(1);
  });

  it("warns at each configured budget fraction and nudges only at the highest one", async () => {
    // 60% and 85% of a 200ms budget, with a run that outlives both.
    const harness = guardrailHarness([], 350);
    const dir = await mkdtemp(path.join(tmpdir(), "ec-guard-budget-"));
    try {
      const runtime = await PiExpertRuntime.create({
        cwd: dir, config: parseCouncilConfig({}), sdk: harness.sdk,
        modelRuntime: harness.modelRuntime as never, roleDirectory, observabilityDir: dir,
      });
      const result = await runtime.executeExpert({
        executionId: "exec_guard_budget", role: "scout", task: "Trace it", model: "p/m",
        tools: ["read"], skills: [], readOnly: true, workspace: dir, timeoutMs: 200, attempt: 1,
      });
      const budget = (result.executionMetadata?.attention ?? []).filter((item) => item.code === "budget_fraction");
      expect(budget.map((item) => item.budgetFractionUsed)).toEqual([0.6, 0.85]);
      expect(budget.filter((item) => item.nudgedExpert)).toHaveLength(1);
      expect(harness.steers).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still counts tool calls when struggle detection is switched off", async () => {
    const harness = guardrailHarness(failures(4, false));
    const result = await runGuardrail(harness, {
      security: { guardrails: { warnHost: false, nudgeExpert: true, consecutiveToolFailures: 3, minCallsForRatio: 8, failureRatio: 0.5, budgetFractions: [0.6, 0.85] } },
    });
    expect(result.executionMetadata?.toolCalls).toBe(4);
    expect(result.executionMetadata?.toolErrors).toBe(4);
    expect(result.executionMetadata?.attention ?? []).toEqual([]);
    expect(harness.steers).toHaveLength(0);
  });
});
