import type { ExpertResult, TestResult } from "./types.js";

/** Persisted schema bounds for expert results (state-validation.ts). */
const MAX_SUMMARY = 4_000;
const MAX_FILES_CHANGED = 1_000;
const MAX_TEST_ENTRIES = 20;
const MAX_TEST_TEXT = 2_000;
const MAX_LIST_ENTRIES = 20;
const MAX_UNAVAILABLE_MODELS = 64;

/**
 * Clamp one test entry to the persisted bounds without mutating the input.
 * Command text and status are schema-valid by construction; only the free-form
 * text fields can arrive oversized from a verbose expert.
 */
function clampTest(test: TestResult): TestResult {
  return {
    ...test,
    ...(test.summary !== undefined ? { summary: test.summary.slice(0, MAX_TEST_TEXT) } : {}),
    ...(test.outputTail !== undefined ? { outputTail: test.outputTail.slice(0, MAX_TEST_TEXT) } : {}),
  };
}

/**
 * Clamp an expert result to the persisted snapshot schema before writing it to
 * the state file. Returns a NEW object; the input is never mutated. Oversized
 * evidence must degrade by truncation, never fail the whole persisted state.
 */
export function clampExpertResult(result: ExpertResult): ExpertResult {
  return {
    ...result,
    summary: result.summary.slice(0, MAX_SUMMARY),
    ...(result.filesChanged ? { filesChanged: result.filesChanged.slice(0, MAX_FILES_CHANGED) } : {}),
    ...(result.tests ? { tests: result.tests.slice(0, MAX_TEST_ENTRIES).map(clampTest) } : {}),
    ...(result.findings
      ? { findings: result.findings.slice(0, MAX_LIST_ENTRIES).map((entry) => entry.slice(0, MAX_TEST_TEXT)) }
      : {}),
    ...(result.risks
      ? { risks: result.risks.slice(0, MAX_LIST_ENTRIES).map((entry) => entry.slice(0, MAX_TEST_TEXT)) }
      : {}),
    ...(result.executionMetadata
      ? {
          executionMetadata: {
            ...result.executionMetadata,
            ...(result.executionMetadata.unavailableModels
              ? { unavailableModels: result.executionMetadata.unavailableModels.slice(0, MAX_UNAVAILABLE_MODELS) }
              : {}),
          },
        }
      : {}),
  };
}
