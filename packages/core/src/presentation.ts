import type { CouncilPlan, ExpertEventKind, ExpertObservabilityEvent, ResourceInventory } from "./types.js";

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
      realtimeInteraction: inventory.runtimeCapabilities.realtimeInteraction,
      dynamicToolPermissions: inventory.runtimeCapabilities.dynamicToolPermissions,
      mutation: inventory.runtimeCapabilities.mutation,
      workspaceIsolation: inventory.runtimeCapabilities.workspaceIsolation,
      ...(inventory.runtimeCapabilities.sourceWorkspaceDirty !== undefined
        ? { sourceWorkspaceDirty: inventory.runtimeCapabilities.sourceWorkspaceDirty }
        : {}),
      ...(inventory.runtimeCapabilities.workspaceProvisioning
        ? { workspaceProvisioning: inventory.runtimeCapabilities.workspaceProvisioning }
        : {}),
      ...(inventory.runtimeCapabilities.eventStream
        ? { eventStream: inventory.runtimeCapabilities.eventStream }
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
      // `routePolicy` is required on ResourceInventory, so it is read directly. The
      // optional chaining here implied a null case the type never allowed, and a suite
      // nobody typechecked could not notice the difference (defect #27).
      sessionKey: inventory.routePolicy.sessionKey ?? "default",
      effective: inventory.routePolicy.effective ?? {},
      ...(inventory.routePolicy.system ? { system: inventory.routePolicy.system } : {}),
      ...(inventory.routePolicy.session ? { session: inventory.routePolicy.session } : {}),
      ...(inventory.routePolicy.sourcePath ? { sourcePath: inventory.routePolicy.sourcePath } : {}),
    },
    ...(inventory.compositions ? { compositions: inventory.compositions } : {}),
    ...(inventory.operatorConfig ? { operatorConfig: inventory.operatorConfig } : {}),
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

/**
 * Every event kind, enumerated through a `Record` over the union so that adding a kind to
 * `ExpertEventKind` without listing it here fails the build rather than falling through to
 * the renderer's default branch. Defect #21 was exactly that class: `attention` had no
 * case, so live warnings reached an operator's terminal as a bare word with the sentence
 * and the numbers dropped on the floor.
 */
const EVENT_KIND_COVERAGE: Record<ExpertEventKind, true> = {
  started: true,
  tool_started: true,
  tool_finished: true,
  assistant_text: true,
  attention: true,
  interaction_opened: true,
  interaction_answered: true,
  stopped: true,
  completed: true,
  failed: true,
  stream_truncated: true,
  delegation_final: true,
};

/** The full set of renderable event kinds, for tests that must stay in step with it. */
export const EXPERT_EVENT_KINDS: readonly ExpertEventKind[] = Object.keys(EVENT_KIND_COVERAGE) as ExpertEventKind[];

/**
 * Render one expert event as a single terminal line. The clamp at the end is deliberate:
 * text fields are bounded where the runtime writes them, but a hand-edited, truncated, or
 * future-versioned stream must never push a second line into an operator's window and
 * desynchronise it from the rest of the tail. Deliberately ANSI-free and single-line:
 * it has to survive Windows pipes, redirection to a file, and interleaving with other
 * sources without corrupting output.
 */
export function formatExpertEvent(event: ExpertObservabilityEvent): string {
  return formatExpertEventLine(event)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatExpertEventLine(event: ExpertObservabilityEvent): string {
  const clock = typeof event.t === "string" && event.t.length >= 19 ? event.t.slice(11, 19) : "--:--:--";
  const head = `${clock} [${event.role}${event.model ? ` ${event.model}` : ""}${typeof event.attempt === "number" && event.attempt > 1 ? ` #${event.attempt}` : ""}]`;
  switch (event.kind) {
    case "started":
      return `${head} started`;
    case "tool_started":
      return `${head} tool ${event.tool ?? "?"}${event.argsSummary ? ` (${event.argsSummary})` : ""}`;
    case "tool_finished":
      return `${head} tool ${event.tool ?? "?"} ${event.ok === false ? "FAILED" : "ok"}`;
    case "assistant_text":
      return `${head} says: ${event.text ?? ""}`;
    case "attention": {
      // A struggle warning is the one event an operator acts on, so it must arrive with
      // its detail and its numbers rather than as a bare kind name.
      const facts = [
        typeof event.budgetFractionUsed === "number" ? `budget ${Math.round(event.budgetFractionUsed * 100)}%` : undefined,
        typeof event.toolErrors === "number" ? `tool errors ${event.toolErrors}/${event.toolCalls ?? 0}` : undefined,
        event.nudgedExpert ? "expert steered" : undefined,
      ].filter((fact): fact is string => fact !== undefined);
      return `${head} WARNING: ${event.text ?? "struggle detected"}${facts.length ? ` (${facts.join(", ")})` : ""}`;
    }
    case "delegation_final":
      return `${head} delegation finished (no further attempts)`;
    case "interaction_opened":
      return `${head} WAITING FOR HOST: ${event.text ?? ""}`;
    case "interaction_answered":
      return `${head} host answered: ${event.text ?? ""}`;
    case "stopped":
      return `${head} stopped by expert: ${event.status ?? "partial"}${event.failureType ? ` (${event.failureType})` : ""}`;
    case "completed":
    case "failed": {
      const duration = typeof event.durationMs === "number" ? ` in ${Math.round(event.durationMs / 1000)}s` : "";
      return `${head} ${event.kind}: ${event.status ?? ""}${event.failureType ? ` (${event.failureType})` : ""}${duration}`;
    }
    case "stream_truncated":
      return `${head} stream truncated: ${event.text ?? "further events dropped"}`;
    default:
      return `${head} ${event.kind}`;
  }
}
