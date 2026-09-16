import { describe, expect, it } from "vitest";
import { inferFailureType, inferFailureTypeFromSummary, parseCouncilConfig, sanitizeOutcome } from "../packages/core/src/index.js";
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

describe("report text is weaker evidence than an error message", () => {
  it("will not turn a long expert report into a supplier outage", () => {
    const report =
      "All gates pass. Work complete - final summary: the presence package now builds and initializes; " +
      "I also noticed the owner runtime logs a bad gateway when the socket dies, which is unrelated to this change " +
      "and should be tracked separately.";
    expect(inferFailureTypeFromSummary(report)).toBe("reasoning_failure");
  });

  it("ignores transport vocabulary that is not shaped like a failure", () => {
    expect(inferFailureTypeFromSummary("the crash follows a 502 from the gateway")).toBe("reasoning_failure");
    expect(inferFailureTypeFromSummary("")).toBe("reasoning_failure");
  });

  it("still classifies failure-shaped summaries, however long the tail", () => {
    expect(inferFailureTypeFromSummary("Connection error.")).toBe("provider_error");
    expect(inferFailureTypeFromSummary(`[Failure] Connection error.

${"Scout roles are read-only. ".repeat(20)}`)).toBe("provider_error");
    expect(inferFailureTypeFromSummary("Error: fetch failed")).toBe("provider_error");
  });

  it("requires HTTP status codes to appear in context", () => {
    expect(inferFailureType("[Failure] HTTP 502 Bad Gateway")).toBe("provider_error");
    expect(inferFailureType("[Failure] status: 504")).toBe("provider_error");
    expect(inferFailureType("[Failure] the api is overloaded")).toBe("provider_error");
    expect(inferFailureType("[Failure] saw 502 in the fixture")).toBe("unknown");
    expect(inferFailureType("[Failure] server error")).toBe("unknown");
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

describe("telemetry projection covers every field of the outcome record", () => {
  it("keeps every key the outcome type can carry, enforced at compile time", () => {
    // `Record<keyof ExpertOutcome, ...>` is the guard: adding a field to ExpertOutcome
    // without listing it here fails the build, and listing it without registering it in
    // sanitizeOutcome fails this test. Both halves matter - `interactionRounds` (0.8.4),
    // `failureType`/`toolCalls`/`attentionCodes` (0.8.5) and `toolErrorsObserved` each
    // reached the store as nothing at all because only one half was done.
    const everyField: Record<keyof ExpertOutcome, unknown> = {
      executionId: "exec_full",
      timestamp: "2026-09-16T00:00:00.000Z",
      model: "model",
      provider: "test",
      role: "reviewer",
      taskCategory: "code-review",
      success: false,
      firstPass: false,
      toolErrors: 4,
      retryCount: 1,
      timedOut: true,
      aborted: true,
      escalationCount: 2,
      attempts: 3,
      hostType: "test",
      interactionRounds: 2,
      toolErrorsObserved: 4,
      failureType: "provider_error",
      toolCalls: 12,
      attentionCodes: ["budget_fraction", "consecutive_tool_failures"],
      approximateUsage: { inputTokens: 10, outputTokens: 2 },
      verificationPassed: false,
    };
    const written = sanitizeOutcome(outcome(everyField as Partial<ExpertOutcome>));
    const dropped = Object.keys(everyField).filter((key) => !(key in written));
    // Every field survives the whitelist projection. If a field is ever deliberately not
    // persisted, it must be excluded here with a reason, not vanish silently.
    expect(dropped).toEqual([]);
    expect(written.attentionCodes).toEqual(["budget_fraction", "consecutive_tool_failures"]);
    expect(written.failureType).toBe("provider_error");
  });
});
