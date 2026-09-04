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
import type { CouncilStateSnapshot, ModelAssessmentSnapshot } from "../packages/core/src/index.js";
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

    const handle = service.startDelegation({ role: "reviewer", task: "Review a bounded change" });
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
    const first = service.startDelegation({ role: "reviewer", task: "Review module A" });
    const second = service.startDelegation({ role: "reviewer", task: "Review module B" });

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
      const handle = service.startDelegation({ role: "reviewer", task: "Review a long-running change" });
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
    const result = await service.delegate({ role: "implementation-worker", task: "Rename a local symbol" });
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
    const result = await service.delegate({ role: "implementation-worker", task: "Rename a local symbol" });
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
    const result = await service.delegate({ role: "implementation-worker", task: "Rename a local symbol" });
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
    const result = await service.delegate({ role: "reviewer", task: "Review a bounded change" });
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
    const completed = await first.delegate({ role: "implementation-worker", task: "Rename a local symbol" });
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
      .delegate({ role: "planner", task: "Plan a bounded change" });
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
    }).delegate({ role: "planner", task: "Plan a bounded change" });
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
    let updates: Array<string | undefined>;
    // Class-based persistence (like SplitCouncilStateStore): the service must
    // call updateModelAssessment through the object, never as an extracted
    // unbound function, or `this` is lost.
    class RecordingPersistence {
      updates: Array<string | undefined> = [];
      saved: ModelAssessmentSnapshot = assessment;
      async save(): Promise<void> {}
      async updateModelAssessment(
        mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
      ): Promise<void> {
        const next = mutate(this.saved);
        this.updates.push(next?.modelAvailability && "p/dead" in next.modelAvailability ? "p/dead" : undefined);
        if (next) this.saved = next;
      }
    }
    const persistence = new RecordingPersistence();
    updates = persistence.updates;
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: initialState(assessment),
      persistence,
    });

    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.model).toBe("p/alive");
    expect(result.executionMetadata?.unavailableModels).toEqual(["p/dead"]);
    expect(result.risks?.join(" ")).toContain("marked in the persisted model assessment");
    expect(updates).toEqual(["p/dead"]);
    expect(persistence.saved.modelAvailability?.["p/dead"]).toMatchObject({ callable: false, source: "runtime-failure" });

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
    let updateCalls = 0;
    const persistence = {
      save: async () => {},
      updateModelAssessment: async () => {
        updateCalls += 1;
      },
    };
    const service = new ExpertCouncilService(runtime, {}, undefined, {
      initialState: initialState(assessment),
      persistence,
    });
    const result = await service.delegate({ role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 });
    expect(result.status).toBe("success");
    expect(result.executionMetadata?.unavailableModels).toBeUndefined();
    expect(updateCalls).toBe(0);
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
