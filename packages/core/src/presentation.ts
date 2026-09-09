import type { CouncilPlan, ResourceInventory } from "./types.js";

export type PresentationDetail = "compact" | "full";

export function presentResourceInventory(inventory: ResourceInventory, detail: PresentationDetail = "compact") {
  if (detail === "full") return inventory;

  const providers = new Map<string, {
    provider: string;
    modelCount: number;
    reasoningModelCount: number;
    billingType: string;
    billingSource?: string;
    billingReason?: string;
  }>();
  for (const model of inventory.models) {
    const current = providers.get(model.provider) ?? {
      provider: model.provider,
      modelCount: 0,
      reasoningModelCount: 0,
      billingType: inventory.billing[model.billingProfile ?? model.provider]?.billingType ?? "unknown",
      ...(inventory.billingSources?.[model.billingProfile ?? model.provider]
        ? {
            billingSource: inventory.billingSources[model.billingProfile ?? model.provider]!.source,
            billingReason: inventory.billingSources[model.billingProfile ?? model.provider]!.reason,
          }
        : {}),
    };
    current.modelCount += 1;
    if (model.reasoning) current.reasoningModelCount += 1;
    providers.set(model.provider, current);
  }

  return {
    summary: {
      modelCount: inventory.models.length,
      providerCount: providers.size,
      enabledSkillCount: inventory.skills.filter((skill) => skill.installed && skill.enabled).length,
      roleCount: inventory.roles.length,
    },
    providers: [...providers.values()],
    roles: inventory.roles.map((role) => ({ role: role.role, readOnly: role.readOnly })),
    skills: inventory.skills
      .filter((skill) => skill.installed && skill.enabled)
      .map((skill) => skill.name),
    runtimeCapabilities: {
      hostType: inventory.runtimeCapabilities.hostType,
      modelDiscovery: inventory.runtimeCapabilities.modelDiscovery,
      hardToolRestriction: inventory.runtimeCapabilities.hardToolRestriction,
      skillOverride: inventory.runtimeCapabilities.skillOverride,
      subagentBackend: inventory.runtimeCapabilities.subagentBackend,
      mutation: inventory.runtimeCapabilities.mutation,
      workspaceIsolation: inventory.runtimeCapabilities.workspaceIsolation,
      ...(inventory.runtimeCapabilities.sourceWorkspaceDirty !== undefined
        ? { sourceWorkspaceDirty: inventory.runtimeCapabilities.sourceWorkspaceDirty }
        : {}),
      ...(inventory.runtimeCapabilities.workspaceProvisioning
        ? { workspaceProvisioning: inventory.runtimeCapabilities.workspaceProvisioning }
        : {}),
      limitations: inventory.runtimeCapabilities.limitations,
    },
    modelAssessment: inventory.modelAssessmentStatus?.status === "required"
      ? {
          status: "required" as const,
          reason: inventory.modelAssessmentStatus.reason,
          assessedAt: inventory.modelAssessmentStatus.assessedAt,
          maxAgeDays: inventory.modelAssessmentStatus.maxAgeDays,
          requiredModels: inventory.modelAssessmentStatus.requiredModels,
          researchModels: inventory.modelAssessmentStatus.researchModels,
          missingModels: inventory.modelAssessmentStatus.missingModels,
          unavailableAssessedModels: inventory.modelAssessmentStatus.unavailableAssessedModels,
          instructions: inventory.modelAssessmentStatus.instructions,
        }
      : inventory.modelAssessment
        ? {
            status: "current" as const,
            asOf: inventory.modelAssessment.asOf,
            refreshAfter: inventory.modelAssessmentStatus?.refreshAfter,
            modelCount: Object.keys(inventory.modelAssessment.models).length,
            billingProviderCount: Object.keys(inventory.modelAssessment.billing ?? {}).length,
            sources: inventory.modelAssessment.sources,
            ...(inventory.modelAssessment.summary ? { summary: inventory.modelAssessment.summary } : {}),
          }
        : {
            status: "required" as const,
            reason: "missing" as const,
            refreshHint: "A current web-audited modelAssessment is required before expert_build can assemble a council.",
          },
    routePolicy: {
      sessionKey: inventory.routePolicy?.sessionKey ?? "default",
      effective: inventory.routePolicy?.effective ?? {},
      ...(inventory.routePolicy?.system ? { system: inventory.routePolicy.system } : {}),
      ...(inventory.routePolicy?.session ? { session: inventory.routePolicy.session } : {}),
      ...(inventory.routePolicy?.sourcePath ? { sourcePath: inventory.routePolicy.sourcePath } : {}),
    },
    ...(inventory.compositions ? { compositions: inventory.compositions } : {}),
    ...(inventory.providerLimits ? { providerLimits: inventory.providerLimits } : {}),
    warnings: inventory.warnings,
    detail: "compact" as const,
    fullDetailHint: "Call expert_inspect with detail='full' only when exact model metadata is required.",
  };
}

export function presentCouncilPlan(plan: CouncilPlan, detail: PresentationDetail = "compact") {
  if (detail === "full") return plan;
  return {
    id: plan.id,
    taskClass: plan.taskClass,
    ...(plan.costPolicy ? { costPolicy: plan.costPolicy } : {}),
    ...(plan.composition ? { composition: plan.composition } : {}),
    ...(plan.compositionMenu ? { compositionMenu: plan.compositionMenu } : {}),
    experts: plan.experts.map((expert) => ({
      role: expert.role,
      model: expert.model,
      reason: expert.reason.slice(0, 2),
      readOnly: expert.readOnly,
      ...(expert.reasoningLevel ? { reasoningLevel: expert.reasoningLevel } : {}),
    })),
    warnings: plan.warnings,
    detail: "compact" as const,
    fullDetailHint: "Call expert_build with detail='full' only when alternatives, scores, tools, or skills are required.",
  };
}
