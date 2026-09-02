import type { ExpertResult, FailureType } from "./types.js";

const PROVIDER_FAILURE_MARKERS = [
  "provider",
  "api key",
  "rate limit",
  "model registry",
  "not currently available",
  "model unavailable",
] as const;

export function inferFailureType(value: unknown, fallback: FailureType = "unknown"): FailureType {
  const message = value instanceof Error ? value.message.toLowerCase() : String(value).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("permission") || message.includes("workspace") || message.includes("worktree")) {
    return "permission_error";
  }
  if (PROVIDER_FAILURE_MARKERS.some((marker) => message.includes(marker))) return "provider_error";
  if (message.includes("tool")) return "tool_call_error";
  if (message.includes("test") || message.includes("assertion")) return "test_failure";
  if (message.includes("context") || message.includes("missing file") || message.includes("missing information")) {
    return "missing_context";
  }
  return fallback;
}

export function failureTypeForResult(result: ExpertResult): FailureType {
  if (result.executionMetadata?.failureType) return result.executionMetadata.failureType;
  if (result.tests?.some((test) => test.status === "failed")) return "test_failure";
  return inferFailureType(result.summary);
}
