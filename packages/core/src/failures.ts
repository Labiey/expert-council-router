import type { ExpertResult, FailureType } from "./types.js";

const PROVIDER_FAILURE_MARKERS = [
  "provider",
  "api key",
  "rate limit",
  "model registry",
  "not currently available",
  "model unavailable",
  "access denied",
  "access to model denied",
  "accessdenied",
] as const;

/**
 * Phrases whose provider failures indicate the model itself is gone, as opposed
 * to transient conditions such as rate limits, quota exhaustion, or auth
 * problems. Runtime availability markers are only recorded for these.
 */
const MODEL_UNAVAILABLE_MARKERS = [
  "model not found",
  "model_not_found",
  "unknown model",
  "no such model",
  "invalid model",
  "unsupported model",
  "model does not exist",
  "model is not available",
  "model unavailable",
  "model is unavailable",
  "not currently available",
  "no longer contains",
  "decommissioned",
  "has been discontinued",
  "access to model denied",
  "model access denied",
  "accessdenied",
  "unpurchased",
  "not eligible for using the model",
] as const;

export function indicatesModelUnavailable(summary: unknown): boolean {
  const message = (summary instanceof Error ? summary.message : String(summary ?? "")).toLowerCase();
  return MODEL_UNAVAILABLE_MARKERS.some((marker) => message.includes(marker));
}

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
