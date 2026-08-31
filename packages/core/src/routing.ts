import {
  DEFAULT_CAPABILITY_PROFILE,
  getBillingEntry,
  getModelProfile,
  getRoleWeightOverrides,
  mergeModelProfiles,
  type CouncilConfig,
} from "./config.js";
import { getRole } from "./roles.js";
import { observedAdjustment } from "./telemetry.js";
import type {
  AvailableModel,
  ApiCost,
  BillingPolicyEntry,
  CapabilityDimension,
  CapabilityProfile,
  ExpertRole,
  RankedCandidate,
  RoutingConstraints,
  TelemetryAggregate,
} from "./types.js";

const COST_CLASS_SCORE = { "very-low": 10, low: 8, normal: 6, high: 3, scarce: 1 } as const;
const BILLING_TYPE_BONUS = { free: 2, subscription: 1.5, metered: 0, quota: -1, unknown: -0.5 } as const;
const PREFERENCE_BONUS = { "consume-first": 1, balanced: 0, "quality-sensitive": -0.1, "escalation-only": -2 } as const;

function clampScore(value: number): number {
  return Math.max(0, Math.min(10, value));
}

export function publishedApiCostScore(apiCost?: ApiCost): number | undefined {
  if (!apiCost) return undefined;
  const primaryPrices = [apiCost.inputPerMillion, apiCost.outputPerMillion]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const fallbackPrices = [apiCost.cacheReadPerMillion, apiCost.cacheWritePerMillion]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const prices = primaryPrices.length ? primaryPrices : fallbackPrices;
  if (!prices.length) return undefined;
  if (prices.every((value) => value === 0)) return undefined;
  const averagePerMillion = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  return Number(clampScore(10 - 2 * Math.log2(1 + averagePerMillion)).toFixed(4));
}

export function billingCostScore(entry: BillingPolicyEntry, apiCost?: ApiCost, apiPriceWeight = 0.35): number {
  const base = COST_CLASS_SCORE[entry.marginalCostClass ?? "normal"];
  const policyScore = clampScore(base + BILLING_TYPE_BONUS[entry.billingType] + PREFERENCE_BONUS[entry.usagePreference ?? "balanced"]);
  const publishedScore = publishedApiCostScore(apiCost);
  if (publishedScore === undefined || !["metered", "unknown"].includes(entry.billingType)) return policyScore;
  const weight = Math.max(0, Math.min(1, apiPriceWeight));
  return clampScore(policyScore * (1 - weight) + publishedScore * weight);
}

export function modelFamily(model: AvailableModel): string {
  if (model.family?.trim()) return model.family.trim().toLowerCase();
  const firstSegment = model.id.toLowerCase().split(/[\/:._-]/u).find(Boolean) ?? model.id.toLowerCase();
  return firstSegment.replace(/\d+$/u, "") || firstSegment;
}

function inferObjectiveCapabilities(model: AvailableModel): CapabilityProfile {
  const contextWindow = model.contextWindow ?? 0;
  const longContext = contextWindow >= 500_000 ? 8 : contextWindow >= 128_000 ? 6 : contextWindow >= 64_000 ? 5 : 4;
  return {
    reasoning: model.reasoning ? 6 : 4,
    longContext,
  };
}

function effectiveProfile(
  model: AvailableModel,
  config: CouncilConfig,
  constraints?: RoutingConstraints,
): Required<Record<CapabilityDimension, number>> & {
  disabled?: boolean;
  billingProfile?: string;
  incompatibleRoles?: ExpertRole[];
  preferredReasoningByRole?: Partial<Record<ExpertRole, string>>;
} {
  const configured = getModelProfile(config, model.provider, model.id);
  const taskOverride = constraints?.modelOverrides?.[`${model.provider}/${model.id}`];
  return {
    ...DEFAULT_CAPABILITY_PROFILE,
    ...mergeModelProfiles(DEFAULT_CAPABILITY_PROFILE, inferObjectiveCapabilities(model), configured, taskOverride),
  };
}

function hardConstraintFailures(
  model: AvailableModel,
  role: ExpertRole,
  profile: ReturnType<typeof effectiveProfile>,
  billing: BillingPolicyEntry,
  config: CouncilConfig,
  constraints?: RoutingConstraints,
): string[] {
  const definition = getRole(role);
  const failures: string[] = [];
  if (!model.available) failures.push("model is not currently callable");
  if (profile.disabled || billing.disabled) failures.push("model or billing profile is disabled");
  if (profile.incompatibleRoles?.includes(role)) failures.push(`model is configured as incompatible with ${role}`);
  if (definition.requiresMutation && constraints?.runtimeCapabilities && !constraints.runtimeCapabilities.mutation) {
    failures.push("runtime cannot provide mutation");
  }
  const minimumTool = Math.max(
    definition.minimumToolReliability ?? 0,
    role === "implementation-worker" ? config.routing.minimumWorkerToolReliability : 0,
  );
  if (profile.toolReliability < minimumTool) failures.push(`tool reliability ${profile.toolReliability} is below ${minimumTool}`);
  const minimumContext = Math.max(definition.minimumContextWindow ?? 0, constraints?.minimumContextWindow ?? 0);
  if (minimumContext && (model.contextWindow ?? 0) < minimumContext) failures.push(`context window is below ${minimumContext}`);
  if (billing.usagePreference === "escalation-only" && !constraints?.allowEscalationOnly) {
    failures.push("billing preference is escalation-only");
  }
  return failures;
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return weights;
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total]));
}

export interface RankModelsInput {
  models: AvailableModel[];
  role: ExpertRole;
  config: CouncilConfig;
  constraints?: RoutingConstraints;
  telemetry?: TelemetryAggregate[];
  selectedModels?: string[];
}

export interface RankModelsResult {
  candidates: RankedCandidate[];
  rejected: RankedCandidate[];
}

export function rankModels(input: RankModelsInput): RankModelsResult {
  const { models, role, config, constraints, telemetry = [], selectedModels = [] } = input;
  const definition = getRole(role);
  const unnormalizedWeights = { ...definition.weights, ...getRoleWeightOverrides(config, role) };
  if (constraints?.costPolicy === "economy") {
    unnormalizedWeights.costEfficiency = (unnormalizedWeights.costEfficiency ?? 0.1) * 2;
  } else if (constraints?.costPolicy === "quality") {
    unnormalizedWeights.costEfficiency = (unnormalizedWeights.costEfficiency ?? 0.1) * 0.4;
  }
  const weights = normalizeWeights(unnormalizedWeights);
  const candidates: RankedCandidate[] = [];
  const rejected: RankedCandidate[] = [];
  const selected = models.filter((model) => selectedModels.includes(`${model.provider}/${model.id}`));
  const selectedProviders = new Set(selected.map((model) => model.provider));
  const selectedFamilies = new Set(selected.map(modelFamily));

  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    const profile = effectiveProfile(model, config, constraints);
    const billingProfile = profile.billingProfile ?? model.billingProfile;
    const billing = getBillingEntry(config, model.provider, billingProfile);
    const failures = hardConstraintFailures(model, role, profile, billing, config, constraints);
    if (failures.length) {
      rejected.push({ model: key, provider: model.provider, score: 0, reasons: [], rejected: failures });
      continue;
    }

    let score = 0;
    const contributions: Array<[string, number]> = [];
    for (const [dimension, weight] of Object.entries(weights)) {
      const value = dimension === "costEfficiency"
        ? billingCostScore(billing, model.apiCost, config.routing.apiPriceWeight)
        : profile[dimension as CapabilityDimension];
      const contribution = value * weight;
      score += contribution;
      contributions.push([dimension, contribution]);
    }

    const learning = observedAdjustment(telemetry, key, role, config.routing.localLearningMaxAdjustment);
    score += learning;
    if (selectedModels.includes(key)) score -= config.routing.diversity.repeatedModelPenalty;
    const family = modelFamily(model);
    if (role === "reviewer") {
      if (selectedProviders.has(model.provider)) score -= config.routing.diversity.reviewerSameProviderPenalty;
      if (selectedFamilies.has(family)) score -= config.routing.diversity.reviewerSameFamilyPenalty;
    }

    const supported = model.supportedReasoningLevels;
    const preferred = profile.preferredReasoningByRole?.[role];
    const reasoningLevel = preferred && (!supported || supported.includes(preferred)) ? preferred : undefined;
    const reasons = contributions
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([dimension, contribution]) => `${dimension} contributed ${contribution.toFixed(2)}`);
    reasons.push(`${billing.billingType}/${billing.marginalCostClass ?? "normal"} billing`);
    const apiPriceScore = publishedApiCostScore(model.apiCost);
    if (apiPriceScore !== undefined && ["metered", "unknown"].includes(billing.billingType)) {
      reasons.push(`published API pricing contributed a ${apiPriceScore.toFixed(2)} cost score`);
    }
    if (role === "reviewer" && (selectedProviders.has(model.provider) || selectedFamilies.has(family))) {
      reasons.push("reviewer diversity penalty applied");
    }
    if (learning !== 0) reasons.push(`local outcomes adjusted score by ${learning.toFixed(2)}`);

    candidates.push({
      model: key,
      provider: model.provider,
      family,
      score: Number(score.toFixed(4)),
      reasons,
      ...(reasoningLevel ? { reasoningLevel } : {}),
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  rejected.sort((a, b) => a.model.localeCompare(b.model));
  return { candidates, rejected };
}
