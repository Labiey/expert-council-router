import { buildCouncilPlan, classifyTask, modelInventoryFingerprint } from "./council.js";
import {
  type CouncilConfig,
  getModelProfile,
  mergeModelProfiles,
  parseCouncilConfig,
  parseModelAssessmentSnapshot,
} from "./config.js";
import { decideEscalation } from "./escalation.js";
import { classifyAvailabilityEvidence } from "./failures.js";
import { failureTypeForResult, indicatesModelUnavailable } from "./failures.js";
import {
  compositionByName,
  compositionMenu,
  compositionPools,
  compositionRolesSummary,
  parseCompositionDocument,
  pruneCompositionDocument,
  resolveCompositionForSession,
  sanitizeCompositionModelKey,
} from "./compositions.js";
import {
  activeModelAvailability,
  evaluateModelAssessment,
  modelAvailabilityWarnings,
  preserveModelAvailability,
  withModelAvailabilityMarker,
  withModelStatus,
} from "./model-assessment.js";
import { listRoles } from "./roles.js";
import { parseRoutePolicyDocument, pruneRoutePolicyDocument, resolveEffectivePolicy, resolveProviderLimits, DEFAULT_PROVIDER_LIMITS } from "./route-policy.js";
import { effectiveCostMultiplier, rankModels, resolveBillingEntry, routePolicyExcludes } from "./routing.js";
import { MemoryTelemetryStore } from "./telemetry.js";
import { detectBreach, instantiateLedger, providerUsage } from "./usage-caps.js";
import type {
  BuildCouncilRequest,
  BillingPolicyEntry,
  CouncilPlan,
  CouncilStateOptions,
  CouncilStateSnapshot,
  CouncilStatus,
  CompositionDocument,
  CompositionPools,
  DelegationHandle,
  DelegationRequest,
  EscalationRequest,
  ExpertCouncil,
  ExpertCleanupResult,
  ExpertFeedbackRequest,
  ExpertFeedbackResult,
  ExpertOutcome,
  ExpertResult,
  ExpertResultLookup,
  ExpertWaitRequest,
  ExpertWaitResult,
  ExpertRuntime,
  ExecutionAttemptSnapshot,
  ExecutionStateSnapshot,
  FailureType,
  ModelAssessmentSnapshot,
  ResourceInventory,
  RuntimeBillingDiscovery,
  RoutingConstraints,
  TelemetryStore,
  AbortExecutionRequest,
  AbortExecutionResult,
  ExecutionProgress,
  RoutePolicyDocument,
  RoutePolicyEntry,
  AvailableModel,
  AvailabilityMarkerKind,
  ProviderLimits,
  ProviderLimitsView,
  UsageLedger,
} from "./types.js";

type ExecutionState = ExecutionStateSnapshot;

function executionId(): string {
  return `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseModelKey(key: string): { provider: string; id: string } {
  const [provider, ...parts] = key.split("/");
  return { provider: provider ?? "unknown", id: parts.join("/") };
}

function approximateUsage(result: ExpertResult): ExpertOutcome["approximateUsage"] | undefined {
  const raw = result.executionMetadata?.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const number = (key: string): number | undefined =>
    typeof usage[key] === "number" && Number.isFinite(usage[key]) ? Math.max(0, usage[key]) : undefined;
  const normalized = {
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    cacheReadTokens: number("cacheReadTokens"),
    cacheWriteTokens: number("cacheWriteTokens"),
    estimatedCost: number("estimatedCost"),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

function boundedFailureSummary(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, 500);
}

/**
 * Build the bounded priorFailure summary handed to a retry. When the escalation
 * decision produced a correctedInstruction, append it so the retry receives the
 * corrective guidance instead of only the raw failure text. The combined value
 * is sanitized and truncated to the same 500-character budget as other attempt
 * summaries.
 */
function priorFailureSummary(summary: string, correctedInstruction?: string): string {
  if (!correctedInstruction) return boundedFailureSummary(summary);
  // Reserve room for the corrective guidance so the 500-character budget never
  // truncates it away behind a long raw failure summary.
  const instruction = boundedFailureSummary(correctedInstruction);
  const head = boundedFailureSummary(summary).slice(0, Math.max(0, 500 - instruction.length - 3));
  return `${head} | ${instruction}`;
}

function constraintsWithAssessment(
  constraints: RoutingConstraints | undefined,
  assessment: ModelAssessmentSnapshot | undefined,
  runtimeCapabilities?: Awaited<ReturnType<ExpertRuntime["getCapabilities"]>>,
  runtimeBilling: Record<string, BillingPolicyEntry> = {},
): RoutingConstraints {
  const audited = assessment?.models ?? {};
  const explicit = constraints?.modelOverrides ?? {};
  const keys = new Set([...Object.keys(audited), ...Object.keys(explicit)]);
  const modelOverrides = Object.fromEntries(
    [...keys].map((key) => [key, mergeModelProfiles(audited[key], explicit[key])]),
  );
  return {
    ...constraints,
    ...(runtimeCapabilities ? { runtimeCapabilities } : {}),
    ...(keys.size ? { modelOverrides } : {}),
    ...(
      Object.keys(runtimeBilling).length || assessment?.billing || constraints?.billingOverrides
        ? { billingOverrides: { ...runtimeBilling, ...assessment?.billing, ...constraints?.billingOverrides } }
        : {}
    ),
    ...(
      Object.keys(activeModelAvailability(assessment)).length || constraints?.modelAvailability
        ? { modelAvailability: { ...activeModelAvailability(assessment), ...constraints?.modelAvailability } }
        : {}
    ),
  };
}

export class ExpertCouncilService implements ExpertCouncil {
  readonly config: CouncilConfig;
  private readonly plans = new Map<string, CouncilPlan>();
  private readonly executions = new Map<string, ExecutionState>();
  private readonly results = new Map<string, ExpertResult>();
  private readonly executionPromises = new Map<string, Promise<ExpertResult>>();
  private routePolicyDoc: RoutePolicyDocument | undefined;
  private routePolicyWarning: string | undefined;
  private compositionsDoc: CompositionDocument | undefined;
  private compositionsWarning: string | undefined;
  private modelAssessment?: ModelAssessmentSnapshot;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: ExpertRuntime,
    config: unknown = {},
    private readonly telemetry: TelemetryStore = new MemoryTelemetryStore(),
    private readonly stateOptions: CouncilStateOptions = {},
  ) {
    this.config = parseCouncilConfig(config);
    const initial = stateOptions.initialState;
    if (initial?.version === 1) {
      this.modelAssessment = initial.modelAssessment;
      for (const plan of initial.plans) this.plans.set(plan.id, plan);
      for (const execution of initial.executions) {
        const restored = {
          ...execution,
          ...(execution.attemptHistory ? { attemptHistory: execution.attemptHistory.map((attempt) => ({ ...attempt })) } : {}),
        };
        if (restored.status === "running") {
          restored.status = "failed";
          restored.finishedAt = new Date().toISOString();
          const activeAttempt = restored.attemptHistory?.findLast((attempt) => attempt.status === "running");
          if (activeAttempt) {
            activeAttempt.status = "failed";
            activeAttempt.finishedAt = restored.finishedAt;
            activeAttempt.failureType = "provider_error";
            activeAttempt.summary = "Expert execution was interrupted by a host process restart.";
          }
          this.results.set(restored.id, {
            status: "failed",
            role: restored.role,
            model: restored.model ?? "unassigned",
            summary: "Expert execution was interrupted by a host process restart and cannot be resumed.",
            executionMetadata: {
              executionId: restored.id,
              attempts: restored.attempts,
              failureType: "provider_error",
            },
          });
        }
        this.executions.set(restored.id, restored);
      }
      for (const entry of initial.results) {
        if (!this.results.has(entry.executionId)) this.results.set(entry.executionId, entry.result);
      }
      void this.persistState().catch(() => undefined);
    }
  }

  private snapshot(): CouncilStateSnapshot {
    return {
      version: 1,
      plans: [...this.plans.values()],
      executions: [...this.executions.values()].map((execution) => ({
        ...execution,
        ...(execution.attemptHistory ? { attemptHistory: execution.attemptHistory.map((attempt) => ({ ...attempt })) } : {}),
      })),
      results: [...this.results.entries()].map(([executionId, result]) => ({ executionId, result })),
      ...(this.modelAssessment ? { modelAssessment: this.modelAssessment } : {}),
    };
  }

  private persistState(replaceModelAssessment = false): Promise<void> {
    if (!this.stateOptions.persistence) return Promise.resolve();
    const snapshot = this.snapshot();
    this.persistenceQueue = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.stateOptions.persistence!.save(snapshot, { replaceModelAssessment }));
    return this.persistenceQueue;
  }

  async inspectResources(options?: { sessionKey?: string }): Promise<ResourceInventory> {
    await this.refreshSharedAssessment();
    const sessionKey = options?.sessionKey ?? "default";
    await this.refreshRoutePolicy();
    await this.refreshCompositions();
    const [models, skills, runtimeBilling] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.runtime.listSkills(),
      this.runtime.listProviderBilling?.() ?? Promise.resolve<Record<string, RuntimeBillingDiscovery>>({}),
    ]);
    // Read capabilities after resource discovery so runtime adapters can expose
    // any discovery degradation recorded during this inspection.
    const runtimeCapabilities = await this.runtime.getCapabilities();
    const configuredUnavailable = Object.keys(this.config.profiles.models).filter(
      (key) => !models.some((model) => `${model.provider}/${model.id}` === key),
    );
    const assessedUnavailable = Object.keys(this.modelAssessment?.models ?? {}).filter(
      (key) => !models.some((model) => `${model.provider}/${model.id}` === key),
    );
    const runtimeBillingPolicies = Object.fromEntries(
      Object.entries(runtimeBilling).map(([provider, discovery]) => [provider, discovery.policy]),
    );
    const billing = {
      ...runtimeBillingPolicies,
      ...this.modelAssessment?.billing,
      ...this.config.billing.providers,
    };
    const billingSources = Object.fromEntries(
      Object.keys(billing).map((provider) => {
        if (this.config.billing.providers[provider]) {
          return [provider, { source: "user-config" as const, reason: "Explicit user billing configuration is authoritative." }];
        }
        if (this.modelAssessment?.billing?.[provider]) {
          return [provider, { source: "model-assessment" as const, reason: "Verified by the saved Main Agent assessment." }];
        }
        const discovery = runtimeBilling[provider];
        return [provider, {
          source: discovery?.source ?? "unverified",
          reason: discovery?.reason ?? "The runtime exposed no reliable access-method billing evidence.",
        }];
      }),
    );
    const providers = [...new Set(models.map((model) => model.provider))];
    // Subscription token plans have periodic quotas with per-model burn rates;
    // a single provider-level "very-low" hides that difference from routing.
    const blanketSubscriptionWarnings = providers
      .filter((provider) => {
        const providerModels = models.filter((model) => model.provider === provider);
        if (providerModels.length < 5) return false;
        if (billing[provider]?.billingType !== "subscription") return false;
        return !providerModels.some((model) => billing[`${provider}/${model.id}`]);
      })
      .map((provider) => `Provider ${provider} is subscription-billed but has no per-model cost classes: token plans carry periodic quotas with per-model burn rates, so add "${provider}/<model>" billing entries instead of one provider-level class.`);
    const systemEntry = this.routePolicyDoc?.system;
    const sessionEntry = this.routePolicyDoc?.sessions?.[sessionKey];
    const compositionBinding = this.compositionsDoc?.sessions?.[sessionKey]?.name;
    const compositions = this.stateOptions.readCompositions
      ? {
          ...(this.stateOptions.compositionsPath ? { compositionsPath: this.stateOptions.compositionsPath } : {}),
          compositions: (this.compositionsDoc?.compositions ?? []).map((composition) => ({
            name: composition.name,
            rolesSummary: compositionRolesSummary(composition),
          })),
          ...(compositionBinding ? { sessionBinding: compositionBinding } : {}),
        }
      : undefined;
    const providerLimits = this.stateOptions.usageLedger || this.stateOptions.readProviderLimits
      ? await this.buildProviderLimitsView(providers)
      : undefined;
    return {
      models,
      skills,
      billing,
      billingSources,
      roles: listRoles(),
      runtimeCapabilities,
      ...(this.modelAssessment ? { modelAssessment: this.modelAssessment } : {}),
      modelAssessmentStatus: evaluateModelAssessment(models, this.modelAssessment),
      ...(providerLimits ? { providerLimits } : {}),
      routePolicy: {
        sessionKey,
        effective: resolveEffectivePolicy(this.routePolicyDoc, sessionKey) ?? {},
        ...(systemEntry ? { system: systemEntry } : {}),
        ...(sessionEntry ? { session: sessionEntry } : {}),
        ...(this.stateOptions.routePolicyPath ? { sourcePath: this.stateOptions.routePolicyPath } : {}),
      },
      ...(compositions ? { compositions } : {}),
      warnings: [
        ...(this.routePolicyWarning ? [this.routePolicyWarning] : []),
        ...(this.compositionsWarning ? [this.compositionsWarning] : []),
        ...configuredUnavailable.map((key) => `Configured profile ${key} is not currently available and was ignored.`),
        ...assessedUnavailable.map((key) => `Audited model ${key} is not currently available and was ignored.`),
        ...modelAvailabilityWarnings(this.modelAssessment, models),
        ...blanketSubscriptionWarnings,
        ...providers
          .filter((provider) => (billing[provider]?.billingType ?? "unknown") === "unknown")
          .map((provider) => `Provider ${provider} billing is unknown: ${billingSources[provider]?.reason ?? "no reliable evidence"}`),
      ],
    };
  }

  async buildCouncil(request: BuildCouncilRequest): Promise<CouncilPlan> {
    await this.refreshSharedAssessment();
    const sessionKey = request.sessionKey ?? "default";
    await this.refreshRoutePolicy();
    await this.refreshCompositions();
    const [fetchedModels, aggregates, runtimeCapabilities, runtimeBilling] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.telemetry.aggregate(),
      this.runtime.getCapabilities(),
      this.runtime.listProviderBilling?.() ?? Promise.resolve<Record<string, RuntimeBillingDiscovery>>({}),
    ]);
    const models = this.filterByRoutePolicy(fetchedModels, sessionKey);
    if (models.length === 0 && resolveEffectivePolicy(this.routePolicyDoc, sessionKey)) {
      throw new Error("The route policy excludes every available model; edit route-policy.json (system or the session entry) before building a council.");
    }
    if (request.modelAssessment) {
      const submitted = parseModelAssessmentSnapshot(request.modelAssessment);
      this.modelAssessment = this.modelAssessment
        ? preserveModelAvailability(this.modelAssessment, submitted)
        : submitted;
    }
    const runtimeBillingPolicies = Object.fromEntries(
      Object.entries(runtimeBilling).map(([provider, discovery]) => [provider, discovery.policy]),
    );
    const providerExclusions = await this.computeProviderExclusions(models);
    const constraints = constraintsWithAssessment(
      { ...request.constraints, ...(Object.keys(providerExclusions).length ? { providerExclusions } : {}) },
      this.modelAssessment,
      runtimeCapabilities,
      runtimeBillingPolicies,
    );
    const hasCostPolicy = Boolean(request.constraints?.costPolicy);
    const composition = this.resolveRequestedComposition(request, sessionKey, hasCostPolicy);
    const plan = buildCouncilPlan({ ...request, constraints }, models, this.config, aggregates, composition);
    const providerExclusionWarnings = Object.values(providerExclusions).map((reason) => `Candidate excluded: ${reason}.`);
    if (providerExclusionWarnings.length) plan.warnings = [...providerExclusionWarnings, ...plan.warnings];
    if (composition && plan.experts.length === 0) {
      throw new Error(
        `Council composition "${composition.name}" cannot staff any role: every model in its pools is excluded by route policy, provider caps/concurrency, or hard constraints. Edit council-compositions.json or choose another composition.`,
      );
    }
    if (hasCostPolicy || composition || !this.stateOptions.readCompositions) {
      if (!hasCostPolicy && !composition) {
        plan.warnings = [
          "No costPolicy was supplied. Before the first council in a conversation, ask the user once whether to optimize for economy, balanced, or speed, then pass it as constraints.costPolicy and reuse the answer for later councils in this conversation.",
          ...plan.warnings,
        ];
      }
    } else {
      // Feature is wired and neither a composition nor a policy resolved: offer
      // the saved rosters plus the auto (cost-policy) option instead of a
      // reminder, and bind nothing.
      plan.compositionMenu = compositionMenu(this.compositionsDoc);
    }
    if (composition && request.composition) {
      // An explicit composition is a deliberate session choice; persist it.
      await this.stateOptions.compositionsStore?.bind(sessionKey, composition.name, new Date()).catch(() => undefined);
    } else if (hasCostPolicy) {
      // An explicit cost policy means the session opts out of compositions.
      await this.stateOptions.compositionsStore?.unbind(sessionKey, new Date()).catch(() => undefined);
    }
    this.plans.set(plan.id, plan);
    await this.persistState(Boolean(request.modelAssessment));
    return plan;
  }

  startDelegation(request: DelegationRequest): DelegationHandle {
    // The execution budget is a required part of the delegation contract: a
    // missing or out-of-range value must fail loudly instead of silently
    // falling back to a default or an immediate timeout.
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 3_600_000) {
      throw new Error("Delegation requires an explicit timeoutMs between 1000 and 3600000: set a budget from task difficulty.");
    }
    const id = executionId();
    const state: ExecutionState = {
      id,
      role: request.role,
      status: "running",
      attempts: 0,
      attemptHistory: [],
      taskCategory: classifyTask(request.task, this.config.routing.taskClassification),
      startedAt: new Date().toISOString(),
    };
    this.executions.set(id, state);
    void this.persistState().catch(() => undefined);
    const started = Date.now();
    const result = this.runDelegation(request, state, started).catch((error: unknown) => {
      const summary = error instanceof Error ? error.message : String(error);
      const activeAttempt = state.attemptHistory?.findLast((attempt) => attempt.status === "running");
      if (activeAttempt) {
        activeAttempt.status = "failed";
        activeAttempt.finishedAt = new Date().toISOString();
        activeAttempt.failureType = "unknown";
        activeAttempt.summary = boundedFailureSummary(summary);
      }
      const failed: ExpertResult = {
        status: "failed",
        role: request.role,
        model: state.model ?? "unassigned",
        summary,
        executionMetadata: {
          executionId: id,
          attempts: state.attempts,
          failureType: "unknown",
          durationMs: Date.now() - started,
        },
      };
      Object.assign(state, { status: failed.status, finishedAt: new Date().toISOString() });
      return failed;
    }).then((completed) => {
      this.results.set(id, completed);
      void this.persistState().catch(() => undefined);
      return completed;
    });
    this.executionPromises.set(id, result);
    void result.then(() => this.executionPromises.delete(id));
    return { executionId: id, result };
  }

  async delegate(request: DelegationRequest): Promise<ExpertResult> {
    return this.startDelegation(request).result;
  }

  private async runDelegation(
    request: DelegationRequest,
    state: ExecutionState,
    started: number,
  ): Promise<ExpertResult> {
    const id = state.id;
    await this.refreshSharedAssessment();
    // Evaluate mutation capability for the requested workspace: the startup
    // folder may not be a Git repository even when the target project is.
    const runtimeCapabilities = await this.runtime.getCapabilities(request.workspace);
    const [unfilteredModels, aggregates, availableSkills] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.telemetry.aggregate(),
      this.runtime.listSkills(),
    ]);
    const sessionKey = request.sessionKey ?? "default";
    await this.refreshRoutePolicy();
    await this.refreshCompositions();
    const models = this.filterByRoutePolicy(unfilteredModels, sessionKey);
    if (models.length === 0 && resolveEffectivePolicy(this.routePolicyDoc, sessionKey)) {
      return {
        status: "failed",
        role: request.role,
        model: "unassigned",
        summary: "The route policy excludes every available model; edit route-policy.json (system or the session entry) before delegating.",
        executionMetadata: { attempts: 0, durationMs: 0, executionId: "n/a" },
      };
    }
    const composition = resolveCompositionForSession(this.compositionsDoc, sessionKey);
    const rolePool = composition?.pools[request.role] ?? [];
    const pinnedKey = request.model !== undefined ? sanitizeCompositionModelKey(request.model) : undefined;
    const fail = (summary: string, failureType: FailureType, model = "unassigned"): ExpertResult => {
      const result: ExpertResult = {
        status: "failed",
        role: request.role,
        model,
        summary,
        executionMetadata: { executionId: id, attempts: 0, failureType, durationMs: Date.now() - started },
      };
      Object.assign(state, { status: result.status, finishedAt: new Date().toISOString() });
      return result;
    };
    if (request.model !== undefined && !pinnedKey) {
      return fail(`Pinned model "${request.model}" is not a valid provider/id model key.`, "missing_context");
    }
    const initialExclusions = await this.computeProviderExclusions(models, state.id);
    if (pinnedKey && !unfilteredModels.some((model) => `${model.provider}/${model.id}` === pinnedKey)) {
      return fail(
        `Pinned model "${pinnedKey}" is not in the discovered model inventory; call expert_inspect for the current model keys.`,
        "missing_context",
      );
    }
    if (pinnedKey && rolePool.length && !rolePool.includes(pinnedKey)) {
      return fail(
        `Pinned model "${pinnedKey}" is not in the composition pool for ${request.role}${composition ? ` in "${composition.name}"` : ""}: [${rolePool.join(", ")}].`,
        "permission_error",
        pinnedKey,
      );
    }
    if (pinnedKey && !models.some((model) => `${model.provider}/${model.id}` === pinnedKey)) {
      return fail(`Pinned model "${pinnedKey}" is excluded by the route policy for session "${sessionKey}".`, "permission_error", pinnedKey);
    }
    if (pinnedKey && initialExclusions[parseModelKey(pinnedKey).provider]) {
      return fail(`Pinned model "${pinnedKey}" is excluded: ${initialExclusions[parseModelKey(pinnedKey).provider]}.`, "permission_error", pinnedKey);
    }
    const roleModels = rolePool.length
      ? models.filter((model) => rolePool.includes(`${model.provider}/${model.id}`))
      : models;
    if (!pinnedKey && rolePool.length && roleModels.length === 0) {
      return fail(
        `Composition "${composition!.name}" restricts ${request.role} to [${rolePool.join(", ")}], but none are in the current inventory or route policy.`,
        "permission_error",
      );
    }
    const plan = request.councilId ? this.plans.get(request.councilId) : undefined;
    const planWarnings: string[] = [];
    const recordedExclusions = new Set<string>();
    const noteProviderExclusions = (exclusions: Record<string, string>): void => {
      for (const reason of Object.values(exclusions)) {
        if (recordedExclusions.has(reason)) continue;
        recordedExclusions.add(reason);
        planWarnings.push(`Candidate excluded: ${reason}.`);
      }
    };
    if (request.councilId && !plan) {
      planWarnings.push(`Council plan ${request.councilId} is unavailable; routing used the current inventory.`);
    }
    if (plan?.inventoryFingerprint && plan.inventoryFingerprint !== modelInventoryFingerprint(models)) {
      planWarnings.push(`Council plan ${plan.id} was built against a different model inventory; routing was refreshed.`);
    }
    const planned = plan?.experts.find((expert) => expert.role === request.role);
    noteProviderExclusions(initialExclusions);
    const routingConstraints = constraintsWithAssessment(
      { ...request.constraints, ...(Object.keys(initialExclusions).length ? { providerExclusions: initialExclusions } : {}) },
      this.modelAssessment,
      runtimeCapabilities,
    );
    const ranked = rankModels({
      models: roleModels,
      role: request.role,
      config: this.config,
      constraints: routingConstraints,
      telemetry: aggregates,
    });
    if (planned) {
      if (!ranked.candidates.some((candidate) => candidate.model === planned.model)) {
        planWarnings.push(`Planned model ${planned.model} is no longer eligible for ${request.role}; a current alternative was selected.`);
      }
      ranked.candidates.sort((a, b) => (a.model === planned.model ? -1 : b.model === planned.model ? 1 : b.score - a.score));
    }
    if (pinnedKey) {
      // A pin is exclusive: retries stay on that model and never escalate away
      // from the host's deliberate choice.
      if (!ranked.candidates.some((candidate) => candidate.model === pinnedKey)) {
        const rejected = ranked.rejected.find((candidate) => candidate.model === pinnedKey)?.rejected ?? [];
        return fail(
          `Pinned model "${pinnedKey}" is not eligible for ${request.role}${rejected.length ? `: ${rejected.join("; ")}` : "."}`,
          "permission_error",
          pinnedKey,
        );
      }
      ranked.candidates = ranked.candidates.filter((candidate) => candidate.model === pinnedKey);
    }
    if (!ranked.candidates.length) {
      const poolNote = rolePool.length && composition
        ? ` Composition "${composition.name}" restricts ${request.role} to [${rolePool.join(", ")}].`
        : "";
      const result: ExpertResult = {
        status: "failed",
        role: request.role,
        model: "unassigned",
        summary: `No eligible model satisfies the role and runtime constraints.${poolNote}`,
        risks: [...planWarnings, ...ranked.rejected.flatMap((candidate) => candidate.rejected ?? [])].slice(0, 8),
        executionMetadata: { executionId: id, attempts: 0, failureType: "permission_error", durationMs: Date.now() - started },
      };
      Object.assign(state, { status: result.status, finishedAt: new Date().toISOString() });
      return result;
    }

    const failures: EscalationRequest["previousFailures"] = [];
    const unavailableMarked: string[] = [];
    const capBreaches: string[] = [];
    let current = ranked.candidates[0]!;
    let retriesForCurrent = 0;
    let escalations = 0;
    let lastResult: ExpertResult | undefined;
    // Corrective guidance produced by the most recent escalation decision; it
    // is attached to the next attempt's priorFailure so retries act on it.
    let correctedInstruction: string | undefined;
    // Per-attempt execution budget. The host must supply an explicit timeout;
    // a timed-out attempt proves that budget was too small, so the loop scales
    // it up instead of re-running the same impossible specification.
    let currentTimeoutMs = request.timeoutMs;
    const cumulativeUsage: NonNullable<ExpertOutcome["approximateUsage"]> = {};
    const maxAttempts = this.config.retry.maxAttempts;

    while (state.attempts < maxAttempts) {
      if (state.abortRequested) {
        lastResult = {
          status: "aborted",
          role: request.role,
          model: current.model,
          summary: `Execution aborted by the Main Agent before the next attempt${state.abortReason ? `. Reason: ${state.abortReason}` : ""}; completed work is preserved.`,
        };
        break;
      }
      // Re-check provider caps and concurrency before every attempt so a
      // provider that breached a cap during this delegation is not retried.
      const liveExclusions = await this.computeProviderExclusions(models, state.id);
      noteProviderExclusions(liveExclusions);
      ranked.candidates = ranked.candidates.filter(
        (candidate) => !liveExclusions[parseModelKey(candidate.model).provider],
      );
      if (liveExclusions[parseModelKey(current.model).provider]) {
        const replacement = ranked.candidates.find(
          (candidate) => !failures.some((failure) => failure.model === candidate.model),
        );
        if (!replacement) {
          lastResult = {
            status: "failed",
            role: request.role,
            model: current.model,
            summary: `Provider ${parseModelKey(current.model).provider} is unavailable: ${liveExclusions[parseModelKey(current.model).provider]}.`,
          };
          break;
        }
        current = replacement;
        retriesForCurrent = 0;
      }
      state.attempts += 1;
      state.model = current.model;
      const attemptSnapshot: ExecutionAttemptSnapshot = {
        attempt: state.attempts,
        model: current.model,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      state.attemptHistory ??= [];
      state.attemptHistory.push(attemptSnapshot);
      void this.persistState().catch(() => undefined);
      const modelParts = parseModelKey(current.model);
      const profile = getModelProfile(this.config, modelParts.provider, modelParts.id);
      const configuredReasoning = profile.preferredReasoningByRole?.[request.role];
      const preferredReasoning = typeof configuredReasoning === "string" ? configuredReasoning : undefined;
      const member = plan?.experts.find((expert) => expert.role === request.role);
      const role = listRoles().find((definition) => definition.role === request.role)!;
      const activatableSkills = new Set(
        availableSkills
          .filter(
            (skill) =>
              skill.installed &&
              skill.enabled &&
              (skill.trusted === true || this.config.security.trustedSkills.includes(skill.name)),
          )
          .map((skill) => skill.name),
      );
      const selectedSkills = (member?.skills ?? role.skills).filter((skill) => activatableSkills.has(skill));

      lastResult = await this.runtime.executeExpert({
        executionId: id,
        role: request.role,
        task: request.task,
        model: current.model,
        tools: member?.tools ?? role.tools,
        skills: selectedSkills,
        ...((current.reasoningLevel ?? preferredReasoning)
          ? { reasoningLevel: current.reasoningLevel ?? preferredReasoning }
          : {}),
        readOnly: role.readOnly,
        ...(request.workspace ? { workspace: request.workspace } : {}),
        timeoutMs: currentTimeoutMs,
        attempt: state.attempts,
        ...(failures.length
          ? {
              priorFailure: {
                type: failures.at(-1)!.type,
                summary: priorFailureSummary(failures.at(-1)!.summary, correctedInstruction),
              },
            }
          : {}),
      });
      attemptSnapshot.status = lastResult.status;
      Object.assign(attemptSnapshot, { finishedAt: new Date().toISOString() });
      if (lastResult.status !== "success") {
        Object.assign(attemptSnapshot, {
          failureType: failureTypeForResult(lastResult),
          summary: boundedFailureSummary(lastResult.summary),
        });
      }
      await this.persistState();
      const attemptUsage = approximateUsage(lastResult);
      if (attemptUsage) {
        for (const [key, value] of Object.entries(attemptUsage)) {
          if (typeof value === "number") {
            const usageKey = key as keyof typeof cumulativeUsage;
            cumulativeUsage[usageKey] = (cumulativeUsage[usageKey] ?? 0) + value;
          }
        }
      }
      if (this.stateOptions.usageLedger) {
        // Weighted accounting: provider caps consume non-cache model tokens
        // multiplied by the attempt model's billing costMultiplier.
        const usageLedger = this.stateOptions.usageLedger;
        try {
          const provider = modelParts.provider;
          const billingProfile = mergeModelProfiles(profile, routingConstraints.modelOverrides?.[current.model]).billingProfile;
          const billing = resolveBillingEntry(this.config, routingConstraints, provider, modelParts.id, billingProfile);
          const multiplier = effectiveCostMultiplier(billing);
          const tokens = (attemptUsage?.inputTokens ?? 0) + (attemptUsage?.outputTokens ?? 0);
          const weighted = Math.ceil(tokens * multiplier);
          const now = new Date();
          const ledger = await usageLedger.record(provider, weighted, now);
          const limits = await this.providerLimitsFor(provider);
          const breach = detectBreach(ledger, provider, limits, now);
          if (breach.dailyBreached || breach.weeklyBreached) {
            const scope = breach.weeklyBreached ? "weekly" : "daily";
            const usage = providerUsage(ledger, provider, now);
            const reason = `Provider ${provider} ${scope} weighted token cap reached (day ${usage.usedToday}/${limits.dailyTokenCap}, week ${usage.usedWeek}/${limits.weeklyTokenCap}); marked until the UTC reset at ${breach.nextReset.toISOString()}.`;
            const siblings = models
              .filter((model) => model.provider === provider)
              .map((model) => `${model.provider}/${model.id}`);
            await this.markModelAvailability(current.model, reason, siblings, {
              expiresAt: breach.nextReset.toISOString(),
              kind: "quota-exhausted",
            });
            capBreaches.push(reason);
            ranked.candidates = ranked.candidates.filter(
              (candidate) => parseModelKey(candidate.model).provider !== provider,
            );
          }
        } catch {
          // Usage accounting is best-effort; routing still records the attempt.
        }
      }

      if (lastResult.status === "success") break;
      // A Main-Agent abort is deliberate: never classify, retry, or escalate it.
      if (lastResult.status === "aborted") break;
      const failure = failureTypeForResult(lastResult);
      // Task-level blockers (missing context, permission denied) cannot be
      // fixed by another model: terminate the delegation loop and keep
      // lastResult as the terminal result — no retry, no escalation.
      if (failure === "missing_context" || failure === "permission_error") break;
      failures.push({ model: current.model, type: failure, summary: lastResult.summary });
      if (failure === "timeout") {
        // An explicitly timed-out attempt proves the budget was too small:
        // scale the next attempt's budget (bounded) instead of repeating it.
        currentTimeoutMs = Math.min(Math.round(currentTimeoutMs * 1.5), 3_600_000);
      }
      if (failure === "provider_error" && indicatesModelUnavailable(lastResult.summary) && !unavailableMarked.includes(current.model)) {
        try {
          const provider = parseModelKey(current.model).provider;
          const siblings = models
            .filter((model) => model.provider === provider && `${model.provider}/${model.id}` !== current.model)
            .map((model) => `${model.provider}/${model.id}`);
          const marked = await this.markModelAvailability(current.model, lastResult.summary, siblings);
          unavailableMarked.push(...marked.markedKeys.filter((key) => !unavailableMarked.includes(key)));
          if (marked.kind === "quota-exhausted") {
            // The whole provider's plan or balance is out: stop considering its
            // remaining candidates in this delegation immediately.
            ranked.candidates = ranked.candidates.filter((candidate) => parseModelKey(candidate.model).provider !== provider);
          }
        } catch {
          // Marker persistence is best-effort; escalation and telemetry still record the failure.
        }
      }
      const decision = decideEscalation(
        { role: request.role, task: request.task, currentModel: current.model, previousFailures: failures },
        ranked.candidates,
        this.config.retry.correctedRetriesPerModel,
      );
      correctedInstruction = decision.correctedInstruction;
      if (decision.action === "retry" && retriesForCurrent < this.config.retry.correctedRetriesPerModel) {
        retriesForCurrent += 1;
        continue;
      }
      if (decision.action === "escalate" && decision.model && escalations < this.config.retry.maxEscalations) {
        const next = ranked.candidates.find((candidate) => candidate.model === decision.model);
        if (!next) break;
        current = next;
        retriesForCurrent = 0;
        escalations += 1;
        continue;
      }
      break;
    }

    const result = lastResult ?? {
      status: "failed" as const,
      role: request.role,
      model: current.model,
      summary: "Execution ended without a runtime result.",
    };
    result.executionMetadata = {
      ...result.executionMetadata,
      executionId: id,
      attempts: state.attempts,
      durationMs: Date.now() - started,
      escalationCount: escalations,
      ...(Object.keys(cumulativeUsage).length ? { usage: cumulativeUsage } : {}),
    };
    if (planWarnings.length) result.risks = [...planWarnings, ...(result.risks ?? [])].slice(0, 20);
    if (unavailableMarked.length) {
      result.executionMetadata = { ...result.executionMetadata, unavailableModels: [...unavailableMarked] };
      const notes = unavailableMarked.map((model) =>
        `Model ${model} failed as unavailable and was marked in the persisted model assessment; routing avoids it while the marker is active.`,
      );
      result.risks = [...notes, ...(result.risks ?? [])].slice(0, 20);
    }
    if (capBreaches.length) {
      result.risks = [...capBreaches, ...(result.risks ?? [])].slice(0, 20);
    }
    Object.assign(state, { status: result.status, model: result.model, finishedAt: new Date().toISOString() });
    const parsed = parseModelKey(result.model);
    if (result.status === "success") {
      await this.recordModelStatus(result.model, "available").catch(() => undefined);
    }
    await this.telemetry.record({
      executionId: id,
      timestamp: new Date().toISOString(),
      model: parsed.id,
      provider: parsed.provider,
      role: request.role,
      taskCategory: classifyTask(request.task, this.config.routing.taskClassification),
      success: result.status === "success",
      firstPass: result.status === "success" && state.attempts === 1,
      toolErrors: failures.filter((failure) => failure.type === "tool_call_error").length,
      retryCount: Math.max(0, state.attempts - 1),
      timedOut: failures.some((failure) => failure.type === "timeout"),
      ...(result.status === "aborted" ? { aborted: true } : {}),
      escalationCount: escalations,
      attempts: Math.max(1, state.attempts),
      hostType: runtimeCapabilities.hostType,
      ...(approximateUsage(result) ? { approximateUsage: approximateUsage(result) } : {}),
    });
    return result;
  }

  /**
   * Record the current runtime status of a model into the shared assessment:
   * `available` after successful calls, `quota-exhausted` or `unavailable`
   * after classified provider failures. This lives in model-assessment.json,
   * not telemetry, so the current per-model state is readable at a glance.
   */
  private async recordModelStatus(modelKey: string, state: "available" | "quota-exhausted" | "unavailable", reason?: string): Promise<void> {
    const observedAt = new Date().toISOString();
    if (this.modelAssessment) {
      this.modelAssessment = withModelStatus(this.modelAssessment, modelKey, state, observedAt, reason);
    }
    if (this.stateOptions.persistence?.updateModelAssessment) {
      await this.stateOptions.persistence.updateModelAssessment((current) =>
        current ? withModelStatus(current, modelKey, state, observedAt, reason) : undefined,
      );
    }
  }

  /**
   * Adopt the newest shared assessment from durable storage before routing or
   * inspection. Availability markers are persisted the moment they are
   * learned, so the stored snapshot is always a superset of this instance's
   * view and concurrent Pi/Codex instances observe each other's markers
   * without a host restart.
   */
  private async refreshRoutePolicy(): Promise<void> {
    if (!this.stateOptions.readRoutePolicy) return;
    try {
      const raw = await this.stateOptions.readRoutePolicy();
      // Prune stale session entries in memory; the store owns any write-back.
      this.routePolicyDoc = raw ? pruneRoutePolicyDocument(parseRoutePolicyDocument(raw)) : undefined;
      this.routePolicyWarning = undefined;
    } catch (error) {
      this.routePolicyDoc = undefined;
      this.routePolicyWarning = `Route policy file could not be loaded and was ignored: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private filterByRoutePolicy(models: AvailableModel[], sessionKey: string): AvailableModel[] {
    const effective = resolveEffectivePolicy(this.routePolicyDoc, sessionKey);
    if (!effective) return models;
    return models.filter((model) => !routePolicyExcludes(effective, `${model.provider}/${model.id}`));
  }

  /**
   * Adopt the newest saved-compositions document. Parse/validation failures
   * surface through the inspect warning path and never block routing.
   */
  private async refreshCompositions(): Promise<void> {
    if (!this.stateOptions.readCompositions) return;
    try {
      const raw = await this.stateOptions.readCompositions();
      // Prune stale session bindings in memory; the store owns any write-back.
      this.compositionsDoc = raw ? pruneCompositionDocument(parseCompositionDocument(raw)) : undefined;
      this.compositionsWarning = undefined;
    } catch (error) {
      this.compositionsDoc = undefined;
      this.compositionsWarning = `Council compositions file could not be loaded and was ignored: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Resolution order for a build: explicit request param > session binding >
   * none. An explicit name that does not exist is a hard, actionable error.
   */
  private resolveRequestedComposition(
    request: BuildCouncilRequest,
    sessionKey: string,
    hasCostPolicy: boolean,
  ): { name: string; pools: CompositionPools } | undefined {
    if (request.composition) {
      const composition = compositionByName(this.compositionsDoc, request.composition);
      if (!composition) {
        const available = (this.compositionsDoc?.compositions ?? []).map((entry) => entry.name);
        throw new Error(
          `Unknown council composition "${request.composition}". Available compositions: ${available.length ? available.join(", ") : "(none saved)"}. Edit council-compositions.json or omit the composition parameter.`,
        );
      }
      return { name: composition.name, pools: compositionPools(composition) };
    }
    // An explicit cost policy is the session's assembly choice and wins over a
    // stale composition binding, which is unbound below.
    if (hasCostPolicy) return undefined;
    return resolveCompositionForSession(this.compositionsDoc, sessionKey);
  }

  /**
   * Provider-level routing exclusions from the persisted usage ledger and
   * per-provider limits: a breached daily/weekly cap or a saturated
   * concurrency limit removes every model of that provider from candidates.
   */
  private async computeProviderExclusions(models: AvailableModel[], excludeExecutionId?: string): Promise<Record<string, string>> {
    const usageLedger = this.stateOptions.usageLedger;
    if (!usageLedger) return {};
    let ledger: UsageLedger;
    try {
      ledger = await usageLedger.load();
    } catch {
      return {};
    }
    const limits = resolveProviderLimits(await this.readProviderLimitsDocument());
    const now = new Date();
    const running = this.runningByProvider(excludeExecutionId);
    const exclusions: Record<string, string> = {};
    for (const provider of new Set(models.map((model) => model.provider))) {
      const effective = limits[provider] ?? DEFAULT_PROVIDER_LIMITS;
      const breach = detectBreach(ledger, provider, effective, now);
      if (breach.dailyBreached || breach.weeklyBreached) {
        const scope = breach.weeklyBreached ? "weekly" : "daily";
        exclusions[provider] = `provider ${provider} ${scope} token cap reached; resets at ${breach.nextReset.toISOString()}`;
        continue;
      }
      if (effective.maxConcurrency > 0) {
        const inFlight = running.get(provider) ?? 0;
        if (inFlight >= effective.maxConcurrency) {
          exclusions[provider] = `provider ${provider} concurrency limit reached (${inFlight}/${effective.maxConcurrency} running)`;
        }
      }
    }
    return exclusions;
  }

  /** Count running executions per provider, ignoring the execution being planned. */
  private runningByProvider(excludeExecutionId?: string): Map<string, number> {
    const running = new Map<string, number>();
    for (const execution of this.executions.values()) {
      if (execution.id === excludeExecutionId) continue;
      if (execution.status !== "running" || !execution.model) continue;
      const provider = parseModelKey(execution.model).provider;
      running.set(provider, (running.get(provider) ?? 0) + 1);
    }
    return running;
  }

  private async readProviderLimitsDocument() {
    if (!this.stateOptions.readProviderLimits) return undefined;
    return await this.stateOptions.readProviderLimits().catch(() => undefined);
  }

  private async providerLimitsFor(provider: string): Promise<ProviderLimits> {
    const limits = resolveProviderLimits(await this.readProviderLimitsDocument());
    return limits[provider] ?? DEFAULT_PROVIDER_LIMITS;
  }

  private async buildProviderLimitsView(providers: string[]): Promise<ProviderLimitsView[]> {
    const usageLedger = this.stateOptions.usageLedger;
    const ledger = usageLedger
      ? await usageLedger.load().catch(() => instantiateLedger())
      : instantiateLedger();
    const limits = resolveProviderLimits(await this.readProviderLimitsDocument());
    const now = new Date();
    const running = this.runningByProvider();
    return providers.map((provider) => {
      const effective = limits[provider] ?? DEFAULT_PROVIDER_LIMITS;
      const { usedToday, usedWeek } = providerUsage(ledger, provider, now);
      return {
        provider,
        maxConcurrency: effective.maxConcurrency,
        dailyTokenCap: effective.dailyTokenCap,
        weeklyTokenCap: effective.weeklyTokenCap,
        usedToday,
        usedWeek,
        remainingDaily: Math.max(0, effective.dailyTokenCap - usedToday),
        remainingWeekly: Math.max(0, effective.weeklyTokenCap - usedWeek),
        inFlight: running.get(provider) ?? 0,
      };
    });
  }

  /** Mark provider-wide quota evidence: quota exhaustion applies to every model of the provider. */
  private async markModelAvailability(
    modelKey: string,
    reason: string,
    providerSiblings: string[] = [],
    options: { expiresAt?: string; kind?: AvailabilityMarkerKind } = {},
  ): Promise<{ kind: AvailabilityMarkerKind; markedKeys: string[] }> {
    const observedAt = new Date().toISOString();
    const kind = options.kind ?? classifyAvailabilityEvidence(reason) ?? "unavailable";
    const markedKeys: string[] = [];
    const markOne = (key: string) => {
      if (this.modelAssessment) {
        this.modelAssessment = withModelAvailabilityMarker(this.modelAssessment, key, reason, observedAt, kind, options.expiresAt);
        this.modelAssessment = withModelStatus(this.modelAssessment, key, kind, observedAt, reason);
      }
      markedKeys.push(key);
    };
    markOne(modelKey);
    if (kind === "quota-exhausted") {
      // Quota and balance are provider-account facts: one model running out
      // means every sibling model of the same provider is out too. Mark them
      // so routing stops burning attempts on the same depleted plan.
      for (const sibling of providerSiblings) markOne(sibling);
    }
    if (this.stateOptions.persistence?.updateModelAssessment) {
      await this.stateOptions.persistence.updateModelAssessment((current) => {
        if (!current) return undefined;
        let next = current;
        for (const key of markedKeys) {
          next = withModelAvailabilityMarker(next, key, reason, observedAt, kind, options.expiresAt);
          next = withModelStatus(next, key, kind, observedAt, reason);
        }
        return next;
      });
    }
    void this.persistState().catch(() => undefined);
    return { kind, markedKeys };
  }

  private async refreshSharedAssessment(): Promise<void> {
    if (!this.stateOptions.persistence?.readModelAssessment) return;
    try {
      const latest = await this.stateOptions.persistence.readModelAssessment();
      if (latest) this.modelAssessment = latest;
    } catch {
      // Keep the in-memory snapshot when the shared store is temporarily unreadable.
    }
  }


  /**
   * Deliberately stop a running expert execution. The attempt result becomes
   * `aborted` (never retried or escalated), completed work such as a mutation
   * worktree stays preserved until cleanup, and the returned progress snapshot
   * doubles as the handoff brief for a follow-up delegation.
   */
  async abortExecution(request: AbortExecutionRequest): Promise<AbortExecutionResult> {
    const state = this.executions.get(request.executionId);
    if (!state) return { executionId: request.executionId, status: "not-found", reason: request.reason };
    // A terminal core state does not guarantee the underlying expert session
    // has settled; always ask the runtime to stop any live session first so a
    // settled execution cannot leak a zombie Pi session.
    void this.runtime.abortExecution?.(request).catch(() => undefined);
    if (this.results.has(request.executionId)) {
      return { executionId: request.executionId, status: "already-finished", reason: request.reason };
    }
    state.abortRequested = true;
    state.abortReason = request.reason;
    void this.persistState().catch(() => undefined);
    let progress: ExecutionProgress | undefined;
    let status: AbortExecutionResult["status"] = "abort-requested";
    if (this.runtime.abortExecution) {
      const outcome = await this.runtime.abortExecution(request).catch(() => undefined);
      if (outcome?.status === "not-found") {
        // No live session in the runtime (e.g. between attempts): the flag above
        // stops the delegation loop before the next attempt.
        status = "abort-requested";
      } else if (outcome) {
        status = outcome.status;
        progress = outcome.progress;
      }
    }
    if (!progress) {
      progress = await this.inspectExecution(request.executionId).catch(() => undefined);
    }
    return { executionId: request.executionId, status, reason: request.reason, progress };
  }

  async inspectExecution(executionId: string): Promise<ExecutionProgress | undefined> {
    if (this.runtime.inspectExecution) {
      return await this.runtime.inspectExecution(executionId).catch(() => undefined);
    }
    return undefined;
  }

  async getResult(executionId: string): Promise<ExpertResultLookup> {
    if (!this.executions.has(executionId)) {
      return { executionId, status: "not-found" };
    }
    const result = this.results.get(executionId);
    return result
      ? { executionId, status: "completed", result }
      : { executionId, status: "running" };
  }

  async waitForResults(request: ExpertWaitRequest): Promise<ExpertWaitResult> {
    const started = Date.now();
    const executionIds = [...new Set(request.executionIds)];
    const mode = request.mode ?? "all";
    if (executionIds.length !== request.executionIds.length) {
      throw new Error("expert_wait execution IDs must be unique.");
    }
    if (executionIds.length < 1 || executionIds.length > 8) {
      throw new Error("expert_wait requires between one and eight unique execution IDs.");
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 3_600_000) {
      throw new Error("expert_wait timeoutMs must be an integer between 1000 and 3600000.");
    }

    const snapshot = (): ExpertWaitResult => {
      const completed = executionIds.filter((id) => this.results.has(id));
      const running = executionIds.filter((id) => this.executions.has(id) && !this.results.has(id));
      const notFound = executionIds.filter((id) => !this.executions.has(id));
      const conditionMet = mode === "any"
        ? completed.length > 0
        : completed.length === executionIds.length;
      return {
        status: conditionMet ? "completed" : notFound.length > 0 && running.length === 0 ? "not-found" : "timed-out",
        mode,
        completed,
        running,
        notFound,
        waitedMs: Date.now() - started,
      };
    };

    const initial = snapshot();
    if (initial.status === "completed" || initial.status === "not-found") return initial;
    const pending = initial.running
      .map((id) => this.executionPromises.get(id))
      .filter((promise): promise is Promise<ExpertResult> => promise !== undefined);
    if (pending.length === 0) return snapshot();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, request.timeoutMs);
    });
    const completion = mode === "any"
      ? Promise.race(pending).then(() => undefined)
      : Promise.all(pending).then(() => undefined);
    try {
      await Promise.race([completion, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return snapshot();
  }

  async cleanup(executionId: string): Promise<ExpertCleanupResult> {
    if (!this.executions.has(executionId)) return { executionId, status: "not-found" };
    if (!this.results.has(executionId)) {
      // Removing a live worktree under a running session would surface as a
      // model failure and trigger escalation; abort deliberately first.
      await this.abortExecution({ executionId, reason: "cleanup requested" });
      const promise = this.executionPromises.get(executionId);
      if (promise) await promise.catch(() => undefined);
    }
    if (!this.runtime.cleanupExecution) {
      return { executionId, status: "unsupported", message: "The configured expert runtime does not support cleanup." };
    }
    return { executionId, ...(await this.runtime.cleanupExecution(executionId)) };
  }

  async recordFeedback(request: ExpertFeedbackRequest): Promise<ExpertFeedbackResult> {
    const state = this.executions.get(request.executionId);
    if (!state) return { executionId: request.executionId, status: "not-found" };
    const result = this.results.get(request.executionId);
    if (!result) {
      return {
        executionId: request.executionId,
        status: "running",
        message: "Feedback can be recorded only after expert execution completes.",
      };
    }
    const existing = (await this.telemetry.list())
      .filter((outcome) => outcome.executionId === request.executionId)
      .at(-1);
    const parsed = parseModelKey(result.model);
    await this.telemetry.record({
      ...(existing ?? {
        executionId: request.executionId,
        timestamp: new Date().toISOString(),
        model: parsed.id,
        provider: parsed.provider,
        role: state.role,
        taskCategory: state.taskCategory ?? "normal",
        success: result.status === "success",
        firstPass: result.status === "success" && state.attempts === 1,
        toolErrors: result.executionMetadata?.failureType === "tool_call_error" ? 1 : 0,
        retryCount: Math.max(0, state.attempts - 1),
        timedOut: result.executionMetadata?.failureType === "timeout",
        escalationCount: result.executionMetadata?.escalationCount ?? 0,
        attempts: Math.max(1, state.attempts),
        hostType: (await this.runtime.getCapabilities()).hostType,
        ...(approximateUsage(result) ? { approximateUsage: approximateUsage(result) } : {}),
      }),
      timestamp: new Date().toISOString(),
      verificationPassed: request.verificationPassed,
    });
    return {
      executionId: request.executionId,
      status: "recorded",
      verificationPassed: request.verificationPassed,
    };
  }

  async escalate(request: EscalationRequest) {
    await this.refreshSharedAssessment();
    const [models, telemetry, runtimeCapabilities] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.telemetry.aggregate(),
      this.runtime.getCapabilities(),
    ]);
    const ranked = rankModels({
      models,
      role: request.role,
      config: this.config,
      constraints: constraintsWithAssessment(
        { ...request.constraints, allowEscalationOnly: true },
        this.modelAssessment,
        runtimeCapabilities,
      ),
      telemetry,
    });
    return decideEscalation(request, ranked.candidates, this.config.retry.correctedRetriesPerModel);
  }

  async getStatus(): Promise<CouncilStatus> {
    return {
      plans: [...this.plans.values()].map((plan) => ({
        id: plan.id,
        taskClass: plan.taskClass,
        expertCount: plan.experts.length,
        createdAt: plan.createdAt,
      })),
      executions: [...this.executions.values()].map((execution) => ({
        ...execution,
        ...(execution.attemptHistory ? { attemptHistory: execution.attemptHistory.map((attempt) => ({ ...attempt })) } : {}),
      })),
      telemetry: await this.telemetry.aggregate(),
      ...(this.modelAssessment ? { modelAssessment: this.modelAssessment } : {}),
    };
  }

  async recordOutcome(outcome: ExpertOutcome): Promise<void> {
    await this.telemetry.record(outcome);
  }
}
