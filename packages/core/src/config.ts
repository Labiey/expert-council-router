import { z } from "zod";
import {
  CAPABILITY_DIMENSIONS,
  type BillingPolicyEntry,
  type CapabilityDimension,
  type ExpertRole,
  type ModelProfile,
  type ResolvedModelProfile,
} from "./types.js";

const score = z.number().min(0).max(10);
const capabilityFields = {
  reasoning: score.nullable().optional(),
  planning: score.nullable().optional(),
  architecture: score.nullable().optional(),
  coding: score.nullable().optional(),
  debugging: score.nullable().optional(),
  review: score.nullable().optional(),
  longContext: score.nullable().optional(),
  toolReliability: score.nullable().optional(),
  bashReliability: score.nullable().optional(),
  autonomousExecution: score.nullable().optional(),
  speed: score.nullable().optional(),
};

export const expertRoleSchema = z.enum([
  "planner",
  "scout",
  "architecture-oracle",
  "implementation-worker",
  "debugger",
  "reviewer",
  "verifier",
]);

export const billingEntrySchema = z.object({
  billingType: z.enum(["subscription", "metered", "quota", "free", "unknown"]),
  marginalCostClass: z.enum(["very-low", "low", "normal", "high", "scarce"]).optional(),
  usagePreference: z.enum(["consume-first", "balanced", "quality-sensitive", "escalation-only"]).optional(),
  disabled: z.boolean().optional(),
});

export const modelProfileSchema = z.object({
  ...capabilityFields,
  disabled: z.boolean().optional(),
  billingProfile: z.string().min(1).optional(),
  preferredReasoningByRole: z.record(expertRoleSchema, z.string().min(1).nullable()).optional(),
  incompatibleRoles: z.array(expertRoleSchema).optional(),
});

const weightSchema = z.record(
  z.enum([
    "reasoning",
    "planning",
    "architecture",
    "coding",
    "debugging",
    "review",
    "longContext",
    "toolReliability",
    "bashReliability",
    "autonomousExecution",
    "speed",
    "costEfficiency",
  ]),
  z.number().min(0),
);

export const councilConfigSchema = z.object({
  billing: z.object({ providers: z.record(z.string(), billingEntrySchema).default({}) }).default({ providers: {} }),
  profiles: z.object({ models: z.record(z.string(), modelProfileSchema).default({}) }).default({ models: {} }),
  routing: z
    .object({
      roleWeights: z.partialRecord(expertRoleSchema, weightSchema).default({}),
      maxExperts: z.number().int().min(1).max(8).default(4),
      minimumWorkerToolReliability: z.number().min(0).max(10).default(4),
      localLearningMaxAdjustment: z.number().min(0).max(2).default(1),
      apiPriceWeight: z.number().min(0).max(1).default(0.35),
      diversity: z.object({
        repeatedModelPenalty: z.number().min(0).max(5).default(0.35),
        reviewerSameProviderPenalty: z.number().min(0).max(5).default(0.25),
        reviewerSameFamilyPenalty: z.number().min(0).max(5).default(0.5),
      }).default({
        repeatedModelPenalty: 0.35,
        reviewerSameProviderPenalty: 0.25,
        reviewerSameFamilyPenalty: 0.5,
      }),
      taskClassification: z.object({
        tinyMaxWords: z.number().int().min(1).max(50).default(8),
        tinyMaxCjkChars: z.number().int().min(1).max(100).default(18),
        complexMinWords: z.number().int().min(10).max(500).default(35),
        complexMinCjkChars: z.number().int().min(20).max(1_000).default(60),
        complexSignalThreshold: z.number().int().min(1).max(10).default(2),
      }).default({
        tinyMaxWords: 8,
        tinyMaxCjkChars: 18,
        complexMinWords: 35,
        complexMinCjkChars: 60,
        complexSignalThreshold: 2,
      }),
    })
    .default({
      roleWeights: {},
      maxExperts: 4,
      minimumWorkerToolReliability: 4,
      localLearningMaxAdjustment: 1,
      apiPriceWeight: 0.35,
      diversity: {
        repeatedModelPenalty: 0.35,
        reviewerSameProviderPenalty: 0.25,
        reviewerSameFamilyPenalty: 0.5,
      },
      taskClassification: {
        tinyMaxWords: 8,
        tinyMaxCjkChars: 18,
        complexMinWords: 35,
        complexMinCjkChars: 60,
        complexSignalThreshold: 2,
      },
    }),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(8).default(3),
      maxEscalations: z.number().int().min(0).max(5).default(2),
      correctedRetriesPerModel: z.number().int().min(0).max(2).default(1),
    })
    .default({ maxAttempts: 3, maxEscalations: 2, correctedRetriesPerModel: 1 }),
  security: z
    .object({
      workspaceStrategy: z.enum(["auto", "git-worktree", "bounded-in-place", "read-only"]).default("auto"),
      allowInPlaceMutations: z.boolean().default(false),
      allowedWorkspaceRoots: z.array(z.string().min(1)).default([]),
      trustedSkills: z.array(z.string().min(1)).default([]),
      worktreeRetentionMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60_000).default(24 * 60 * 60_000),
    })
    .default({
      workspaceStrategy: "auto",
      allowInPlaceMutations: false,
      allowedWorkspaceRoots: [],
      trustedSkills: [],
      worktreeRetentionMs: 24 * 60 * 60_000,
    }),
});

export type CouncilConfig = z.infer<typeof councilConfigSchema>;

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid Expert Council configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function parseCouncilConfig(input: unknown = {}): CouncilConfig {
  const result = councilConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`),
    );
  }
  return result.data;
}

export const DEFAULT_CAPABILITY_PROFILE: Required<Record<CapabilityDimension, number>> = {
  reasoning: 5,
  planning: 5,
  architecture: 5,
  coding: 5,
  debugging: 5,
  review: 5,
  longContext: 5,
  toolReliability: 5,
  bashReliability: 5,
  autonomousExecution: 4,
  speed: 5,
};

export function mergeModelProfiles(...profiles: Array<ModelProfile | undefined>): ResolvedModelProfile {
  const merged: ResolvedModelProfile = {};
  for (const profile of profiles) {
    if (!profile) continue;
    for (const dimension of CAPABILITY_DIMENSIONS) {
      const value = profile[dimension];
      if (value === null) delete merged[dimension];
      else if (value !== undefined) merged[dimension] = value;
    }
    if (profile.disabled !== undefined) merged.disabled = profile.disabled;
    if (profile.billingProfile !== undefined) merged.billingProfile = profile.billingProfile;
    if (profile.incompatibleRoles !== undefined) merged.incompatibleRoles = [...profile.incompatibleRoles];
    if (profile.preferredReasoningByRole) {
      const reasoning = { ...merged.preferredReasoningByRole };
      for (const [role, value] of Object.entries(profile.preferredReasoningByRole)) {
        if (value === null) delete reasoning[role as ExpertRole];
        else if (value !== undefined) reasoning[role as ExpertRole] = value;
      }
      merged.preferredReasoningByRole = reasoning;
    }
  }
  return merged;
}

export function getBillingEntry(config: CouncilConfig, provider: string, billingProfile?: string): BillingPolicyEntry {
  const key = billingProfile ?? provider;
  return config.billing.providers[key] ?? {
    billingType: "unknown",
    marginalCostClass: "normal",
    usagePreference: "balanced",
  };
}

export function getModelProfile(config: CouncilConfig, provider: string, id: string): ModelProfile {
  return config.profiles.models[`${provider}/${id}`] ?? {};
}

export function getRoleWeightOverrides(
  config: CouncilConfig,
  role: ExpertRole,
): Partial<Record<CapabilityDimension | "costEfficiency", number>> {
  return config.routing.roleWeights[role] ?? {};
}
