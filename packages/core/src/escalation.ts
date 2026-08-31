import type { EscalationDecision, EscalationRequest, FailureType, RankedCandidate } from "./types.js";

const CORRECTABLE: ReadonlySet<FailureType> = new Set(["tool_call_error", "missing_context", "test_failure"]);

export function decideEscalation(
  request: EscalationRequest,
  candidates: RankedCandidate[],
  correctedRetriesPerModel = 1,
): EscalationDecision {
  const currentFailures = request.previousFailures.filter((failure) => failure.model === request.currentModel);
  const latest = request.previousFailures.at(-1);
  if (!latest) return { action: "stop", reason: "No failure evidence was supplied." };

  if (CORRECTABLE.has(latest.type) && currentFailures.length <= correctedRetriesPerModel) {
    return {
      action: "retry",
      model: request.currentModel,
      reason: `${latest.type} is potentially correctable and the per-model retry budget remains.`,
      correctedInstruction: `Previous attempt failed with ${latest.type}: ${latest.summary}. Diagnose that cause, change the approach, and do not repeat the identical failed action.`,
    };
  }

  const attempted = new Set(request.previousFailures.map((failure) => failure.model));
  const next = candidates.find((candidate) => candidate.model !== request.currentModel && !attempted.has(candidate.model));
  if (next) {
    return {
      action: "escalate",
      model: next.model,
      reason: `Current model has ${currentFailures.length} relevant failure(s); moving to the next eligible candidate.`,
    };
  }
  return { action: "stop", reason: "No untried eligible model remains within the escalation policy." };
}
