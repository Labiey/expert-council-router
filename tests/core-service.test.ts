import { describe, expect, it } from "vitest";
import {
  decideEscalation,
  ExpertCouncilService,
  MemoryTelemetryStore,
  sanitizeOutcome,
} from "../packages/core/src/index.js";
import { capabilities, MockRuntime, model } from "./helpers.js";

const profiles = {
  "cheap/one": { coding: 8, toolReliability: 8, autonomousExecution: 8, bashReliability: 8 },
  "quality/two": { coding: 9, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
};

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

  it("retries one correctable failure on the same model", async () => {
    const runtime = new MockRuntime([model("cheap", "one")], [
      (request) => ({
        status: "failed",
        role: request.role,
        model: request.model,
        summary: "bad tool arguments",
        executionMetadata: { failureType: "tool_call_error" },
      }),
      (request) => ({ status: "success", role: request.role, model: request.model, summary: "fixed" }),
    ]);
    const service = new ExpertCouncilService(runtime, { profiles: { models: profiles } });
    const result = await service.delegate({ role: "implementation-worker", task: "Rename a local symbol" });
    expect(result.status).toBe("success");
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[0]?.model).toBe(runtime.requests[1]?.model);
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
