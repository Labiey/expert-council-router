import { describe, expect, it } from "vitest";
import { parseCouncilStateSnapshot } from "../packages/core/src/state-validation.js";
import { clampExpertResult } from "../packages/core/src/index.js";
import type { ExpertResult } from "../packages/core/src/index.js";

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

  it("clamps an oversized unavailableModels array to the persisted 64-entry bound", () => {
    const oversized = Array.from({ length: 100 }, (_, index) => `p/m${index}`);
    const raw = {
      version: 1,
      plans: [],
      executions: [],
      results: [
        { executionId: "exec_1", result: { ...baseResult, executionMetadata: { unavailableModels: oversized } } },
      ],
    };
    // Raw 100-entry array violates the max(64) schema and must be rejected.
    expect(() => parseCouncilStateSnapshot(raw)).toThrow(/malformed state snapshot/);
    // After the write-side clamp it survives and is truncated to 64.
    const clamped = clampExpertResult(raw.results[0]!.result as ExpertResult);
    expect(clamped.executionMetadata?.unavailableModels).toHaveLength(64);
    const snapshot = {
      version: 1,
      plans: [],
      executions: [],
      results: [{ executionId: "exec_1", result: clamped }],
    };
    expect(() => parseCouncilStateSnapshot(snapshot)).not.toThrow();
  });

  it("accepts the enriched TestResult evidence fields", () => {
    const snapshot = {
      version: 1,
      plans: [],
      executions: [],
      results: [
        {
          executionId: "exec_1",
          result: {
            ...baseResult,
            tests: [{
              command: "npm test",
              status: "passed",
              exitCode: 0,
              testsRun: 5,
              failedCount: 0,
              errorCount: 0,
              skippedCount: 1,
              durationMs: 12,
              outputTail: "5 passed",
            }],
            executionMetadata: {
              verification: [{ command: "npm run typecheck", status: "passed", exitCode: 0, outputTail: "ok" }],
            },
          },
        },
      ],
    };
    const parsed = parseCouncilStateSnapshot(snapshot);
    expect(parsed.results[0]?.result.tests?.[0]).toMatchObject({ exitCode: 0, testsRun: 5, durationMs: 12 });
    expect(parsed.results[0]?.result.executionMetadata?.verification?.[0]).toMatchObject({ exitCode: 0 });
  });

  it("truncates oversized free-text and list fields without mutating the input", () => {
    const input: ExpertResult = {
      status: "success",
      role: "scout",
      model: "p/m",
      summary: "x".repeat(5_000),
      filesChanged: Array.from({ length: 1_500 }, (_, index) => `f${index}.ts`),
      tests: Array.from({ length: 30 }, () => ({ status: "passed" as const, outputTail: "y".repeat(3_000) })),
      findings: Array.from({ length: 30 }, () => "z".repeat(3_000)),
      risks: Array.from({ length: 30 }, () => "w"),
    };
    const clamped = clampExpertResult(input);
    expect(clamped.summary).toHaveLength(4_000);
    expect(clamped.filesChanged).toHaveLength(1_000);
    expect(clamped.tests).toHaveLength(20);
    expect(clamped.tests?.[0]?.outputTail).toHaveLength(2_000);
    expect(clamped.findings).toHaveLength(20);
    expect(clamped.findings?.[0]).toHaveLength(2_000);
    expect(clamped.risks).toHaveLength(20);
    // Input object is never mutated.
    expect(input.summary).toHaveLength(5_000);
    expect(input.filesChanged).toHaveLength(1_500);
  });
});
