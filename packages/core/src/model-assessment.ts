import { modelInventoryFingerprint } from "./council.js";
import type {
  AvailableModel,
  AvailabilityMarkerKind,
  ModelAssessmentSnapshot,
  ModelAssessmentStatus,
  ModelAvailabilityObservation,
  ModelStatusObservation,
} from "./types.js";

export const DEFAULT_MODEL_ASSESSMENT_MAX_AGE_DAYS = 30;
export const MAX_MODEL_ASSESSMENT_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Runtime availability markers are conservative, locally learned evidence. They
 * steer routing away from a model for one day and expire without user action so
 * a model that returns after a provider-side removal or outage is retried.
 */
export const MODEL_AVAILABILITY_MARKER_TTL_MS = 24 * 60 * 60_000;
/**
 * Quota exhaustion is recoverable (top-up or quota reset), so its marker
 * lifetime is deliberately shorter than the dead-model one: routing retries
 * the model sooner instead of writing it off for a full day.
 */
export const MODEL_QUOTA_MARKER_TTL_MS = 6 * 60 * 60_000;
export const MAX_MODEL_AVAILABILITY_REASON_LENGTH = 500;

function markerTtlMs(kind: AvailabilityMarkerKind | undefined, defaultTtlMs: number): number {
  return kind === "quota-exhausted" ? MODEL_QUOTA_MARKER_TTL_MS : defaultTtlMs;
}

export function activeModelAvailability(
  assessment: ModelAssessmentSnapshot | undefined,
  now: Date = new Date(),
  ttlMs = MODEL_AVAILABILITY_MARKER_TTL_MS,
): Record<string, ModelAvailabilityObservation> {
  const entries = assessment?.modelAvailability ?? {};
  const active: Record<string, ModelAvailabilityObservation> = {};
  for (const [key, marker] of Object.entries(entries)) {
    const observedAtMs = Date.parse(marker.observedAt);
    const ttl = markerTtlMs(marker.kind, ttlMs);
    if (!Number.isFinite(observedAtMs) || now.getTime() - observedAtMs > ttl || now.getTime() < observedAtMs) continue;
    active[key] = marker;
  }
  return active;
}

function availabilityWarning(key: string, marker: ModelAvailabilityObservation): string {
  if (marker.kind === "quota-exhausted") {
    return `Model ${key} quota or balance ran out at ${marker.observedAt}: ${marker.reason}. Routing avoids it while the marker is active (short lifetime); top up or wait for the quota reset and the model is retried automatically.`;
  }
  return `Model ${key} was marked unavailable by a runtime failure at ${marker.observedAt}: ${marker.reason}. Routing avoids it while the marker is active.`;
}

export function modelAvailabilityWarnings(
  assessment: ModelAssessmentSnapshot | undefined,
  models: AvailableModel[],
  now: Date = new Date(),
): string[] {
  const inventory = new Set(models.map((model) => `${model.provider}/${model.id}`));
  return Object.entries(activeModelAvailability(assessment, now))
    .filter(([key]) => inventory.has(key))
    .map(([key, marker]) => availabilityWarning(key, marker));
}

/**
 * Merge a runtime availability marker into a snapshot. Returns the same
 * reference when the model is already marked, so callers can persist cheaply.
 */
export function withModelAvailabilityMarker(
  assessment: ModelAssessmentSnapshot,
  modelKey: string,
  reason: string,
  observedAt: string = new Date().toISOString(),
  kind: AvailabilityMarkerKind = "unavailable",
): ModelAssessmentSnapshot {
  const existing = assessment.modelAvailability?.[modelKey];
  if (existing && Date.parse(existing.observedAt) >= Date.parse(observedAt) && existing.kind === kind) return assessment;
  const marker: ModelAvailabilityObservation = {
    callable: false,
    kind,
    observedAt,
    reason: reason.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, MAX_MODEL_AVAILABILITY_REASON_LENGTH) || "model call failed",
    source: "runtime-failure",
  };
  return {
    ...assessment,
    modelAvailability: {
      ...assessment.modelAvailability,
      [modelKey]: marker,
    },
  };
}

/**
 * Record the current runtime status of a model into the shared assessment.
 * Successful calls mark the model available again; failures mark
 * quota-exhausted or unavailable with the provider diagnostic as evidence.
 */
export function withModelStatus(
  assessment: ModelAssessmentSnapshot,
  modelKey: string,
  state: ModelStatusObservation["state"],
  observedAt: string = new Date().toISOString(),
  reason?: string,
): ModelAssessmentSnapshot {
  const observation: ModelStatusObservation = {
    state,
    observedAt,
    ...(reason
      ? { reason: reason.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, MAX_MODEL_AVAILABILITY_REASON_LENGTH) }
      : {}),
  };
  return {
    ...assessment,
    modelStatus: { ...assessment.modelStatus, [modelKey]: observation },
  };
}

/**
 * Carry runtime availability markers from the previously saved snapshot into a
 * freshly submitted audit. Markers are runtime evidence, not audit conclusions,
 * so a new web audit must not silently launder them away.
 */
export function preserveModelAvailability(
  previous: ModelAssessmentSnapshot | undefined,
  next: ModelAssessmentSnapshot,
): ModelAssessmentSnapshot {
  if (!previous?.modelAvailability) return next;
  const merged = { ...previous.modelAvailability };
  for (const [key, marker] of Object.entries(next.modelAvailability ?? {})) {
    const previousMarker = merged[key];
    if (!previousMarker || Date.parse(marker.observedAt) >= Date.parse(previousMarker.observedAt)) merged[key] = marker;
  }
  const statusMerged = { ...(previous.modelStatus ?? {}) };
  for (const [key, status] of Object.entries(next.modelStatus ?? {})) {
    const previousStatus = statusMerged[key];
    if (!previousStatus || Date.parse(status.observedAt) >= Date.parse(previousStatus.observedAt)) statusMerged[key] = status;
  }
  return { ...next, modelAvailability: merged, modelStatus: statusMerged };
}

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
          "For subscription or quota-bearing plans, add per-model billing entries with provider/id keys classifying marginalCostClass by quota burn rate: token plans carry periodic quotas, so flagship models are not as cheap as light ones.",
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
