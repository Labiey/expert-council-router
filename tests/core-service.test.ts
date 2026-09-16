import { describe, expect, it, vi } from "vitest";
import {
  activeModelAvailability,
  applyUsage,
  decideEscalation,
  evaluateModelAssessment,
  ExpertCouncilService,
  failureTypeForResult,
  inferFailureType,
  instantiateLedger,
  MemoryTelemetryStore,
  MODEL_AVAILABILITY_MARKER_TTL_MS,
  MODEL_RATE_LIMIT_MARKER_TTL_MS,
  observedAdjustment,
  resolveModelAssessment,
  sanitizeOutcome,
  withModelAvailabilityMarker,
} from "../packages/core/src/index.js";
import type { BillingPolicyEntry, CompositionDocument, CouncilStateOptions, CouncilStateSnapshot, ExpertResult, ModelAssessmentSnapshot, RoutePolicyDocument } from "../packages/core/src/index.js";
import { applyVerificationGate } from "../packages/pi-runtime/src/index.js";
import { capabilities, MockRuntime, model } from "./helpers.js";

const profiles = {
  "cheap/one": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
  "quality/two": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
};

describe("mandatory Main Agent model assessment gate", () => {
  const models = [model("p", "one"), model("p", "two")];

  it("requires research when the assessment is missing, stale, or misses a callable model", () => {
    expect(evaluateModelAssessment(models, undefined, { now: new Date("2026-09-02T00:00:00.000Z") })).toMatchObject({
      status: "required",
      reason: "missing",
      requiredModels: ["p/one", "p/two"],
    });
    expect(evaluateModelAssessment(models, {
      asOf: "2026-07-01T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/one": { coding: 7 }, "p/two": { coding: 7 } },
    }, { now: new Date("2026-09-02T00:00:00.000Z") })).toMatchObject({ status: "required", reason: "stale" });
    expect(evaluateModelAssessment(models, {
      asOf: "2026-09-01T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/one": { coding: 7 } },
    }, { now: new Date("2026-09-02T00:00:00.000Z") })).toMatchObject({
      status: "required",
      reason: "inventory-changed",
      missingModels: ["p/two"],
      researchModels: ["p/two"],
    });
  });

  it("accepts a complete current assessment", () => {
    expect(evaluateModelAssessment(models, {
      asOf: "2026-09-01T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/one": { coding: 7 }, "p/two": { coding: 8 } },
    }, { now: new Date("2026-09-02T00:00:00.000Z") })).toMatchObject({
      status: "current",
      reason: "current",
      missingModels: [],
      researchModels: [],
    });
  });

  it("reuses a current saved assessment when a host submits an incomplete replacement", () => {
    const saved = {
      asOf: "2026-09-01T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/one": { coding: 7 }, "p/two": { coding: 8 } },
    };
    const submitted = {
      asOf: "2026-09-02T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/one": { coding: 9 } },
    };
    const resolution = resolveModelAssessment(models, saved, submitted, {
      now: new Date("2026-09-02T01:00:00.000Z"),
    });
    expect(resolution).toMatchObject({
      assessment: saved,
      status: { status: "current", reason: "current", researchModels: [] },
      source: "saved",
      ignoredSubmittedAssessment: true,
    });
  });

  it("reports a future-dated assessment without requesting duplicate research", () => {
    const status = evaluateModelAssessment(models, {
      asOf: "2026-09-02T00:33:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/one": { coding: 7 }, "p/two": { coding: 8 } },
    }, { now: new Date("2026-09-02T00:00:00.000Z") });
    expect(status).toMatchObject({
      status: "required",
      reason: "future-dated",
      researchModels: [],
      futureSkewMinutes: 33,
      allowedFutureSkewMinutes: 5,
    });
    expect(status.instructions?.join(" ")).toContain("do not repeat web research");
  });
});

describe("shared failure classification", () => {
  it("uses one deterministic classifier for runtime errors and service results", () => {
    expect(inferFailureType(new Error("Provider rate limit reached"))).toBe("provider_error");
    expect(inferFailureType('403: Access to model denied. Please make sure you are eligible for using the model.')).toBe("provider_error");
    expect(failureTypeForResult({
      status: "failed",
      role: "reviewer",
      model: "p/m",
      summary: "Assertion failed",
    })).toBe("test_failure");
    expect(inferFailureType("No recognizable marker", "reasoning_failure")).toBe("reasoning_failure");
  });
});

describe("durable Main Agent model assessment", () => {
  it("persists a dated sourced assessment and reuses it for later councils", async () => {
    let saved: CouncilStateSnapshot | undefined;
    const saveIntents: Array<boolean | undefined> = [];
    const runtime = new MockRuntime([model("p", "old"), model("p", "new")]);
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      persistence: { save: async (snapshot, options) => {
        saved = snapshot;
        saveIntents.push(options?.replaceModelAssessment);
      } },
    });
    const assessment = {
      asOf: "2026-09-01T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: {
        "p/old": { coding: 4, toolReliability: 4, autonomousExecution: 4, bashReliability: 4 },
        "p/new": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
      },
      summary: "Main Agent cross-checked current coding and agentic results.",
    };
    const first = await service.buildCouncil({ task: "Implement a small feature", modelAssessment: assessment });
    const second = await service.buildCouncil({ task: "Implement another small feature" });
    expect(first.experts[0]?.model).toBe("p/new");
    expect(second.experts[0]?.model).toBe("p/new");
    expect(saved?.modelAssessment).toEqual(assessment);
    expect(saveIntents).toEqual([true, false]);
    expect((await service.inspectResources()).modelAssessment).toEqual(assessment);
  });
});

describe("retry and escalation", () => {
  it("starts delegation immediately and exposes feedback only after completion", async () => {
    let complete!: (result: {
      status: "success";
      role: "reviewer";
      model: string;
      summary: string;
    }) => void;
    const pending = new Promise<Parameters<typeof complete>[0]>((resolve) => {
      complete = resolve;
    });
    const runtime = new MockRuntime([model("cheap", "one")], [pending]);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });

    const handle = service.startDelegation({ role: "reviewer", task: "Review a bounded change", timeoutMs: 60_000 });
    expect(handle.executionId).toMatch(/^exec_/);
    expect(await service.getResult(handle.executionId)).toEqual({
      executionId: handle.executionId,
      status: "running",
    });

    complete({ status: "success", role: "reviewer", model: "cheap/one", summary: "review complete" });
    const result = await handle.result;
    expect(result.summary).toBe("review complete");
    expect(await service.getResult(handle.executionId)).toEqual({
      executionId: handle.executionId,
      status: "completed",
      result,
    });
  });

  it("maps cleanup of a non-isolated execution to not-required, keeping not-found real", async () => {
    const runtime = new MockRuntime(
      [model("cheap", "one")],
      [
        { status: "success", role: "scout", model: "cheap/one", summary: "explored", executionMetadata: { attempts: 1, isolated: false } },
        { status: "success", role: "reviewer", model: "cheap/one", summary: "reviewed", executionMetadata: { attempts: 1, isolated: true } },
      ],
    );
    // The boundary always reports that nothing matched, because no worktree exists.
    runtime.cleanupOutcome = { status: "not-found" };
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });

    const readOnly = service.startDelegation({ role: "scout", task: "Explore the repository", timeoutMs: 60_000 });
    await readOnly.result;
    const mapped = await service.cleanup(readOnly.executionId);
    expect(mapped.status).toBe("not-required");
    expect(mapped.message).toContain("no isolated worktree");

    const isolated = service.startDelegation({ role: "reviewer", task: "Review the bounded change", timeoutMs: 60_000 });
    await isolated.result;
    // For a run that did own a worktree, not-found stays a genuine signal.
    expect((await service.cleanup(isolated.executionId)).status).toBe("not-found");
    expect(runtime.cleanupCalls).toHaveLength(2);
  });

  it("respondToInteraction delegates to the runtime and reports unsupported when the runtime lacks it", async () => {
    const runtime = new MockRuntime([model("cheap", "one")]);
    runtime.respondToResult = { executionId: "ignored", status: "resolved", kind: "tool_approval" };
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });

    const result = await service.respondToInteraction({
      executionId: "exec_1",
      response: { kind: "tool_approval", scope: "persistent" },
    });
    expect(result).toEqual({ executionId: "exec_1", status: "resolved", kind: "tool_approval" });
    expect(runtime.interactionCalls).toEqual([
      { executionId: "exec_1", response: { kind: "tool_approval", scope: "persistent" } },
    ]);

    // A runtime without interactive support resolves a structured result, never a throw.
    const plain = new MockRuntime([model("cheap", "one")]);
    (plain as { respondToInteraction?: unknown }).respondToInteraction = undefined;
    const service2 = new ExpertCouncilService(plain, { profiles: { models: profiles } });
    expect(await service2.respondToInteraction({ executionId: "exec_2", response: { kind: "decision", otherText: "go" } }))
      .toMatchObject({ executionId: "exec_2", status: "not-found" });
  });

  it("attaches live progress to the running view only when expertWindow is enabled", async () => {
    const runtime = new MockRuntime([model("cheap", "one")], [
      new Promise<ExpertResult>(() => {}),
      new Promise<ExpertResult>(() => {}),
    ]);
    runtime.inspectExecution = async (executionId: string) => ({
      executionId,
      status: "running" as const,
      role: "reviewer",
      model: "cheap/one",
      startedAt: new Date().toISOString(),
      elapsedMs: 10,
      messageCount: 7,
      lastAssistantText: "reading the diff",
    });
    const off = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    off.startDelegation({ role: "reviewer", task: "Review", timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 15));
    expect((await off.getStatus({ view: "running" })).running[0]?.progress).toBeUndefined();

    const events = new ExpertCouncilService(runtime, { profiles: { models: profiles }, security: { observability: { expertWindow: "events" } } });
    events.startDelegation({ role: "reviewer", task: "Review", timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 15));
    const view = (await events.getStatus({ view: "running" })).running[0];
    expect(view?.progress).toMatchObject({ messageCount: 7, lastActivity: "reading the diff" });
  });

  it("echoes the effective observability settings and warns when interactive is configured", async () => {
    // A config toggle the host cannot observe is a placebo: inspect must report the
    // effective values, and the unimplemented tier must announce itself.
    const interactive = new ExpertCouncilService(new MockRuntime([model("cheap", "one")]), {
      profiles: { models: profiles },
      security: { observability: { expertWindow: "interactive" } },
    });
    const inventory = await interactive.inspectResources();
    expect(inventory.operatorConfig?.observability).toEqual({ expertWindow: "interactive", streamToHost: true, redactToolArgs: true });
    // This mock runtime cannot write an event stream, so the requested tier must say so.
    expect(inventory.warnings.join(" ")).toContain("cannot write a live event stream");

    const quiet = new ExpertCouncilService(new MockRuntime([model("cheap", "one")]), { profiles: { models: profiles } });
    const quietInventory = await quiet.inspectResources();
    expect(quietInventory.operatorConfig?.observability).toEqual({ expertWindow: "off", streamToHost: true, redactToolArgs: true });
    expect(quietInventory.warnings.join(" ")).not.toContain("cannot write a live event stream");

    // A runtime that CAN write the stream must not be warned about the same tier.
    const baseCapabilities = (await interactive.inspectResources()).runtimeCapabilities;
    const capable = new MockRuntime([model("cheap", "one")]);
    capable.getCapabilities = async () => ({ ...baseCapabilities, eventStream: { enabled: true } });
    const streamService = new ExpertCouncilService(capable, {
      profiles: { models: profiles },
      security: { observability: { expertWindow: "interactive" } },
    });
    const streamInventory = await streamService.inspectResources();
    expect(streamInventory.warnings.join(" ")).not.toContain("cannot write a live event stream");
    expect(streamInventory.runtimeCapabilities.eventStream).toMatchObject({ enabled: true });
  });

  it("waits without polling until any requested background execution completes", async () => {
    type Completed = { status: "success"; role: "reviewer"; model: string; summary: string };
    const finishers: Array<(result: Completed) => void> = [];
    const pending = [0, 1].map(() => new Promise<Completed>((resolve) => finishers.push(resolve)));
    const runtime = new MockRuntime([model("cheap", "one")], pending);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const first = service.startDelegation({ role: "reviewer", task: "Review module A", timeoutMs: 60_000 });
    const second = service.startDelegation({ role: "reviewer", task: "Review module B", timeoutMs: 60_000 });

    const waited = service.waitForResults({
      executionIds: [first.executionId, second.executionId],
      mode: "any",
      timeoutMs: 5_000,
    });
    finishers[0]!({ status: "success", role: "reviewer", model: "cheap/one", summary: "A complete" });

    expect(await waited).toMatchObject({
      status: "completed",
      mode: "any",
      completed: [first.executionId],
      running: [second.executionId],
      notFound: [],
    });
    finishers[1]!({ status: "success", role: "reviewer", model: "cheap/one", summary: "B complete" });
    await second.result;
  });

  it("returns missing executions immediately instead of holding a wait open", async () => {
    const service = new ExpertCouncilService(new MockRuntime([model("cheap", "one")]), {
      profiles: { models: profiles },
    });
    expect(await service.waitForResults({ executionIds: ["exec_missing"], timeoutMs: 60_000 })).toMatchObject({
      status: "not-found",
      completed: [],
      running: [],
      notFound: ["exec_missing"],
    });
  });

  it("returns a bounded timed-out wait while leaving the expert execution running", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<never>(() => {});
      const service = new ExpertCouncilService(new MockRuntime([model("cheap", "one")], [pending]), {
        profiles: { models: profiles },
      });
      const handle = service.startDelegation({ role: "reviewer", task: "Review a long-running change", timeoutMs: 60_000 });
      const waiting = service.waitForResults({ executionIds: [handle.executionId], timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waiting).toMatchObject({
        status: "timed-out",
        completed: [],
        running: [handle.executionId],
        notFound: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries one correctable failure on the same model", async () => {
    const runtime = new MockRuntime([model("cheap", "one")], [
      (request) => ({
        status: "failed",
        role: request.role,
        model: request.model,
        summary: "bad tool arguments",
        executionMetadata: { failureType: "tool_call_error", usage: { inputTokens: 10, outputTokens: 2 } },
      }),
      (request) => ({
        status: "success",
        role: request.role,
        model: request.model,
        summary: "fixed",
        executionMetadata: { usage: { inputTokens: 20, outputTokens: 4 } },
      }),
    ]);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const result = await service.delegate({ role: "implementation-worker", task: "Rename a local symbol", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[0]?.model).toBe(runtime.requests[1]?.model);
    expect(result.executionMetadata?.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
    const execution = (await service.getStatus()).executions[0]!;
    expect(execution.attemptHistory).toHaveLength(2);
    expect(execution.attemptHistory?.[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      failureType: "tool_call_error",
      summary: "bad tool arguments",
    });
    expect(execution.attemptHistory?.[1]).toMatchObject({ attempt: 2, status: "success" });
    expect(execution.attemptHistory?.[1]).not.toHaveProperty("summary");
  });

  it("moves to the next candidate after repeated failures", async () => {
    const runtime = new MockRuntime([model("cheap", "one"), model("quality", "two")], [
      (request) => ({ status: "failed", role: request.role, model: request.model, summary: "tool 1", executionMetadata: { failureType: "tool_call_error" } }),
      (request) => ({ status: "failed", role: request.role, model: request.model, summary: "tool 2", executionMetadata: { failureType: "tool_call_error" } }),
      (request) => ({ status: "success", role: request.role, model: request.model, summary: "ok" }),
    ]);
    const service = new ExpertCouncilService(runtime, {
      profiles: { models: profiles },
      billing: { providers: {
        cheap: { billingType: "subscription", costMultiplier: 0.1 },
        quality: { billingType: "metered", costMultiplier: 1.0 },
      } },
      retry: { maxAttempts: 3, maxEscalations: 2, correctedRetriesPerModel: 1 },
    });
    const result = await service.delegate({ role: "implementation-worker", task: "Rename a local symbol", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(new Set(runtime.requests.map((request) => request.model)).size).toBe(2);
    expect(result.executionMetadata?.escalationCount).toBe(1);
  });

  it("warns and reroutes when a saved council plan drifts from the live model inventory", async () => {
    const models = [model("cheap", "one")];
    const runtime = new MockRuntime(models);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const plan = await service.buildCouncil({ task: "Rename a local symbol" });
    models.splice(0, models.length, model("quality", "two"));

    const result = await service.delegate({
      role: "implementation-worker",
      reasoningLevel: "medium",
      task: "Rename a local symbol",
      councilId: plan.id,
      timeoutMs: 60_000,
    });
    expect(result.model).toBe("quality/two");
    expect(result.risks?.join(" ")).toContain("routing refreshed");
    expect(result.risks?.join(" ")).toContain("no longer eligible");
  });

  it("terminates at the retry limit", async () => {
    const runtime = new MockRuntime([model("cheap", "one")], Array.from({ length: 5 }, () =>
      (request: Parameters<MockRuntime["executeExpert"]>[0]) => ({
        status: "failed" as const,
        role: request.role,
        model: request.model,
        summary: "still failing",
        executionMetadata: { failureType: "tool_call_error" as const },
      }),
    ));
    const service = new ExpertCouncilService(runtime, {
      profiles: { models: profiles },
      retry: { maxAttempts: 2, maxEscalations: 1, correctedRetriesPerModel: 1 },
    });
    const result = await service.delegate({ role: "implementation-worker", task: "Rename a local symbol", timeoutMs: 60_000 });
    expect(result.status).toBe("failed");
    expect(runtime.requests).toHaveLength(2);
  });

  it("makes a deterministic explicit escalation decision", () => {
    expect(decideEscalation({
      role: "debugger",
      task: "fix",
      currentModel: "p/a",
      previousFailures: [{ model: "p/a", type: "provider_error", summary: "outage" }],
    }, [{ model: "p/a", provider: "p", score: 8, reasons: [] }, { model: "q/b", provider: "q", score: 7, reasons: [] }])).toMatchObject({ action: "escalate", model: "q/b" });
    // missing_context is a task-level blocker: it must not be retried on the same model.
    expect(decideEscalation({
      role: "debugger",
      task: "fix",
      currentModel: "p/a",
      previousFailures: [{ model: "p/a", type: "missing_context", summary: "required file absent" }],
    }, [{ model: "p/a", provider: "p", score: 8, reasons: [] }, { model: "q/b", provider: "q", score: 7, reasons: [] }])).toMatchObject({ action: "escalate", model: "q/b" });
  });
});

describe("telemetry privacy and aggregation", () => {
  it("lets verified outcomes influence routing conservatively", () => {
    const base = {
      model: "one",
      provider: "cheap",
      role: "reviewer" as const,
      samples: 10,
      successRate: 0.8,
      firstPassSuccessRate: 0.7,
      toolErrorRate: 0.1,
      retryRate: 0.2,
      averageAttempts: 1.2,
    };
    expect(observedAdjustment([{ ...base, verificationPassRate: 1 }], "cheap/one", "reviewer", 1)).toBeGreaterThan(
      observedAdjustment([{ ...base, verificationPassRate: 0 }], "cheap/one", "reviewer", 1),
    );
  });

  it("records Main Agent verification without double-counting an execution", async () => {
    const telemetry = new MemoryTelemetryStore();
    const runtime = new MockRuntime([model("cheap", "one")], [(request) => ({
      status: "success",
      role: request.role,
      model: request.model,
      summary: "verified",
      executionMetadata: { usage: { inputTokens: 100, outputTokens: 20, estimatedCost: 0.01 } },
    })]);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } }, telemetry);
    const result = await service.delegate({ role: "reviewer", task: "Review a bounded change", timeoutMs: 60_000 });
    const executionId = result.executionMetadata!.executionId!;
    expect(await service.recordFeedback({ executionId, verificationPassed: true })).toEqual({
      executionId,
      status: "recorded",
      verificationPassed: true,
    });
    expect(await telemetry.aggregate()).toMatchObject([{ samples: 1, verificationPassRate: 1 }]);
    await service.recordFeedback({ executionId, verificationPassed: false });
    expect(await telemetry.aggregate()).toMatchObject([{ samples: 1, verificationPassRate: 0 }]);
    expect((await telemetry.list()).at(-1)?.approximateUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      estimatedCost: 0.01,
    });
  });

  it("restores plans and results and closes interrupted executions after restart", async () => {
    let snapshot: import("../packages/core/src/index.js").CouncilStateSnapshot | undefined;
    const persistence = {
      save: async (value: import("../packages/core/src/index.js").CouncilStateSnapshot) => {
        snapshot = structuredClone(value);
      },
    };
    const runtime = new MockRuntime([model("cheap", "one")]);
    const first = new ExpertCouncilService(runtime, { profiles: { models: profiles } }, undefined, { persistence });
    const plan = await first.buildCouncil({ task: "Rename a local symbol" });
    const completed = await first.delegate({ role: "implementation-worker", task: "Rename a local symbol", timeoutMs: 60_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(snapshot?.plans[0]?.id).toBe(plan.id);

    snapshot!.executions.push({
      id: "exec_interrupted",
      role: "reviewer",
      status: "running",
      attempts: 1,
      startedAt: new Date().toISOString(),
    });
    const restored = new ExpertCouncilService(runtime, { profiles: { models: profiles } }, undefined, {
      initialState: snapshot,
      persistence,
    });
    expect((await restored.getStatus()).plans[0]?.id).toBe(plan.id);
    expect((await restored.getResult(completed.executionMetadata!.executionId!)).status).toBe("completed");
    expect(await restored.getResult("exec_interrupted")).toMatchObject({
      status: "completed",
      result: { status: "failed", summary: expect.stringContaining("process restart") },
    });
  });

  it("stores only the explicit outcome allowlist", async () => {
    const withSecret = {
      timestamp: new Date().toISOString(),
      model: "m",
      provider: "p",
      role: "reviewer" as const,
      taskCategory: "normal" as const,
      success: true,
      firstPass: true,
      toolErrors: 0,
      retryCount: 0,
      timedOut: false,
      escalationCount: 0,
      attempts: 1,
      hostType: "mock",
      chainOfThought: "secret reasoning",
      prompt: "private source",
    };
    expect(JSON.stringify(sanitizeOutcome(withSecret))).not.toContain("secret");
    const store = new MemoryTelemetryStore();
    await store.record(withSecret);
    const aggregate = await store.aggregate();
    expect(aggregate[0]).toMatchObject({ samples: 1, successRate: 1, firstPassSuccessRate: 1 });
  });

  it("reports unavailable configured profiles without crashing", async () => {
    const runtime = new MockRuntime([model("p", "present")], [], capabilities);
    const service = new ExpertCouncilService(runtime, { profiles: { models: { "p/missing": { review: 9 } } } });
    expect((await service.inspectResources()).warnings[0]).toContain("p/missing");
  });
});

describe("Skill trust policy", () => {
  it("requires an explicit trusted provenance or configured allowlist", async () => {
    const untrustedRuntime = new MockRuntime(
      [model("cheap", "one")],
      [],
      capabilities,
      [{ name: "planning", installed: true, enabled: true }],
    );
    await new ExpertCouncilService(untrustedRuntime, { profiles: { models: profiles } })
      .delegate({ role: "planner", task: "Plan a bounded change", timeoutMs: 60_000 });
    expect(untrustedRuntime.requests[0]?.skills).toEqual([]);

    const allowlistedRuntime = new MockRuntime(
      [model("cheap", "one")],
      [],
      capabilities,
      [{ name: "planning", installed: true, enabled: true }],
    );
    await new ExpertCouncilService(allowlistedRuntime, {
      profiles: { models: profiles },
      security: { trustedSkills: ["planning"] },
    }).delegate({ role: "planner", task: "Plan a bounded change", timeoutMs: 60_000 });
    expect(allowlistedRuntime.requests[0]?.skills).toEqual(["planning"]);
  });
});

describe("runtime availability marking", () => {
  const assessment = {
    asOf: "2026-09-03T00:00:00.000Z",
    sources: ["https://livebench.ai/"],
    models: {
      "p/dead": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
      "p/alive": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
    },
  };
  const models = [model("p", "dead"), model("p", "alive")];

  function initialState(modelAssessment: ModelAssessmentSnapshot): CouncilStateSnapshot {
    return { version: 1, plans: [], executions: [], results: [], modelAssessment };
  }

  it("marks a dead model in the persisted assessment and tells the Main Agent", async () => {
    const runtime = new MockRuntime(models, [
      {
        status: "failed",
        role: "scout",
        model: "p/dead",
        summary: "Provider API returned model_not_found for p/dead.",
        executionMetadata: { failureType: "provider_error" },
      },
      { status: "success", role: "scout", model: "p/alive", summary: "ok" },
    ]);
    // Class-based persistence (like SplitCouncilStateStore): the service must
    // call updateModelAssessment through the object, never as an extracted
    // unbound function, or `this` is lost.
    class RecordingPersistence {
      markerUpdates = 0;
      saved: ModelAssessmentSnapshot = assessment;
      async save(): Promise<void> {}
      async updateModelAssessment(
        mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
      ): Promise<void> {
        const before = this.saved;
        const next = mutate(before);
        if (!next) return;
        if (Object.keys(next.modelAvailability ?? {}).length > Object.keys(before.modelAvailability ?? {}).length) {
          this.markerUpdates += 1;
        }
        this.saved = next;
      }
    }
    const persistence = new RecordingPersistence();
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: initialState(assessment),
      persistence,
    });

    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("p/alive");
    expect(result.executionMetadata?.unavailableModels).toEqual(["p/dead"]);
    expect(result.risks?.join(" ")).toContain("marked in the persisted model assessment");
    expect(persistence.markerUpdates).toBe(1);
    expect(persistence.saved.modelAvailability?.["p/dead"]).toMatchObject({ callable: false, source: "runtime-failure" });
    expect(persistence.saved.modelStatus?.["p/dead"]).toMatchObject({ state: "unavailable" });
    expect(persistence.saved.modelStatus?.["p/alive"]).toMatchObject({ state: "available" });

    const plan = await service.buildCouncil({ task: "Implement a small bounded feature" });
    expect(plan.experts.map((expert) => expert.model)).not.toContain("p/dead");
    const decision = await service.escalate({
      role: "scout",
      task: "Inspect a tiny file",
      currentModel: "p/dead",
      previousFailures: [{ model: "p/dead", type: "provider_error", summary: "model_not_found" }],
    });
    expect(decision.model).toBe("p/alive");
  });

  it("marks a transient rate limit on the short rate-limited window, not the provider-blackout window", async () => {
    const runtime = new MockRuntime(models, [
      {
        status: "failed",
        role: "scout",
        model: "p/dead",
        summary: "Provider returned 429 rate limit exceeded.",
        executionMetadata: { failureType: "provider_error" },
      },
      { status: "success", role: "scout", model: "p/alive", summary: "ok" },
    ]);
    let markerUpdates = 0;
    // Mirrors RecordingPersistence above: the snapshot currently on disk is the
    // seeded assessment, and every accepted mutation replaces it.
    let stored: ModelAssessmentSnapshot = assessment;
    // The service treats marker persistence as best-effort, so a throwing fixture
    // would be swallowed and quietly void every assertion below. Capture and fail.
    const stubErrors: unknown[] = [];
    const persistence = {
      save: async () => {},
      updateModelAssessment: async (
        mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
      ) => {
        try {
          const before = stored;
          const next = mutate(before);
          if (next) stored = next;
          if (next && Object.keys(next.modelAvailability ?? {}).length > Object.keys(before.modelAvailability ?? {}).length) {
            markerUpdates += 1;
          }
        } catch (error) {
          stubErrors.push(error);
        }
      },
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: initialState(assessment),
      persistence,
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });

    // The shipped contract: an account-level 429 is provider evidence, so the failed
    // model AND its siblings take a marker, and the delegation still escalates to the
    // sibling (a quota-exhausted marker would drop the provider and end after one call).
    expect(stubErrors).toEqual([]);
    expect(result.status).toBe("success");
    expect(runtime.requests.map((request) => request.model)).toEqual(["p/dead", "p/alive"]);
    expect(result.executionMetadata?.unavailableModels).toEqual(["p/dead", "p/alive"]);
    expect(markerUpdates).toBe(1);
    const marked = stored.modelAvailability?.["p/dead"];
    if (!marked) throw new Error("expected the rate-limited model to carry a marker");
    expect(marked).toMatchObject({ callable: false, kind: "rate-limited", source: "runtime-failure" });
    expect(stored.modelAvailability?.["p/alive"]).toMatchObject({ callable: false, kind: "rate-limited" });
    expect(stored.modelStatus?.["p/dead"]).toMatchObject({ state: "rate-limited" });
    // The distinction that matters: the marker expires on the throttling window, well
    // before the default blackout lifetime, so routing gets the model back.
    const observedAt = Date.parse(marked.observedAt);
    expect(MODEL_RATE_LIMIT_MARKER_TTL_MS).toBeLessThan(MODEL_AVAILABILITY_MARKER_TTL_MS);
    expect(Object.keys(activeModelAvailability(stored, new Date(observedAt + MODEL_RATE_LIMIT_MARKER_TTL_MS - 1_000))))
      .toEqual(["p/dead", "p/alive"]);
    expect(activeModelAvailability(stored, new Date(observedAt + MODEL_RATE_LIMIT_MARKER_TTL_MS + 1_000))).toEqual({});
    expect(Object.keys(activeModelAvailability(stored, new Date(observedAt + MODEL_AVAILABILITY_MARKER_TTL_MS - 1_000))))
      .toEqual([]);
  });

  it("keeps the delegation alive but records the swallowed failure", async () => {
    // The catch around marker persistence exists so a broken store can never abort a
    // delegation - that part is correct. What was wrong is that it was silent: defect #25
    // hid behind it, and an un-persisted marker means the next delegation repeats a
    // failure this one already learned about, which is the host's business.
    const runtime = new MockRuntime(models, [
      {
        status: "failed",
        role: "scout",
        model: "p/dead",
        summary: "Provider returned 429 rate limit exceeded.",
        executionMetadata: { failureType: "provider_error" },
      },
      { status: "success", role: "scout", model: "p/alive", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: initialState(assessment),
      persistence: {
        save: async () => {},
        updateModelAssessment: async () => {
          throw new Error("disk on fire");
        },
      },
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });

    expect(result.status).toBe("success");
    expect(result.executionMetadata?.persistenceErrors).toEqual([{ model: "p/dead", detail: "disk on fire" }]);
    const risks = (result.risks ?? []).join(" ");
    expect(risks).toContain("could not be persisted");
    expect(risks).toContain("p/dead");
  });

  it("warns about active markers during inspection and preserves them across a fresh audit", async () => {
    const marked = withModelAvailabilityMarker(assessment, "p/dead", "model_not_found", new Date().toISOString());
    const runtime = new MockRuntime(models);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: initialState(marked) });

    const inventory = await service.inspectResources();
    expect(inventory.warnings.join(" ")).toContain("marked unavailable by a runtime failure");

    await service.buildCouncil({
      task: "Implement a small bounded feature",
      modelAssessment: {
        asOf: "2026-09-03T08:00:00.000Z",
        sources: ["https://livebench.ai/"],
        models: {
          "p/dead": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
          "p/alive": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
        },
      },
    });
    expect((await service.inspectResources()).modelAssessment?.modelAvailability?.["p/dead"]).toMatchObject({
      callable: false,
    });
  });

  it("still reports unavailable models when no saved assessment exists to mark", async () => {
    const runtime = new MockRuntime(models, [
      {
        status: "failed",
        role: "scout",
        model: "p/dead",
        summary: "Provider API returned model_not_found for p/dead.",
        executionMetadata: { failureType: "provider_error" },
      },
      { status: "success", role: "scout", model: "p/alive", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {
      profiles: { models: {
        "p/dead": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
        "p/alive": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
      } },
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.executionMetadata?.unavailableModels).toEqual(["p/dead"]);
    expect((await service.inspectResources()).modelAssessment).toBeUndefined();
  });
});

const abortModels = [model("p", "dead"), model("p", "alive")];
const markAssessment: ModelAssessmentSnapshot = {
  asOf: "2026-09-01T00:00:00.000Z",
  sources: ["https://livebench.ai/"],
  models: {
    "p/dead": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
    "p/alive": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
  },
};
const abortInitialState = (snapshot: ModelAssessmentSnapshot): CouncilStateSnapshot => ({
  version: 1,
  plans: [],
  executions: [],
  results: [],
  modelAssessment: snapshot,
});

describe("Main-Agent abort", () => {
  it("marks a runtime-reported abort as aborted without retry or escalation", async () => {
    const runtime = new MockRuntime(abortModels, [
      {
        status: "aborted",
        role: "scout",
        model: "p/dead",
        summary: "Expert execution aborted by the Main Agent. Abort reason: wrong direction.",
        filesChanged: ["notes.md"],
        executionMetadata: { failureType: "aborted", attempts: 1 },
      },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("aborted");
    expect(runtime.requests.length).toBe(1);
    expect(result.executionMetadata?.failureType).toBe("aborted");
    expect(result.summary).toContain("aborted by the Main Agent");
    expect(result.filesChanged).toEqual(["notes.md"]);
  });

  it("stops the runtime session even when the execution already finished", async () => {
    // Regression: an already-terminal core state must not skip the runtime
    // abort, or a zombie expert session keeps leaking notifications.
    const runtime = new MockRuntime(abortModels, [
      { status: "success", role: "scout", model: "p/dead", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    const executionId = result.executionMetadata?.executionId;
    expect(executionId).toBeTruthy();
    const outcome = await service.abortExecution({ executionId: executionId!, reason: "late stop" });
    expect(outcome.status).toBe("already-finished");
    expect(runtime.abortCalls).toEqual([{ executionId: executionId!, reason: "late stop" }]);
  });

  it("aborts a running delegation, skips the next attempt, and returns a handoff progress snapshot", async () => {
    let attemptStarted = false;
    let abortRequested = false;
    let attempts = 0;
    const runtime = new MockRuntime(abortModels);
    runtime.executeExpert = async (request) => {
      attemptStarted = true;
      attempts += 1;
      while (!abortRequested) await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: "aborted",
        role: request.role,
        model: request.model,
        summary: "Expert execution aborted by the Main Agent. Abort reason: wrong direction.",
        executionMetadata: { failureType: "aborted" as const, attempts: request.attempt },
      };
    };
    runtime.abortExecution = async (request) => {
      abortRequested = true;
      return {
        executionId: request.executionId,
        status: "abort-requested" as const,
        progress: {
          executionId: request.executionId,
          status: "running" as const,
          role: "scout",
          reasoningLevel: "medium",
          model: "p/dead",
          startedAt: new Date().toISOString(),
          elapsedMs: 25,
          messageCount: 4,
          lastAssistantText: "Currently exploring roles.ts",
        },
      };
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    const handle = service.startDelegation({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    while (!attemptStarted) await new Promise((resolve) => setTimeout(resolve, 5));
    const outcome = await service.abortExecution({ executionId: handle.executionId, reason: "wrong direction" });
    expect(outcome.status).toBe("abort-requested");
    expect(outcome.progress?.lastAssistantText).toBe("Currently exploring roles.ts");
    const result = await handle.result;
    expect(result.status).toBe("aborted");
    expect(result.summary).toContain("Abort reason: wrong direction");
    expect(attempts).toBe(1);
  });

  it("shutdownAll persists terminal aborted results for running executions before returning", async () => {
    let release: ((result: ExpertResult) => void) | undefined;
    const gate = new Promise<ExpertResult>((resolve) => {
      release = resolve;
    });
    const runtime = new MockRuntime(abortModels);
    let attemptStarted = false;
    runtime.executeExpert = async (request) => {
      attemptStarted = true;
      return gate;
    };
    const saves: Array<CouncilStateSnapshot | undefined> = [];
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: abortInitialState(markAssessment),
      persistence: {
        save: async (snapshot) => {
          saves.push(snapshot);
        },
      },
    });
    const handle = service.startDelegation({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    while (!attemptStarted) await new Promise((resolve) => setTimeout(resolve, 5));
    const stopped = await service.shutdownAll!("Host session is shutting down.");
    expect(stopped).toBe(1);
    const lookup = await service.getResult(handle.executionId);
    expect(lookup.status).toBe("completed");
    expect(lookup.result).toMatchObject({
      status: "aborted",
      summary: "Expert execution aborted: Host session is shutting down.",
    });
    expect(lookup.result?.executionMetadata).toMatchObject({ failureType: "aborted", attempts: 1 });
    // The terminal state must be durably persisted before shutdownAll returns.
    const persisted = saves.at(-1);
    const persistedEntry = persisted?.executions.find((entry) => entry.id === handle.executionId);
    expect(persistedEntry?.status).toBe("aborted");
    expect(persisted?.results.some((entry) => entry.executionId === handle.executionId && entry.result.status === "aborted")).toBe(true);
    // The runtime session abort is still requested.
    expect(runtime.abortCalls).toEqual([{ executionId: handle.executionId, reason: "Host session is shutting down." }]);
    // Survival semantics: if the process actually survives (session replaced
    // but no quit), the real late result overwrites the shutdown placeholder.
    release!({ status: "success", role: "scout", model: "p/dead", summary: "actually finished" });
    const lateResult = await handle.result;
    expect(lateResult.status).toBe("success");
    const finalLookup = await service.getResult(handle.executionId);
    expect(finalLookup.result?.summary).toBe("actually finished");
  });

  it("reports not-found and already-finished abort outcomes", async () => {
    const runtime = new MockRuntime(abortModels, [
      { status: "success", role: "scout", model: "p/alive", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    expect((await service.abortExecution({ executionId: "exec_missing" })).status).toBe("not-found");
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect((await service.abortExecution({ executionId: result.executionMetadata!.executionId! })).status).toBe("already-finished");
  });
});

describe("quota-exhausted model status", () => {
  it("marks quota failures with the distinct kind and records current status", async () => {
    // abortModels are both provider "p": quota exhaustion is a provider-account
    // fact, so the sibling model is marked alongside the failing one and the
    // delegation has no candidates left instead of burning another attempt.
    const runtime = new MockRuntime(abortModels, [
      {
        status: "failed",
        role: "scout",
        model: "p/dead",
        summary: "403 AccessDenied: insufficient_quota - You exceeded your current quota.",
        executionMetadata: { failureType: "provider_error" },
      },
      { status: "success", role: "scout", model: "p/alive", summary: "ok" },
    ]);
    const saved = { ...markAssessment };
    const persistence = {
      save: async () => {},
      updateModelAssessment: async (
        mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
      ) => {
        const next = mutate(saved);
        if (next) Object.assign(saved, next);
      },
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: abortInitialState(markAssessment),
      persistence,
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("failed");
    expect(result.executionMetadata?.unavailableModels).toEqual(["p/dead", "p/alive"]);
    expect(runtime.requests).toHaveLength(1);
    expect(saved.modelAvailability?.["p/dead"]).toMatchObject({ callable: false, kind: "quota-exhausted" });
    expect(saved.modelAvailability?.["p/alive"]).toMatchObject({ callable: false, kind: "quota-exhausted" });
    expect(saved.modelStatus?.["p/dead"]).toMatchObject({ state: "quota-exhausted" });
    expect(saved.modelStatus?.["p/alive"]).toMatchObject({ state: "quota-exhausted" });
    const inventory = await service.inspectResources();
    expect(inventory.warnings.join(" ")).toContain("quota or balance ran out");
  });

  it("marks the whole provider on quota failure and escalates across providers", async () => {
    const assessment = {
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: {
        "q/one": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
        "q/two": { coding: 8.5, toolReliability: 8.5, autonomousExecution: 8.5, bashReliability: 8.5 },
        "r/one": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
      },
    };
    const models = [model("q", "one"), model("q", "two"), model("r", "one")];
    const runtime = new MockRuntime(models, [
      {
        status: "failed",
        role: "scout",
        model: "q/one",
        summary: "Insufficient balance: the token plan for this provider is depleted.",
        executionMetadata: { failureType: "provider_error" },
      },
      { status: "success", role: "scout", model: "r/one", summary: "ok" },
    ]);
    const saved: ModelAssessmentSnapshot = JSON.parse(JSON.stringify(assessment));
    const persistence = {
      save: async () => {},
      updateModelAssessment: async (
        mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
      ) => {
        const next = mutate(saved);
        if (next) Object.assign(saved, next);
      },
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: abortInitialState(assessment),
      persistence,
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("r/one");
    // The sibling q/two must never be attempted: quota marks prune the whole provider.
    expect(runtime.requests.map((request) => request.model)).toEqual(["q/one", "r/one"]);
    expect(result.executionMetadata?.unavailableModels).toEqual(["q/one", "q/two"]);
    expect(saved.modelAvailability?.["q/two"]).toMatchObject({ callable: false, kind: "quota-exhausted" });
    expect(saved.modelStatus?.["q/two"]).toMatchObject({ state: "quota-exhausted" });
    expect(saved.modelStatus?.["r/one"]).toMatchObject({ state: "available" });
  });
});

describe("file-driven session route policy", () => {
  const assessment = {
    asOf: "2026-09-03T00:00:00.000Z",
    sources: ["https://livebench.ai/"],
    models: {
      "q/one": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
      "r/one": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
      "r/two": { coding: 7, toolReliability: 7, autonomousExecution: 7, bashReliability: 7 },
    },
  };
  const models = [model("q", "one"), model("r", "one"), model("r", "two")];

  function policyService(
    runtime: MockRuntime,
    saved: ModelAssessmentSnapshot,
    readRoutePolicy?: CouncilStateOptions["readRoutePolicy"],
    routePolicyPath?: string,
  ) {
    return new ExpertCouncilService(runtime, {}, undefined, {
      initialState: abortInitialState(saved),
      persistence: {
        save: async () => {},
        updateModelAssessment: async () => {},
      },
      ...(readRoutePolicy ? { readRoutePolicy } : {}),
      ...(routePolicyPath ? { routePolicyPath } : {}),
    });
  }

  const systemDenyQ: RoutePolicyDocument = {
    version: 1,
    system: { deny: ["q"], updatedAt: "2026-09-03T00:00:00.000Z" },
  };

  it("applies the system-level deny from route-policy.json to builds and delegations", async () => {
    const runtime = new MockRuntime(models, [
      { status: "success", role: "scout", model: "r/one", summary: "ok" },
    ]);
    const service = policyService(runtime, JSON.parse(JSON.stringify(assessment)), async () => systemDenyQ, "C:/state/route-policy.json");

    const inventory = await service.inspectResources();
    expect(inventory.routePolicy).toMatchObject({
      sessionKey: "default",
      effective: { deny: ["q"] },
      sourcePath: "C:/state/route-policy.json",
    });

    const plan = await service.buildCouncil({ task: "Implement a small bounded feature", constraints: { costPolicy: "balanced" } });
    for (const expert of plan.experts) expect(expert.model).not.toContain("q/");

    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("r/one");
  });

  it("merges the session entry by narrowing: deny unions, allow intersects, system deny cannot be unlocked", async () => {
    const runtime = new MockRuntime(models, [
      { status: "success", role: "scout", model: "r/two", summary: "ok" },
    ]);
    const doc: RoutePolicyDocument = {
      version: 1,
      system: { allow: ["q/one", "r/one", "r/two"], deny: ["q"] },
      sessions: { "session-a": { allow: ["q/one", "r/two"], deny: ["r/one"] } },
    };
    const service = policyService(runtime, JSON.parse(JSON.stringify(assessment)), async () => doc);

    const inventory = await service.inspectResources({ sessionKey: "session-a" });
    // allow = intersection(system, session) = [q/one, r/two]; deny = union(q, r/one).
    // q/one survives in the effective allow list but loses to deny at routing time.
    expect(inventory.routePolicy.effective).toEqual({ allow: ["q/one", "r/two"], deny: ["q", "r/one"] });

    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", sessionKey: "session-a", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("r/two");

    // Another session key only sees the system policy (its allow list keeps
    // q/one, but routing-time deny wins).
    const other = await service.inspectResources({ sessionKey: "session-b" });
    expect(other.routePolicy.effective).toEqual({ allow: ["q/one", "r/one", "r/two"], deny: ["q"] });
    expect(other.routePolicy.session).toBeUndefined();
  });

  it("excludes every model only when the merged policy leaves nothing and reports it structurally", async () => {
    const runtime = new MockRuntime(models);
    const doc: RoutePolicyDocument = { version: 1, system: { deny: ["q", "r"] } };
    const service = policyService(runtime, JSON.parse(JSON.stringify(assessment)), async () => doc);

    const blocked = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(blocked.status).toBe("failed");
    expect(blocked.summary).toContain("route policy excludes every available model");
    expect(blocked.executionMetadata?.attempts).toBe(0);
    await expect(service.buildCouncil({ task: "Implement a small bounded feature" })).rejects.toThrow(/route policy/i);
  });

  it("ignores a corrupt route-policy file with a warning instead of blocking routing", async () => {
    const runtime = new MockRuntime(models, [
      { status: "success", role: "scout", model: "q/one", summary: "ok" },
    ]);
    const service = policyService(
      runtime,
      JSON.parse(JSON.stringify(assessment)),
      async () => {
        throw new Error("unexpected token");
      },
    );
    const inventory = await service.inspectResources();
    expect(inventory.routePolicy.effective).toEqual({});
    expect(inventory.warnings.join(" ")).toContain("Route policy file could not be loaded and was ignored");

    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("q/one");
  });
});

describe("quota-aware billing guidance", () => {
  it("warns when a subscription provider relies on one blanket provider-level class", async () => {
    const models = [
      model("sub", "one"), model("sub", "two"), model("sub", "three"), model("sub", "four"), model("sub", "five"),
      model("other", "one"),
    ];
    const billing: Record<string, BillingPolicyEntry> = { sub: { billingType: "subscription", costMultiplier: 0.1 } };
    const assessment: ModelAssessmentSnapshot = {
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: Object.fromEntries(models.map((entry) => [`${entry.provider}/${entry.id}`, { coding: 8 }])),
      billing,
    };
    const runtime = new MockRuntime(models);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(assessment) });
    const inventory = await service.inspectResources();
    expect(inventory.warnings.join(" ")).toContain("subscription-billed but has no per-model cost classes");

    // Adding a model-level entry silences the warning.
    billing["sub/one"] = { billingType: "subscription", costMultiplier: 0.5 };
    const refreshed = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(assessment) });
    const updated = await refreshed.inspectResources();
    expect(updated.warnings.join(" ")).not.toContain("subscription-billed but has no per-model cost classes");
  });
});

describe("council cost policy guidance", () => {
  it("reminds the host to establish one cost policy with the user when costPolicy is omitted", async () => {
    const runtime = new MockRuntime([model("p", "one")]);
    const service = new ExpertCouncilService(runtime, {});
    const plan = await service.buildCouncil({ task: "Implement a small bounded feature" });
    expect(plan.warnings.join(" ")).toContain("ask the user once whether to optimize for economy, balanced, or speed");

    const reminded = await service.buildCouncil({ task: "Implement another small bounded feature", constraints: { costPolicy: "balanced" } });
    expect(reminded.warnings.join(" ")).not.toContain("costPolicy");
  });

  it("evaluates mutation capability for the requested workspace, not the startup folder", async () => {
    const runtime = new MockRuntime([model("p", "one")]);
    const service = new ExpertCouncilService(runtime, {});
    await service.delegate({ role: "scout", task: "Inspect a tiny file", workspace: "C:/project/repo", timeoutMs: 60_000 });
    expect(runtime.capabilityRequests.at(-1)).toBe("C:/project/repo");
    await service.getStatus();
  });
});

describe("shared assessment freshness", () => {
  it("observes availability markers written by another service instance without a restart", async () => {
    const assessment = {
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: {
        "p/dead": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
        "p/alive": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
      },
    };
    const runtime = new MockRuntime([model("p", "dead"), model("p", "alive")]);
    class SharedPersistence {
      #stored: ModelAssessmentSnapshot | undefined = assessment;
      async save(): Promise<void> {}
      async updateModelAssessment(): Promise<void> {}
      async readModelAssessment(): Promise<ModelAssessmentSnapshot | undefined> {
        // Simulates another running Pi/Codex instance persisting a marker
        // after this service instance was constructed.
        this.#stored = withModelAvailabilityMarker(
          this.#stored!,
          "p/dead",
          "403: access to model denied",
          new Date().toISOString(),
        );
        return this.#stored;
      }
    }
    const persistence = new SharedPersistence();
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: { version: 1, plans: [], executions: [], results: [], modelAssessment: assessment },
      persistence,
    });

    const inventory = await service.inspectResources();
    expect(inventory.warnings.join(" ")).toContain("marked unavailable by a runtime failure");
    const plan = await service.buildCouncil({ task: "Implement a small bounded feature" });
    expect(plan.experts.map((expert) => expert.model)).not.toContain("p/dead");
  });
});

describe("required delegation timeouts", () => {
  it("rejects a delegation without an explicit timeoutMs", async () => {
    const runtime = new MockRuntime([model("p", "alive")], [
      { status: "success", role: "scout", model: "p/alive", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    await expect(service.delegate({ role: "scout", task: "Inspect a tiny file" } as never))
      .rejects.toThrow(/explicit timeout/i);
    expect(runtime.requests).toHaveLength(0);
  });

  it("scales the retry budget by 1.5x after a timed-out attempt", async () => {
    let attempts = 0;
    const runtime = new MockRuntime(abortModels);
    runtime.executeExpert = async (request) => {
      runtime.requests.push(request);
      attempts += 1;
      if (attempts === 1) {
        return {
          status: "failed",
          role: request.role,
          model: request.model,
          summary: `Expert execution timed out after ${request.timeoutMs}ms.`,
          executionMetadata: { failureType: "timeout", attempts: request.attempt },
        };
      }
      return { status: "success", role: request.role, model: request.model, summary: "ok" };
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 600_000 });
    expect(result.status).toBe("success");
    expect(runtime.requests[0]?.timeoutMs).toBe(600_000);
    // Attempt 2 gets 1.5x the explicit budget, proving the budget grows.
    expect(runtime.requests[1]?.timeoutMs).toBe(900_000);
  });

  it("terminates the loop when an expert stops itself via report_and_stop (partial + missing_context)", async () => {
    const runtime = new MockRuntime(abortModels, [
      {
        status: "partial",
        role: "scout",
        model: "p/dead",
        summary: "[Task stopped by expert] The worktree has no installed dependencies.",
        findings: ["src/entry.ts exports run()"],
        recommendedNextAction: "Dispatch with provisioning enabled.",
        executionMetadata: { failureType: "missing_context", stoppedByExpert: true },
      },
      { status: "success", role: "scout", model: "p/alive", summary: "must not run" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("partial");
    expect(result.executionMetadata).toMatchObject({ failureType: "missing_context", stoppedByExpert: true, attempts: 1, escalationCount: 0 });
    expect(result.recommendedNextAction).toBe("Dispatch with provisioning enabled.");
  });

  it("terminates the loop on a task-level blocker without retry or escalation", async () => {
    const runtime = new MockRuntime(abortModels, [
      {
        status: "failed",
        role: "scout",
        model: "p/dead",
        summary: "The required environment is absent from the isolated worktree.",
        executionMetadata: { failureType: "missing_context" },
      },
      { status: "success", role: "scout", model: "p/alive", summary: "must not run" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(markAssessment) });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("required environment is absent");
    expect(result.executionMetadata?.failureType).toBe("missing_context");
    expect(result.executionMetadata?.attempts).toBe(1);
    expect(result.executionMetadata?.escalationCount).toBe(0);
    expect(runtime.requests).toHaveLength(1);
  });
});

describe("429 quota exhaustion classification", () => {
  it("classifies plan-quota 429 failures as provider_error so the whole plan gets marked", async () => {
    const models = [model("plan", "one"), model("plan", "two"), model("r", "one")];
    const assessment = {
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: Object.fromEntries(models.map((entry) => [`${entry.provider}/${entry.id}`, { coding: 8 }])),
    };
    const results: ExpertResult[] = [
      {
        status: "failed",
        role: "scout",
        model: "plan/one",
        summary: '429: {"message":"Your token-plan 1-week quota has been exhausted.","type":"insufficient_quota"}',
        executionMetadata: { failureType: "unknown" },
      },
      { status: "success", role: "scout", model: "r/one", summary: "ok" },
    ];
    // The runtime mislabeled it "unknown"; inferFailureType must recover
    // provider evidence from the summary so the plan-wide marker still lands.
    const runtime = new MockRuntime(models, results.map((result) => ({
      ...result,
      executionMetadata: result.status === "success" ? result.executionMetadata : undefined,
    })));
    const saved: ModelAssessmentSnapshot = JSON.parse(JSON.stringify(assessment));
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: abortInitialState(assessment),
      persistence: {
        save: async () => {},
        updateModelAssessment: async (
          mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
        ) => {
          const next = mutate(saved);
          if (next) Object.assign(saved, next);
        },
      },
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("r/one");
    expect(saved.modelAvailability?.["plan/one"]).toMatchObject({ callable: false, kind: "quota-exhausted" });
    expect(saved.modelAvailability?.["plan/two"]).toMatchObject({ callable: false, kind: "quota-exhausted" });
    expect(saved.modelStatus?.["plan/two"]).toMatchObject({ state: "quota-exhausted" });
  });
});

describe("persistent council compositions", () => {
  const compositionAssessment = {
    asOf: "2026-09-03T00:00:00.000Z",
    sources: ["https://livebench.ai/"],
    models: {
      "cheap/one": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
      "cheap/two": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
      "strong/one": { coding: 9.5, toolReliability: 9.5, autonomousExecution: 9.5, bashReliability: 9.5 },
    },
  };
  const compositionModels = [model("cheap", "one"), model("cheap", "two"), model("strong", "one")];
  const document: CompositionDocument = {
    version: 1,
    compositions: [
      { name: "daily-cheap", roles: { scout: [{ model: "cheap/one" }, { model: "cheap/two" }], "implementation-worker": [{ model: "strong/one" }] } },
      { name: "only-cheap", roles: { "implementation-worker": [{ model: "cheap/one" }], verifier: [{ model: "strong/one" }] } },
    ],
  };
  const boundDocument: CompositionDocument = {
    ...document,
    sessions: { default: { name: "daily-cheap" } },
  };

  function compositionService(
    runtime: MockRuntime,
    options: {
      compositions?: CompositionDocument;
      readRoutePolicy?: CouncilStateOptions["readRoutePolicy"];
      store?: CouncilStateOptions["compositionsStore"];
    } = {},
  ) {
    return new ExpertCouncilService(runtime, {}, undefined, {
      initialState: abortInitialState(compositionAssessment),
      persistence: { save: async () => {}, updateModelAssessment: async () => {} },
      ...(options.compositions ? { readCompositions: async () => options.compositions } : {}),
      ...(options.readRoutePolicy ? { readRoutePolicy: options.readRoutePolicy } : {}),
      ...(options.store ? { compositionsStore: options.store } : {}),
    });
  }

  it("offers a bounded composition menu when neither composition nor costPolicy is supplied", async () => {
    const plan = await compositionService(new MockRuntime(compositionModels), { compositions: document })
      .buildCouncil({ task: "Implement a small bounded feature", constraints: { maxExperts: 1 } });
    expect(plan.compositionMenu).toEqual([
      { name: "daily-cheap", rolesSummary: { scout: 2, "implementation-worker": 1 } },
      { name: "only-cheap", rolesSummary: { "implementation-worker": 1, verifier: 1 } },
      { name: "auto", description: "create a session composition via costPolicy (economy/balanced/speed)" },
    ]);
    expect(plan.warnings.join(" ")).not.toContain("No costPolicy was supplied");
  });

  it("keeps the cost-policy reminder when the compositions feature is unwired", async () => {
    const plan = await new ExpertCouncilService(new MockRuntime(compositionModels), {})
      .buildCouncil({ task: "Implement a small bounded feature", constraints: { maxExperts: 1 } });
    expect(plan.compositionMenu).toBeUndefined();
    expect(plan.warnings.join(" ")).toContain("No costPolicy was supplied");
  });

  it("restricts an explicit composition's candidate selection to its pool", async () => {
    const plan = await compositionService(new MockRuntime(compositionModels), { compositions: document })
      .buildCouncil({
        task: "Implement a small bounded feature",
        composition: "daily-cheap",
        constraints: { maxExperts: 1 },
      });
    expect(plan.composition).toBe("daily-cheap");
    expect(plan.experts.map((expert) => expert.role)).toEqual(["implementation-worker"]);
    expect(plan.experts[0]?.model).toBe("strong/one");
    expect(plan.compositionMenu).toBeUndefined();
  });

  it("fails an unknown composition with the available names", async () => {
    await expect(compositionService(new MockRuntime(compositionModels), { compositions: document })
      .buildCouncil({ task: "Implement a small bounded feature", composition: "nope" }))
      .rejects.toThrow(/Unknown council composition "nope".*daily-cheap/s);
  });

  it("lets route-policy deny beat the composition pool and reports the unstaffable role", async () => {
    const service = compositionService(new MockRuntime(compositionModels), {
      compositions: document,
      readRoutePolicy: async () => ({ version: 1, system: { deny: ["cheap"] } }),
    });
    const plan = await service.buildCouncil({
      task: "Implement a small bounded feature",
      composition: "only-cheap",
      constraints: { maxExperts: 2 },
    });
    expect(plan.experts.map((expert) => expert.role)).toEqual(["verifier"]);
    expect(plan.warnings.join(" ")).toContain("restricts implementation-worker");
    expect(plan.warnings.join(" ")).toContain("unstaffable");
  });

  it("reports a fully excluded composition as unstaffable", async () => {
    const service = compositionService(new MockRuntime(compositionModels), {
      compositions: { version: 1, compositions: [{ name: "cheap-only", roles: { "implementation-worker": [{ model: "cheap/one" }] } }] },
      readRoutePolicy: async () => ({ version: 1, system: { deny: ["cheap"] } }),
    });
    await expect(service.buildCouncil({
      task: "Implement a small bounded feature",
      composition: "cheap-only",
      constraints: { maxExperts: 1 },
    })).rejects.toThrow(/cannot staff any role/);
  });

  it("pins a delegation to a model inside the session composition pool", async () => {
    const runtime = new MockRuntime(compositionModels, [
      { status: "success", role: "scout", model: "cheap/two", summary: "ok" },
    ]);
    const result = await compositionService(runtime, { compositions: boundDocument }).delegate({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect a tiny file",
      timeoutMs: 60_000,
      model: "cheap/two",
    });
    expect(result.status).toBe("success");
    expect(runtime.requests.map((request) => request.model)).toEqual(["cheap/two"]);
  });

  it("rejects a pinned model outside the composition pool with a structured error", async () => {
    const runtime = new MockRuntime(compositionModels);
    const result = await compositionService(runtime, { compositions: boundDocument }).delegate({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect a tiny file",
      timeoutMs: 60_000,
      model: "strong/one",
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not in the composition pool");
    expect(result.summary).toContain("cheap/one");
    expect(result.executionMetadata?.failureType).toBe("permission_error");
    expect(runtime.requests).toHaveLength(0);
  });

  it("rejects a pinned model absent from the discovered inventory", async () => {
    const runtime = new MockRuntime(compositionModels);
    const result = await compositionService(runtime, { compositions: boundDocument }).delegate({
      role: "scout",
      reasoningLevel: "medium",
      task: "Inspect a tiny file",
      timeoutMs: 60_000,
      model: "ghost/model",
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not in the discovered model inventory");
    expect(runtime.requests).toHaveLength(0);
  });

  it("binds an explicit composition build and unbinds on an explicit costPolicy build", async () => {
    const binds: string[] = [];
    const unbinds: string[] = [];
    const store: CouncilStateOptions["compositionsStore"] = {
      bind: async (_sessionKey, name) => { binds.push(name); },
      unbind: async () => { unbinds.push("default"); },
    };
    const service = compositionService(new MockRuntime(compositionModels), { compositions: boundDocument, store });

    await service.buildCouncil({
      task: "Implement a small bounded feature",
      composition: "daily-cheap",
      constraints: { maxExperts: 1 },
    });
    expect(binds).toEqual(["daily-cheap"]);

    const auto = await service.buildCouncil({
      task: "Implement a small bounded feature",
      constraints: { costPolicy: "balanced", maxExperts: 1 },
    });
    expect(unbinds).toEqual(["default"]);
    // An explicit cost policy wins over a stale session binding: no pool restriction.
    expect(auto.composition).toBeUndefined();
    expect(auto.compositionMenu).toBeUndefined();
  });
});

describe("provider usage ledger and caps", () => {
  it("records weighted non-cache tokens times the attempt model's costMultiplier", async () => {
    const recorded: Array<{ provider: string; tokens: number }> = [];
    const runtime = new MockRuntime([model("p", "one")], [{
      status: "success",
      role: "scout",
      model: "p/one",
      summary: "ok",
      executionMetadata: {
        usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 9_000, cacheWriteTokens: 1_000 },
      },
    }]);
    const service = new ExpertCouncilService(runtime, {
      billing: { providers: { p: { billingType: "metered", costMultiplier: 2.0 } } },
    }, undefined, {
      usageLedger: {
        load: async () => instantiateLedger(),
        record: async (provider, tokens, now) => {
          recorded.push({ provider, tokens });
          return applyUsage(instantiateLedger(), provider, tokens, now);
        },
      },
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(recorded).toEqual([{ provider: "p", tokens: 3_000 }]);
  });

  it("excludes a pre-breached provider's candidates and reports the reason", async () => {
    const now = new Date();
    const ledger = applyUsage(instantiateLedger(), "breached", 100, now);
    const runtime = new MockRuntime([model("breached", "one"), model("ok", "one")], [
      { status: "success", role: "scout", model: "ok/one", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      usageLedger: { load: async () => ledger, record: async (_provider, _tokens, _now) => ledger },
      readProviderLimits: async () => ({ providers: {
        breached: { dailyTokenCap: 100, weeklyTokenCap: 1_000 },
        ok: { dailyTokenCap: 100, weeklyTokenCap: 1_000 },
      } }),
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("ok/one");
    expect(runtime.requests.map((request) => request.model)).toEqual(["ok/one"]);
    expect(result.risks?.join(" ")).toContain("daily token cap reached");
  });

  it("excludes a provider whose maxConcurrency is saturated by a running execution", async () => {
    const blocked = new Promise<never>(() => {});
    const runtime = new MockRuntime([model("busy", "one"), model("free", "one")], [
      blocked,
      { status: "success", role: "scout", model: "free/one", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      usageLedger: {
        load: async () => instantiateLedger(),
        record: async (provider, tokens, now) => applyUsage(instantiateLedger(), provider, tokens, now),
      },
      readProviderLimits: async () => ({ providers: { busy: { maxConcurrency: 1 }, free: { maxConcurrency: 1 } } }),
    });
    const first = service.startDelegation({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    for (let index = 0; index < 200 && runtime.requests.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.requests[0]?.model).toBe("busy/one");
    const second = await service.delegate({ role: "scout", task: "Inspect another tiny file", timeoutMs: 60_000 });
    expect(second.status).toBe("success");
    expect(second.model).toBe("free/one");
    expect(second.risks?.join(" ")).toContain("concurrency limit reached");
    await service.abortExecution({ executionId: first.executionId, reason: "test cleanup" });
    first.result.catch(() => undefined);
  });

  it("marks a provider on cap breach with the UTC reset as an explicit expiry", async () => {
    const runtime = new MockRuntime([model("p", "one"), model("q", "one")], [{
      status: "success",
      role: "scout",
      model: "p/one",
      summary: "ok",
      executionMetadata: { usage: { inputTokens: 100, outputTokens: 0 } },
    }]);
    let ledger = instantiateLedger();
    const saved: ModelAssessmentSnapshot = {
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/one": { coding: 8 }, "q/one": { coding: 8 } },
    };
    const persistence = {
      save: async () => {},
      updateModelAssessment: async (
        mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
      ) => {
        const next = mutate(saved);
        if (next) Object.assign(saved, next);
      },
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: { version: 1, plans: [], executions: [], results: [], modelAssessment: saved },
      persistence,
      usageLedger: {
        load: async () => ledger,
        record: async (provider, tokens, now) => {
          ledger = applyUsage(ledger, provider, tokens, now);
          return ledger;
        },
      },
      readProviderLimits: async () => ({ providers: {
        p: { dailyTokenCap: 50, weeklyTokenCap: 1_000 },
        q: { dailyTokenCap: 50, weeklyTokenCap: 1_000 },
      } }),
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(saved.modelAvailability?.["p/one"]).toMatchObject({ callable: false, kind: "quota-exhausted" });
    expect(saved.modelAvailability?.["p/one"]?.expiresAt).toBeDefined();
    expect(result.risks?.join(" ")).toContain("weighted token cap reached");
  });
});

describe("worktree verification gate", () => {
  it("downgrades a verified success to partial and feeds the correction into the retry", async () => {
    const models = [model("p", "one")];
    const gated = applyVerificationGate({
      status: "success",
      role: "implementation-worker",
      model: "p/one",
      summary: "implemented the change",
      executionMetadata: {
        provisioning: { status: "ready", packageManager: "npm" },
        verification: [{ command: "npm test", status: "failed", summary: "exit code 1: 1 test failed" }],
      },
    });
    expect(gated.status).toBe("partial");
    expect(gated.executionMetadata?.failureType).toBe("test_failure");
    const runtime = new MockRuntime(models, [
      gated,
      (request) => ({ status: "success", role: request.role, model: request.model, summary: "fixed the failing test" }),
    ]);
    const service = new ExpertCouncilService(runtime, {
      profiles: { models: { "p/one": { toolReliability: 8, coding: 8, bashReliability: 8, autonomousExecution: 8 } } },
      retry: { correctedRetriesPerModel: 1 },
    });
    const result = await service.delegate({ role: "implementation-worker", task: "Implement a bounded change", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]?.priorFailure?.type).toBe("test_failure");
    expect(runtime.requests[1]?.priorFailure?.summary).toContain("Diagnose that cause, change the approach");
  });
});

describe("resetAvailability", () => {
  const seed = (): ModelAssessmentSnapshot => ({
    asOf: "2026-09-01T00:00:00.000Z",
    sources: ["https://livebench.ai/"],
    models: { "p/a": { coding: 8 }, "p/b": { coding: 8 }, "q/c": { coding: 8 } },
    modelAvailability: {
      "p/a": { callable: false, kind: "unavailable", observedAt: "2026-09-01T00:00:00.000Z", reason: "gone", source: "runtime-failure" },
      "p/b": { callable: false, kind: "quota-exhausted", observedAt: "2026-09-01T00:00:00.000Z", reason: "out", source: "runtime-failure" },
      "q/c": { callable: false, kind: "unavailable", observedAt: "2026-09-01T00:00:00.000Z", reason: "gone", source: "runtime-failure" },
    },
    modelStatus: {
      "p/a": { state: "unavailable", observedAt: "2026-09-01T00:00:00.000Z" },
      "p/b": { state: "quota-exhausted", observedAt: "2026-09-01T00:00:00.000Z" },
      "q/c": { state: "unavailable", observedAt: "2026-09-01T00:00:00.000Z" },
    },
  });
  const build = () => {
    let persisted = seed();
    const runtime = new MockRuntime([model("p", "a"), model("p", "b"), model("q", "c")]);
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: { version: 1, plans: [], executions: [], results: [], modelAssessment: seed() },
      persistence: {
        save: async () => {},
        updateModelAssessment: async (mutate) => {
          const next = mutate(persisted);
          if (next) persisted = next;
        },
      },
    });
    return { service, getPersisted: () => persisted };
  };
  it("clears an exact provider/id scope", async () => {
    const { service } = build();
    expect((await service.resetAvailability({ scope: "p/a" })).cleared).toEqual(["p/a"]);
  });
  it("clears a bare provider scope across its models", async () => {
    const { service } = build();
    expect((await service.resetAvailability({ scope: "p" })).cleared).toEqual(["p/a", "p/b"]);
  });
  it("clears every marker for '*' and persists the removal", async () => {
    const { service, getPersisted } = build();
    expect((await service.resetAvailability({ scope: "*" })).cleared).toEqual(["p/a", "p/b", "q/c"]);
    expect(getPersisted().modelAvailability).toBeUndefined();
    expect(getPersisted().modelStatus).toBeUndefined();
    expect((await service.getStatus()).modelAssessment?.modelAvailability).toBeUndefined();
  });
});

describe("status views", () => {
  it("full view keeps the legacy payload while summary and running are bounded", async () => {
    const runtime = new MockRuntime([model("p", "one")], [{ status: "success", role: "scout", model: "p/one", summary: "ok" }]);
    const service = new ExpertCouncilService(runtime, {});
    await service.delegate({ role: "scout", task: "x", timeoutMs: 60_000, reasoningLevel: "low" });
    const full = await service.getStatus();
    expect(Array.isArray(full.executions)).toBe(true);
    const summary = await service.getStatus({ view: "summary" });
    expect(summary.recentCompleted.some((e) => e.status === "success" && e.model === "p/one")).toBe(true);
    const running = await service.getStatus({ view: "running" });
    expect(running.running).toEqual([]);
  });
  it("reports elapsedMs and remainingMs for a running execution", async () => {
    const blocked = new Promise<never>(() => {});
    const runtime = new MockRuntime([model("p", "one")], [blocked]);
    const service = new ExpertCouncilService(runtime, {});
    const handle = service.startDelegation({ role: "scout", task: "x", timeoutMs: 60_000, reasoningLevel: "low" });
    for (let i = 0; i < 200 && runtime.requests.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    const entry = (await service.getStatus({ view: "summary" })).running.find((e) => e.id === handle.executionId);
    expect(entry?.remainingMs).toBeTypeOf("number");
    expect(entry?.elapsedMs).toBeTypeOf("number");
    await service.abortExecution({ executionId: handle.executionId, reason: "cleanup" });
    handle.result.catch(() => {});
  });
  it("concurrency exclusion reason reports remaining slots", async () => {
    const blocked = new Promise<never>(() => {});
    const runtime = new MockRuntime([model("busy", "one"), model("free", "one")], [
      blocked,
      { status: "success", role: "scout", model: "free/one", summary: "ok" },
    ]);
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      usageLedger: { load: async () => instantiateLedger(), record: async (p, t, n) => applyUsage(instantiateLedger(), p, t, n) },
      readProviderLimits: async () => ({ providers: { busy: { maxConcurrency: 1 }, free: { maxConcurrency: 1 } } }),
    });
    const first = service.startDelegation({ role: "scout", task: "x", timeoutMs: 60_000, reasoningLevel: "low" });
    for (let i = 0; i < 200 && runtime.requests.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    const second = await service.delegate({ role: "scout", task: "y", timeoutMs: 60_000, reasoningLevel: "low" });
    expect(second.risks?.join(" ")).toContain("remaining=0");
    await service.abortExecution({ executionId: first.executionId, reason: "cleanup" });
    first.result.catch(() => {});
  });
});

describe("routing-drift note", () => {
  it("stays silent when the inventory changed but the same model is still selected", async () => {
    const models = [model("cheap", "one")];
    const runtime = new MockRuntime(models);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const plan = await service.buildCouncil({ task: "Rename a local symbol" });
    expect(plan.experts.find((e) => e.role === "implementation-worker")?.model).toBe("cheap/one");
    // Add a weaker model: the fingerprint changes but cheap/one remains the selection.
    models.push(model("weak", "three"));
    const result = await service.delegate({
      role: "implementation-worker", reasoningLevel: "medium", task: "Rename a local symbol", councilId: plan.id, timeoutMs: 60_000,
    });
    expect(result.model).toBe("cheap/one");
    expect((result.risks ?? []).join(" ")).not.toContain("routing refreshed");
  });
});

describe("delegation forensics: attempt history, aggregate ceiling, attention visibility", () => {
  const failedAttempt = (attempt: number, summary: string) => ({
    status: "failed" as const,
    role: "reviewer" as const,
    model: "cheap/one",
    summary,
    executionMetadata: { failureType: "test_failure" as const, attempts: attempt, toolCalls: 6, toolErrors: 5 },
  });

  it("surfaces a bounded per-attempt history so the host never has to read a state file", async () => {
    // Two candidates are needed to reach three attempts: `retry.correctedRetriesPerModel`
    // caps a single model at one corrected retry, so the third attempt escalates.
    const runtime = new MockRuntime([model("cheap", "one"), model("quality", "two")], [
      failedAttempt(1, `x`.repeat(900)),
      failedAttempt(2, "second attempt summary"),
      failedAttempt(3, "third attempt summary"),
    ]);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles }, retry: { maxAttempts: 3 } });
    const result = await service.startDelegation({ role: "reviewer", task: "Review it", timeoutMs: 60_000 }).result;
    const history = result.executionMetadata?.attemptHistory;
    expect(history?.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(history?.[0]?.failureType).toBe("test_failure");
    expect(history?.[0]?.durationMs).toBeTypeOf("number");
    expect((history?.[0]?.summary ?? "").length).toBeLessThanOrEqual(300);
    expect(history?.[2]?.summary).toBe("third attempt summary");
  });

  it("stops retrying once the aggregate wall-clock ceiling is reached", async () => {
    let calls = 0;
    const runtime = new MockRuntime([model("cheap", "one"), model("quality", "two")], [
      async () => { calls += 1; await new Promise((r) => setTimeout(r, 600)); return failedAttempt(calls, "gate failed"); },
      async () => { calls += 1; await new Promise((r) => setTimeout(r, 600)); return failedAttempt(calls, "gate failed"); },
      async () => { calls += 1; await new Promise((r) => setTimeout(r, 600)); return failedAttempt(calls, "gate failed"); },
    ]);
    const service = new ExpertCouncilService(runtime, {
      profiles: { models: profiles },
      security: { guardrails: { maxTotalWallMs: 1_000 } },
      retry: { maxAttempts: 3 },
    });
    const result = await service.startDelegation({ role: "reviewer", task: "Review it", timeoutMs: 60_000 }).result;
    // The ceiling is checked before each further attempt, so the third one never runs.
    expect(calls).toBe(2);
    expect((result.risks ?? []).some((risk) => risk.includes("aggregate ceiling"))).toBe(true);
  });

  it("keeps struggle warnings visible to the host even when the progress window is off", async () => {
    const pending = failedAttempt(1, "ok");
    const runtime = new MockRuntime([model("cheap", "one")], [
      async () => { await new Promise((r) => setTimeout(r, 400)); return pending; },
    ]);
    runtime.inspectExecution = async (executionId: string) => ({
      executionId, status: "running", role: "reviewer", model: "cheap/one", startedAt: new Date().toISOString(),
      elapsedMs: 1000, messageCount: 3,
      lastAssistantText: "still working",
      toolCalls: 9, toolErrors: 6, budgetFractionUsed: 0.7,
      attention: [{ code: "consecutive_tool_failures", at: new Date().toISOString(), detail: "3 consecutive tool calls failed.", toolCalls: 9, toolErrors: 6 }],
    });
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const handle = service.startDelegation({ role: "reviewer", task: "Review a bounded change", timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 10));
    // The full view lists running ids only; the enriched per-execution detail lives in
    // the dedicated running view.
    const status = await service.getStatus({ view: "running" });
    const running = status.running[0] as unknown as Record<string, unknown> | undefined;
    expect(running?.attention).toBeDefined();
    // Tool counters and budget usage are progress, so the off-switch keeps them out.
    expect(running?.progress).toBeUndefined();
    await handle.result;
  });
});

describe("delegation lifetime is reported to observers", () => {
  it("tells the runtime once when a delegation ends, even after a retry", async () => {
    const runtime = new MockRuntime([model("cheap", "one"), model("quality", "two")], [
      {
        status: "failed", role: "reviewer", model: "cheap/one", summary: "gate failed",
        executionMetadata: { failureType: "test_failure" },
      },
      { status: "success", role: "reviewer", model: "quality/two", summary: "reviewed" },
    ]);
    const finalized: string[] = [];
    (runtime as unknown as { finalizeDelegation?: (id: string, role: string) => Promise<void> }).finalizeDelegation =
      async (executionId: string) => { finalized.push(executionId); };
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles }, retry: { maxAttempts: 3 } });
    const result = await service.startDelegation({ role: "reviewer", task: "Review a bounded change", timeoutMs: 60_000 }).result;
    expect(result.status).toBe("success");
    // One marker for the delegation, not one per attempt: that is the whole point of it.
    expect(finalized).toEqual([result.executionMetadata?.executionId]);
  });

  it("never lets an observability failure change a delegation's outcome", async () => {
    const runtime = new MockRuntime([model("cheap", "one")], [
      { status: "success", role: "reviewer", model: "cheap/one", summary: "reviewed" },
    ]);
    (runtime as unknown as { finalizeDelegation?: (id: string, role: string) => Promise<void> }).finalizeDelegation =
      async () => { throw new Error("stream on fire"); };
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const result = await service.startDelegation({ role: "reviewer", task: "Review a bounded change", timeoutMs: 60_000 }).result;
    expect(result.status).toBe("success");
    expect(result.summary).toBe("reviewed");
  });
});

describe("cross-attempt evidence survives a successful retry", () => {
  it("keeps a struggling first attempt visible, and reports delegation totals", async () => {
    const runtime = new MockRuntime([model("cheap", "one"), model("quality", "two")], [
      {
        status: "failed",
        role: "reviewer",
        model: "cheap/one",
        summary: "gate failed",
        executionMetadata: {
          failureType: "test_failure" as const,
          toolCalls: 6,
          toolErrors: 5,
          attention: [{
            code: "consecutive_tool_failures" as const,
            at: "2026-09-16T00:00:00.000Z",
            detail: "3 consecutive tool calls failed (5 of 6 observed).",
            toolCalls: 6,
            toolErrors: 5,
            nudgedExpert: true,
          }],
        },
      },
      {
        status: "success",
        role: "reviewer",
        model: "quality/two",
        summary: "reviewed cleanly",
        executionMetadata: { toolCalls: 2, toolErrors: 0 },
      },
    ]);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles }, retry: { maxAttempts: 3 } });
    const result = await service.startDelegation({ role: "reviewer", task: "Review a bounded change", timeoutMs: 60_000 }).result;

    expect(result.status).toBe("success");
    // Defect #20: these came from the runtime, which only ever reports its own last
    // attempt, so a clean retry erased the struggle - and telemetry mixed an accumulated
    // toolErrors with a single-attempt toolCalls.
    expect(result.executionMetadata?.toolCalls).toBe(8);
    expect(result.executionMetadata?.toolErrors).toBe(5);
    expect(result.executionMetadata?.attention?.map((item) => item.code)).toEqual(["consecutive_tool_failures"]);
    expect(result.executionMetadata?.attention?.[0]?.nudgedExpert).toBe(true);
  });

  it("does not invent totals for a single-attempt run", async () => {
    const runtime = new MockRuntime([model("cheap", "one")], [
      { status: "success", role: "reviewer", model: "cheap/one", summary: "reviewed" },
    ]);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const result = await service.startDelegation({ role: "reviewer", task: "Review a bounded change", timeoutMs: 60_000 }).result;
    expect(result.executionMetadata?.toolCalls).toBeUndefined();
    expect(result.executionMetadata?.attention).toBeUndefined();
  });
});
