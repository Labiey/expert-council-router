import { describe, expect, it } from "vitest";
import { inferFailureType, parseCouncilConfig, sanitizeOutcome } from "../packages/core/src/index.js";
import type { ExpertOutcome } from "../packages/core/src/index.js";
import { aggregateOutcomes } from "../packages/core/src/telemetry.js";

const outcome = (overrides: Partial<ExpertOutcome> = {}): ExpertOutcome => ({
  timestamp: new Date().toISOString(),
  model: "test/model",
  provider: "test",
  role: "reviewer",
  taskCategory: "code-review",
  success: true,
  firstPass: true,
  toolErrors: 0,
  retryCount: 0,
  timedOut: false,
  escalationCount: 0,
  attempts: 1,
  hostType: "test",
  ...overrides,
});

describe("failure classification: transport faults are provider failures", () => {
  it.each([
    "[Failure] Connection error.",
    "Error: fetch failed",
    "upstream connect error or disconnect/reset before headers",
    "Bad Gateway",
    "Service Unavailable: overloaded",
    "HTTP 504 gateway timeout",
  ])("classifies %s as provider_error", (message) => {
    expect(inferFailureType(new Error(message))).toBe("provider_error");
  });

  it("does not mistake an upstream gateway timeout for our own budget expiring", () => {
    expect(inferFailureType("gateway timeout")).toBe("provider_error");
    expect(inferFailureType("Expert execution timed out after 1500000ms.")).toBe("timeout");
    expect(inferFailureType("operation timeout")).toBe("timeout");
  });

  it("keeps the pre-existing classifications intact", () => {
    expect(inferFailureType("permission denied")).toBe("permission_error");
    expect(inferFailureType("insufficient balance")).toBe("provider_error");
    expect(inferFailureType("tool call rejected")).toBe("tool_call_error");
  });
});

describe("learning attribution: infrastructure faults are not charged to the model", () => {
  it("excludes provider_error samples from the reliability aggregate", () => {
    const clean = aggregateOutcomes([
      outcome(),
      outcome({ success: false, firstPass: false, failureType: "provider_error" }),
    ]);
    expect(clean).toHaveLength(1);
    // The outage says nothing about the model, so it must not look like a loss.
    expect(clean[0]!.samples).toBe(1);
    expect(clean[0]!.successRate).toBe(1);
  });

  it("still counts failures that are attributable to the run", () => {
    const aggregate = aggregateOutcomes([
      outcome(),
      outcome({ success: false, firstPass: false, failureType: "test_failure" }),
    ]);
    expect(aggregate[0]!.samples).toBe(2);
    expect(aggregate[0]!.successRate).toBe(0.5);
  });
});

describe("telemetry projection keeps the new guardrail evidence", () => {
  it("persists failureType, observed counts, and attention codes instead of dropping them", () => {
    const written = sanitizeOutcome(outcome({
      failureType: "timeout",
      toolCalls: 12,
      toolErrorsObserved: 7,
      interactionRounds: 2,
      attentionCodes: ["budget_fraction", "consecutive_tool_failures", "budget_fraction"],
    }));
    expect(written).toMatchObject({
      failureType: "timeout",
      toolCalls: 12,
      toolErrorsObserved: 7,
      interactionRounds: 2,
      attentionCodes: ["budget_fraction", "consecutive_tool_failures", "budget_fraction"],
    });
  });

  it("omits absent fields rather than writing nulls, and bounds attention codes", () => {
    expect(sanitizeOutcome(outcome())).not.toHaveProperty("failureType");
    expect(sanitizeOutcome(outcome())).not.toHaveProperty("attentionCodes");
    const many = sanitizeOutcome(outcome({ attentionCodes: Array.from({ length: 20 }, (_, i) => `code-${i}`) }));
    expect(many.attentionCodes).toHaveLength(8);
  });
});

describe("guardrails configuration", () => {
  it("defaults to detection on, bounded, and no aggregate ceiling", () => {
    const config = parseCouncilConfig({});
    expect(config.security.guardrails).toEqual({
      warnHost: true,
      nudgeExpert: true,
      consecutiveToolFailures: 3,
      minCallsForRatio: 8,
      failureRatio: 0.5,
      budgetFractions: [0.6, 0.85],
    });
  });

  it("keeps an explicit ceiling out of the object when it is not configured", () => {
    expect(parseCouncilConfig({}).security.guardrails).not.toHaveProperty("maxTotalWallMs");
    expect(parseCouncilConfig({ security: { guardrails: { maxTotalWallMs: 90_000 } } }).security.guardrails.maxTotalWallMs).toBe(90_000);
  });

  it.each([
    [{ consecutiveToolFailures: 1 }, "consecutiveToolFailures"],
    [{ failureRatio: 0.96 }, "failureRatio"],
    [{ budgetFractions: [1.5] }, "budgetFractions"],
    [{ maxTotalWallMs: 500 }, "maxTotalWallMs"],
    [{ minCallsForRatio: 3 }, "minCallsForRatio"],
  ])("rejects %o and names the offending field", (guardrails, field) => {
    expect(() => parseCouncilConfig({ security: { guardrails } })).toThrowError(new RegExp(field));
  });

  it("honours an operator who turns struggle detection off", () => {
    const config = parseCouncilConfig({ security: { guardrails: { warnHost: false, nudgeExpert: false } } });
    expect(config.security.guardrails.warnHost).toBe(false);
    expect(config.security.guardrails.nudgeExpert).toBe(false);
    expect(config.security.guardrails.consecutiveToolFailures).toBe(3);
  });
});
