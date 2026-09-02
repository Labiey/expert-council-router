import { modelInventoryFingerprint } from "./council.js";
import type { AvailableModel, ModelAssessmentSnapshot, ModelAssessmentStatus } from "./types.js";

export const DEFAULT_MODEL_ASSESSMENT_MAX_AGE_DAYS = 30;
export const MAX_MODEL_ASSESSMENT_FUTURE_SKEW_MS = 5 * 60_000;

export interface ResolvedModelAssessment {
  assessment?: ModelAssessmentSnapshot;
  status: ModelAssessmentStatus;
  source: "saved" | "submitted" | "none";
  ignoredSubmittedAssessment: boolean;
}

export function evaluateModelAssessment(
  models: AvailableModel[],
  assessment?: ModelAssessmentSnapshot,
  options: { now?: Date; maxAgeDays?: number } = {},
): ModelAssessmentStatus {
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MODEL_ASSESSMENT_MAX_AGE_DAYS;
  const requiredModels = models
    .filter((model) => model.available)
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
  const assessedModels = Object.keys(assessment?.models ?? {}).sort();
  const assessed = new Set(assessedModels);
  const required = new Set(requiredModels);
  const missingModels = requiredModels.filter((key) => !assessed.has(key));
  const unavailableAssessedModels = assessedModels.filter((key) => !required.has(key));
  const inventoryFingerprint = modelInventoryFingerprint(models);
  const assessedAtMs = assessment ? Date.parse(assessment.asOf) : Number.NaN;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60_000;
  const futureDated = assessment
    ? Number.isFinite(assessedAtMs) && assessedAtMs > now.getTime() + MAX_MODEL_ASSESSMENT_FUTURE_SKEW_MS
    : false;
  const stale = assessment
    ? !Number.isFinite(assessedAtMs) || now.getTime() - assessedAtMs > maxAgeMs
    : false;
  const reason: ModelAssessmentStatus["reason"] = !assessment
    ? "missing"
    : futureDated
      ? "future-dated"
    : stale
      ? "stale"
      : missingModels.length || unavailableAssessedModels.length
        ? "inventory-changed"
        : "current";
  const researchModels = reason === "inventory-changed"
    ? missingModels
    : reason === "current" || reason === "future-dated"
      ? []
      : requiredModels;

  if (reason === "current") {
    return {
      status: "current",
      reason,
      inventoryFingerprint,
      requiredModels,
      researchModels,
      missingModels,
      unavailableAssessedModels,
      maxAgeDays,
      assessedAt: assessment!.asOf,
      refreshAfter: new Date(assessedAtMs + maxAgeMs).toISOString(),
    };
  }

  return {
    status: "required",
    reason,
    inventoryFingerprint,
    requiredModels,
    researchModels,
    missingModels,
    unavailableAssessedModels,
    maxAgeDays,
    ...(assessment ? {
      assessedAt: assessment.asOf,
      ...(Number.isFinite(assessedAtMs) ? { refreshAfter: new Date(assessedAtMs + maxAgeMs).toISOString() } : {}),
      ...(futureDated ? {
        futureSkewMinutes: Math.ceil((assessedAtMs - now.getTime()) / 60_000),
        allowedFutureSkewMinutes: MAX_MODEL_ASSESSMENT_FUTURE_SKEW_MS / 60_000,
      } : {}),
    } : {}),
    instructions: reason === "future-dated"
      ? [
          "Do not build or delegate a council yet.",
          "The submitted assessment timestamp is ahead of the host clock. Reuse the submitted sources, scores, and billing evidence; do not repeat web research.",
          "Read the actual host time and retry once with an asOf timestamp no later than the current time. Use 1 to 12 consolidated source URLs.",
        ]
      : [
          "Do not build or delegate a council yet.",
          "Use an already available web/research tool to audit only the models listed in researchModels; preserve current saved scores for other requiredModels entries and do not install a tool or package.",
          "Use current benchmark evidence for capabilities and provider documentation or runtime evidence for access/billing; never infer personal billing from published token prices.",
          "Submit one complete modelAssessment covering every requiredModels entry, dated from the actual host clock, with 1 to 12 consolidated source URLs.",
        ],
  };
}

/**
 * Prefer a valid submitted snapshot, but never let an incomplete, stale, or
 * future-dated tool argument displace a complete current snapshot already on
 * disk. This keeps malformed host output from manufacturing a false
 * inventory-change gate.
 */
export function resolveModelAssessment(
  models: AvailableModel[],
  saved?: ModelAssessmentSnapshot,
  submitted?: ModelAssessmentSnapshot,
  options: { now?: Date; maxAgeDays?: number } = {},
): ResolvedModelAssessment {
  const savedStatus = evaluateModelAssessment(models, saved, options);
  if (!submitted) {
    return {
      ...(saved ? { assessment: saved } : {}),
      status: savedStatus,
      source: saved ? "saved" : "none",
      ignoredSubmittedAssessment: false,
    };
  }

  const submittedStatus = evaluateModelAssessment(models, submitted, options);
  if (submittedStatus.status === "current" || savedStatus.status !== "current" || !saved) {
    return {
      assessment: submitted,
      status: submittedStatus,
      source: "submitted",
      ignoredSubmittedAssessment: false,
    };
  }

  return {
    assessment: saved,
    status: savedStatus,
    source: "saved",
    ignoredSubmittedAssessment: true,
  };
}
