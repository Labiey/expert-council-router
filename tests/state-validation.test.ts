import { describe, expect, it } from "vitest";
import { parseCouncilStateSnapshot } from "../packages/core/src/state-validation.js";

const baseResult = {
  status: "partial",
  role: "scout",
  model: "p/m",
  summary: "stopped by the expert",
};

describe("council state snapshot schema", () => {
  it("accepts the stoppedByExpert execution metadata written by report_and_stop", () => {
    const snapshot = {
      version: 1,
      plans: [],
      executions: [],
      results: [
        {
          executionId: "exec_1",
          result: {
            ...baseResult,
            executionMetadata: {
              attempts: 2,
              failureType: "missing_context",
              stoppedByExpert: true,
            },
          },
        },
      ],
    };
    const parsed = parseCouncilStateSnapshot(snapshot);
    expect(parsed.results[0]?.result.executionMetadata?.stoppedByExpert).toBe(true);
  });

  it("keeps parsing state when executionMetadata carries keys newer than this schema (forward compatibility)", () => {
    const snapshot = {
      version: 1,
      plans: [],
      executions: [],
      results: [
        {
          executionId: "exec_1",
          result: {
            ...baseResult,
            executionMetadata: { someFutureField: { nested: true } },
          },
        },
      ],
    };
    expect(() => parseCouncilStateSnapshot(snapshot)).not.toThrow();
  });

  it("still rejects unknown keys on the strict top-level result shape", () => {
    const snapshot = {
      version: 1,
      plans: [],
      executions: [],
      results: [
        {
          executionId: "exec_1",
          result: { ...baseResult, totallyUnknownTopLevel: 1 },
        },
      ],
    };
    expect(() => parseCouncilStateSnapshot(snapshot)).toThrow(/malformed state snapshot/);
  });
});
