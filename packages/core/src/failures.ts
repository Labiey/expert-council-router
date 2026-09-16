import type { ExpertResult, FailureType } from "./types.js";

/**
 * Transport-level upstream faults. These are checked before the generic `timeout`
 * branch, because "gateway timeout" is the provider's failure, not our budget
 * expiring. Without them a dropped provider connection was classified `unknown`,
 * which cost three things at once: no availability marking, none of the bounded
 * budget growth reserved for timeouts, and - worst - a supplier outage charged
 * against that model's own reliability record in local learning. Observed live:
 * an attempt whose last text was "Connection error." recorded `failureType: unknown`.
 *
 * Every marker here is message-shaped on purpose. A bare "502" or "overloaded" is not:
 * the same classifier is also handed an expert's own report (see
 * `inferFailureTypeFromSummary`), and a debugger writing "the crash follows a 502 from
 * the gateway" must never be recorded as a supplier outage blamed on the model that
 * wrote it. Status codes therefore only match alongside HTTP context.
 */
const TRANSPORT_FAILURE_MARKERS = [
  "connection error",
  "connection reset",
  "connection closed",
  "connection failure",
  "connection refused",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "epipeconn",
  "socket hang up",
  "socket hangup",
  "fetch failed",
  "network timeout",
  "upstream connect error",
  "upstream connect",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "internal server error",
  "stream disconnected",
  "api overloaded",
  "server overloaded",
  "model overloaded",
  "is overloaded",
  "http 502",
  "http 503",
  "http 504",
  "http 521",
  "http 522",
  "http 524",
  "status 502",
  "status 503",
  "status 504",
  "status: 502",
  "status: 503",
  "status: 504",
  "code 502",
  "code 503",
  "code 504",
  "error 502",
  "error 503",
  "error 504",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
] as const;

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
const MODEL_RATE_LIMIT_MARKERS = [
  "#token-limit",
  "allocated quota exceeded",
  "rate limit",
  "rate-limit",
  "ratelimit",
  "throttling",
  "too many requests",
  "requests per minute",
  "tokens per minute",
  "per-minute limit",
  "限流",
];

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

export type AvailabilityEvidence = "unavailable" | "quota-exhausted" | "rate-limited" | "transport-unstable";

/**
 * Classify provider-failure evidence: quota exhaustion wins over the generic
 * unavailable markers because messages such as "403 AccessDenied: quota
 * exhausted" must land in the recoverable quota kind, not the dead-model one.
 */
export function classifyAvailabilityEvidence(summary: unknown): AvailabilityEvidence | undefined {
  const message = (summary instanceof Error ? summary.message : String(summary ?? "")).toLowerCase();
  // Transient throttling (TPM/RPM windows, e.g. DashScope "Allocated quota
  // exceeded ... #token-limit") must win over quota wording: it recovers in
  // minutes and must not blackhole a whole token plan for hours.
  if (MODEL_RATE_LIMIT_MARKERS.some((marker) => message.includes(marker))) return "rate-limited";
  if (MODEL_QUOTA_MARKERS.some((marker) => message.includes(marker))) return "quota-exhausted";
  // Checked before the dead-model markers on purpose: "503 Service Unavailable" is an
  // upstream fault, and a substring collision with the unavailable markers must never
  // write off a model that is alive and merely unreachable right now.
  if (TRANSPORT_FAILURE_MARKERS.some((marker) => message.includes(marker))) return "transport-unstable";
  if (MODEL_UNAVAILABLE_MARKERS.some((marker) => message.includes(marker))) return "unavailable";
  return undefined;
}

export function indicatesModelUnavailable(summary: unknown): boolean {
  return classifyAvailabilityEvidence(summary) !== undefined;
}

/**
 * How a long piece of text must begin to be read as a provider message rather than as
 * narration. Real providers do return long bodies - `429: {"message":"Your token-plan
 * quota has been exhausted..."}` - so length alone cannot be the test; the opening can.
 */
const MESSAGE_LIKE_OPENING =
  /^(\[failure\]|\d{3}\b|\bprovider\b|\bhttp\b|\bupstream\b|\bfatal\b|\berror\b|\bfailure\b|\bexception\b|\btimeout\b|\bquota\b|rate.?limit|\bthrottl|\bsocket\b|fetch failed|\bconnection\b|econn\w*|model_not_found|\baccess\b|unauthorized|service unavailable)/i;

/**
 * Availability evidence taken from a result's report text rather than from a provider
 * error message. `classifyAvailabilityEvidence` is written for messages; since 0.8.6 the
 * transport markers include phrases that turn up routinely in debugging write-ups
 * ("connection error", "fetch failed", "is overloaded"), so an unguarded report could
 * pause its own model in routing - the #16 inversion on the routing axis (defect #34).
 *
 * Short text is trusted, because the availability markers are already specific phrases.
 * Long text must open like a message, which is what stops a write-up that merely quotes
 * "connection error" while explaining that it is unrelated. Note this is deliberately
 * looser than `readsAsFailureMessage`: that predicate serves the failure-type buckets
 * ("tool", "test", "context"), and applying it here would refuse genuine messages like
 * "model_not_found" or "429 rate limit exceeded", which open with none of its words.
 */
export function classifyReportedAvailabilityEvidence(value: unknown): AvailabilityEvidence | undefined {
  const text = (value instanceof Error ? value.message : String(value ?? "")).trim();
  if (!text) return undefined;
  // Short text is trusted, because the availability markers are specific phrases. Long
  // text is only trusted when it opens like a message, which is what stops a debugging
  // report that merely quotes "connection error" from pausing its own model (#34) -
  // the #16 inversion on the routing axis, newly reachable because 0.8.6 made transport
  // phrases into availability evidence.
  if (text.length > SUMMARY_CLASSIFICATION_LIMIT && !MESSAGE_LIKE_OPENING.test(text)) return undefined;
  return classifyAvailabilityEvidence(text);
}

/** Longer than this, free-form text is treated as narration, not as a failure message. */
export const SUMMARY_CLASSIFICATION_LIMIT = 200;

/**
 * Whether text may be read as a failure *message* rather than as free-form narration, for
 * the failure-type classifier. A long write-up can quote "connection error", "502 bad
 * gateway" or "the model is overloaded" while explaining that none of it is the model's
 * fault, and that quotation must not cost the model its reliability record (#16).
 *
 * Availability evidence deliberately does NOT share this predicate: its markers are specific
 * phrases, and this vocabulary was written for the failure-type buckets, so applying it
 * there would refuse genuine provider messages (see
 * `classifyReportedAvailabilityEvidence` and defect #34).
 */
function readsAsFailureMessage(text: string): boolean {
  if (/^\[failure\]/i.test(text)) return true;
  if (text.length > SUMMARY_CLASSIFICATION_LIMIT) return false;
  return /(error|failed|failure|exception|timed out|timeout|unavailable|denied|reject)/i.test(text.slice(0, 60));
}

/**
 * A failure type derived from report text, which is a different evidence class from an
 * error message: an expert's summary can quote the very words that mark a transport fault
 * while describing somebody else's bug. Only text that is itself shaped like a failure -
 * our own `[Failure]` prefix, or a short line that opens with failure vocabulary - is
 * classified at all, so a long report can never invent a supplier outage and have it
 * blamed on the model that wrote it.
 */
export function inferFailureTypeFromSummary(value: unknown, fallback: FailureType = "reasoning_failure"): FailureType {
  const text = (typeof value === "string" ? value : String(value ?? "")).trim();
  if (!text || !readsAsFailureMessage(text)) return fallback;
  return inferFailureType(text, fallback);
}

export function inferFailureType(value: unknown, fallback: FailureType = "unknown"): FailureType {
  const message = value instanceof Error ? value.message.toLowerCase() : String(value).toLowerCase();
  // Transport faults win over the generic timeout branch: they are upstream failures,
  // and misreading them as our own timeout both grows a budget that was never the
  // problem and blames the model for a supplier outage.
  if (TRANSPORT_FAILURE_MARKERS.some((marker) => message.includes(marker))) return "provider_error";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("permission") || message.includes("workspace") || message.includes("worktree")) {
    return "permission_error";
  }
  // Quota/balance exhaustion (HTTP 429 and plan-quota wording) is provider
  // evidence: classifying it as provider_error lets the availability marker
  // record the whole plan and stop routing into the same depleted quota.
  if (
    message.includes("429") ||
    message.includes("quota") ||
    message.includes("insufficient") ||
    message.includes("rate limit") ||
    message.includes("rate-limit") ||
    message.includes("throttling") ||
    message.includes("token-limit") ||
    message.includes("too many requests") ||
    message.includes("限流") ||
    message.includes("欠费") ||
    message.includes("余额不足")
  ) {
    return "provider_error";
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
  // Deliberately the unguarded classifier. This is the council's recovery path for a
  // runtime that declared no failure type at all on an already-failed attempt: a real
  // provider body such as `429: {"message":"...quota has been exhausted."}` must still be
  // recognised as supplier evidence so the plan-wide marker lands (pinned by
  // "classifies plan-quota 429 failures as provider_error so the whole plan gets marked").
  // Routing the guarded report classifier through here would refuse exactly that text,
  // because its opening vocabulary list was written for failure-type buckets, not quota
  // wording. The #34 hazard is on the availability axis and is closed at that gate instead.
  return inferFailureType(result.summary);
}
