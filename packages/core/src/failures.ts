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

/**
 * Phrases whose provider failures indicate the plan or API balance ran out.
 * Unlike dead models these may recover after a top-up or quota reset, so they
 * are marked with a distinct, shorter-lived `quota-exhausted` kind.
 */
const MODEL_QUOTA_MARKERS = [
  "insufficient_quota",
  "quota exceeded",
  "quota exhausted",
  "exceeded your current quota",
  "exhausted your quota",
  "billing_hard_limit",
  "insufficient balance",
  "balance is not enough",
  "not enough balance",
  "account balance",
  "arrears",
  "payment required",
  "欠费",
  "余额不足",
  "token plan quota",
  "plan quota exhausted",
] as const;

export type AvailabilityEvidence = "unavailable" | "quota-exhausted";

/**
 * Classify provider-failure evidence: quota exhaustion wins over the generic
 * unavailable markers because messages such as "403 AccessDenied: quota
 * exhausted" must land in the recoverable quota kind, not the dead-model one.
 */
export function classifyAvailabilityEvidence(summary: unknown): AvailabilityEvidence | undefined {
  const message = (summary instanceof Error ? summary.message : String(summary ?? "")).toLowerCase();
  if (MODEL_QUOTA_MARKERS.some((marker) => message.includes(marker))) return "quota-exhausted";
  if (MODEL_UNAVAILABLE_MARKERS.some((marker) => message.includes(marker))) return "unavailable";
  return undefined;
}

export function indicatesModelUnavailable(summary: unknown): boolean {
  return classifyAvailabilityEvidence(summary) !== undefined;
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
