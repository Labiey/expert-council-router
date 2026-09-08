import { describe, expect, it, vi } from "vitest";
import {
  decideEscalation,
  evaluateModelAssessment,
  ExpertCouncilService,
  failureTypeForResult,
  inferFailureType,
  MemoryTelemetryStore,
  observedAdjustment,
  resolveModelAssessment,
  sanitizeOutcome,
  withModelAvailabilityMarker,
} from "../packages/core/src/index.js";
import type { CouncilStateOptions, CouncilStateSnapshot, ModelAssessmentSnapshot, RoutePolicyDocument } from "../packages/core/src/index.js";
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
        cheap: { billingType: "subscription", marginalCostClass: "very-low" },
        quality: { billingType: "metered", marginalCostClass: "normal" },
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
      task: "Rename a local symbol",
      councilId: plan.id,
      timeoutMs: 60_000,
    });
    expect(result.model).toBe("quality/two");
    expect(result.risks?.join(" ")).toContain("different model inventory");
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

  it("does not mark transient provider failures such as rate limits", async () => {
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
    const persistence = {
      save: async () => {},
      updateModelAssessment: async (
        mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
      ) => {
        const before = current;
        const next = mutate(before);
        if (next && Object.keys(next.modelAvailability ?? {}).length > Object.keys(before?.modelAvailability ?? {}).length) {
          markerUpdates += 1;
        }
      },
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: initialState(assessment),
      persistence,
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.executionMetadata?.unavailableModels).toBeUndefined();
    expect(markerUpdates).toBe(0);
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
const markAssessment = {
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
    const assessment = {
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: Object.fromEntries(models.map((entry) => [`${entry.provider}/${entry.id}`, { coding: 8 }])),
      billing: { sub: { billingType: "subscription", marginalCostClass: "very-low", usagePreference: "consume-first" } },
    };
    const runtime = new MockRuntime(models);
    const service = new ExpertCouncilService(runtime, {}, undefined, { initialState: abortInitialState(assessment) });
    const inventory = await service.inspectResources();
    expect(inventory.warnings.join(" ")).toContain("subscription-billed but has no per-model cost classes");

    // Adding a model-level entry silences the warning.
    assessment.billing["sub/one"] = { billingType: "subscription", marginalCostClass: "low", usagePreference: "consume-first" };
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
    const results = [
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
