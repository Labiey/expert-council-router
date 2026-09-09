import { fileURLToPath } from "node:url";
import {
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExpertCouncil, ExpertResult } from "../packages/core/src/index.js";

function hostCouncil(startDelegation: ExpertCouncil["startDelegation"]): ExpertCouncil {
  const assessment = {
    asOf: "2026-09-01T00:00:00.000Z",
    sources: ["https://livebench.ai/"],
    models: { "p/m": { coding: 8 } },
  };
  return {
    inspectResources: async () => ({
      models: [{ provider: "p", id: "m", available: true }], skills: [], billing: {}, roles: [], warnings: [],
      modelAssessment: assessment,
      runtimeCapabilities: {
        hostType: "pi-host-test",
        modelDiscovery: true,
        hardToolRestriction: true,
        skillOverride: true,
        subagentBackend: true,
        mutation: false,
        workspaceIsolation: "none",
        supportedTools: [],
        limitations: [],
      },
    }),
    buildCouncil: async (request) => ({
      id: "council_host", taskClass: "normal", task: request.task, experts: [], createdAt: "now", warnings: [],
      ...(request.constraints?.costPolicy || request.composition
        ? {}
        : { compositionMenu: [{ name: "auto", description: "create a session composition via costPolicy (economy/balanced/speed)" }] }),
    }),
    startDelegation,
    delegate: async (request) => (await startDelegation(request).result),
    getResult: async (executionId) => ({ executionId, status: "running" }),
    waitForResults: async ({ executionIds, mode = "all" }) => ({
      status: "timed-out", mode, completed: [], running: executionIds, notFound: [], waitedMs: 0,
    }),
    cleanup: async (executionId) => ({ executionId, status: "not-required" }),
    recordFeedback: async ({ executionId, verificationPassed }) => ({ executionId, status: "recorded", verificationPassed }),
    escalate: async () => ({ action: "stop", reason: "test" }),
    getStatus: async () => ({ plans: [], executions: [], telemetry: [] }),
    recordOutcome: async () => {},
  };
}

describe("Pi 0.84.4 extension host integration", () => {
  it("returns an entire batch immediately and routes completion through real Pi steer/followUp bindings", async () => {
    const finishers: Array<(result: ExpertResult) => void> = [];
    let nextId = 0;
    const council = hostCouncil((request) => {
      nextId += 1;
      let finish!: (result: ExpertResult) => void;
      const result = new Promise<ExpertResult>((resolve) => { finish = resolve; });
      finishers.push(finish);
      return { executionId: `exec_host_${nextId}`, result };
    });
    (globalThis as typeof globalThis & { __expertCouncilPiHostTest?: ExpertCouncil }).__expertCouncilPiHostTest = council;

    try {
      const cwd = process.cwd();
      const fixture = fileURLToPath(new URL("./fixtures/pi-host-extension.ts", import.meta.url));
      const loaded = await discoverAndLoadExtensions([fixture], cwd, undefined, createEventBus());
      expect(loaded.errors).toEqual([]);
      const sessionManager = SessionManager.inMemory(cwd);
      const runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        cwd,
        sessionManager,
        new ModelRegistry({} as never),
      );
      const messages: Array<{
        message: { content: string };
        options?: { deliverAs?: string; triggerTurn?: boolean };
      }> = [];
      let idle = false;
      runner.bindCore({
        sendMessage: (message, options) => messages.push({ message: message as { content: string }, options }),
        sendUserMessage: () => {},
        appendEntry: (customType, data) => { sessionManager.appendCustomEntry(customType, data); },
        setSessionName: () => {},
        getSessionName: () => undefined,
        setLabel: () => {},
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => {},
        refreshTools: () => {},
        getCommands: () => [],
        setModel: async () => false,
        getThinkingLevel: () => "off",
        setThinkingLevel: () => {},
      } as never, {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => idle,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
        getSystemPromptOptions: () => ({}),
      } as never);

      const registered = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
      const build = registered.find((tool) => tool.name === "expert_build");
      expect(build).toBeDefined();
      const preferenceRequired = await build!.execute("build-1", { task: "review" }, undefined, undefined);
      expect(JSON.parse((preferenceRequired.content[0] as { text: string }).text)).toMatchObject({
        status: "composition-menu-required",
        compositionMenu: [{ name: "auto" }],
      });
      const selectedPreference = await build!.execute(
        "build-2",
        {
          task: "review",
          costPolicy: "speed",
          modelAssessment: {
            asOf: "2026-09-02T00:00:00.000Z",
            sources: ["https://livebench.ai/"],
            models: {},
          },
        },
        undefined,
        undefined,
      );
      expect(JSON.parse((selectedPreference.content[0] as { text: string }).text)).toMatchObject({
        assemblyPreference: { costPolicy: "speed", source: "user-selected" },
      });
      const reusedPreference = await build!.execute("build-3", { task: "review again" }, undefined, undefined);
      expect(JSON.parse((reusedPreference.content[0] as { text: string }).text)).toMatchObject({
        assemblyPreference: { costPolicy: "speed", source: "reused-from-session" },
      });

      const delegate = registered.find((tool) => tool.name === "expert_delegate");
      expect(delegate).toBeDefined();
      const started = performance.now();
      const result = await delegate!.execute("call", {
        assignments: JSON.stringify([
          { role: "scout", task: "map files", taskDescription: "map", timeoutMs: 60_000 },
          { role: "reviewer", task: "review map", taskDescription: "review", timeoutMs: 60_000 },
        ]),
      }, undefined, undefined);
      expect(performance.now() - started).toBeLessThan(250);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
        status: "running",
        executions: [
          { executionId: "exec_host_1", role: "scout" },
          { executionId: "exec_host_2", role: "reviewer" },
        ],
      });
      expect(messages).toEqual([]);

      finishers[0]!({ status: "success", role: "scout", model: "p/a", summary: "done" });
      await Promise.resolve();
      await Promise.resolve();
      expect(messages[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });

      idle = true;
      finishers[1]!({ status: "success", role: "reviewer", model: "p/b", summary: "done" });
      await Promise.resolve();
      await Promise.resolve();
      expect(messages[1]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    } finally {
      delete (globalThis as typeof globalThis & { __expertCouncilPiHostTest?: ExpertCouncil }).__expertCouncilPiHostTest;
    }
  });
});
