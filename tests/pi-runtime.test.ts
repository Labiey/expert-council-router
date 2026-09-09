import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCouncilConfig } from "../packages/core/src/index.js";
import {
  defaultCouncilDataRoot,
  defaultCouncilStoragePaths,
  inferPiProviderBilling,
  PiExpertRuntime,
  validatePiSdk,
  type PiSdkLike,
  worktreeNameEpochMs,
} from "../packages/pi-runtime/src/index.js";

const roleDirectory = path.resolve("packages/core/src/roles/prompts");

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
      cwd: process.cwd(),
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
      workspace: process.cwd(),
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
    expect(sessionOptions?.tools).toEqual(["read", "grep"]);
    expect(sessionOptions?.model).toBe(nativeModel);
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
