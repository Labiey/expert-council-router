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
  activeModelAvailability,
  evaluateModelAssessment,
  modelAvailabilityWarnings,
  preserveModelAvailability,
  withModelAvailabilityMarker,
  withModelStatus,
} from "./model-assessment.js";
import { listRoles } from "./roles.js";
import { parseRoutePolicyDocument, pruneRoutePolicyDocument, resolveEffectivePolicy } from "./route-policy.js";
import { rankModels, routePolicyExcludes } from "./routing.js";
import { MemoryTelemetryStore } from "./telemetry.js";
import type {
  BuildCouncilRequest,
  BillingPolicyEntry,
  CouncilPlan,
  CouncilStateOptions,
  CouncilStateSnapshot,
  CouncilStatus,
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
    const systemEntry = this.routePolicyDoc?.system;
    const sessionEntry = this.routePolicyDoc?.sessions?.[sessionKey];
    return {
      models,
      skills,
      billing,
      billingSources,
      roles: listRoles(),
      runtimeCapabilities,
      ...(this.modelAssessment ? { modelAssessment: this.modelAssessment } : {}),
      modelAssessmentStatus: evaluateModelAssessment(models, this.modelAssessment),
      routePolicy: {
        sessionKey,
        effective: resolveEffectivePolicy(this.routePolicyDoc, sessionKey) ?? {},
        ...(systemEntry ? { system: systemEntry } : {}),
        ...(sessionEntry ? { session: sessionEntry } : {}),
        ...(this.stateOptions.routePolicyPath ? { sourcePath: this.stateOptions.routePolicyPath } : {}),
      },
      warnings: [
        ...(this.routePolicyWarning ? [this.routePolicyWarning] : []),
        ...configuredUnavailable.map((key) => `Configured profile ${key} is not currently available and was ignored.`),
        ...assessedUnavailable.map((key) => `Audited model ${key} is not currently available and was ignored.`),
        ...modelAvailabilityWarnings(this.modelAssessment, models),
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
    const constraints = constraintsWithAssessment(
      request.constraints,
      this.modelAssessment,
      runtimeCapabilities,
      runtimeBillingPolicies,
    );
    const plan = buildCouncilPlan({ ...request, constraints }, models, this.config, aggregates);
    if (!request.constraints?.costPolicy) {
      plan.warnings = [
        "No costPolicy was supplied. Before the first council in a conversation, ask the user once whether to optimize for economy, balanced, or speed, then pass it as constraints.costPolicy and reuse the answer for later councils in this conversation.",
        ...plan.warnings,
      ];
    }
    this.plans.set(plan.id, plan);
    await this.persistState(Boolean(request.modelAssessment));
    return plan;
  }

  startDelegation(request: DelegationRequest): DelegationHandle {
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
    const plan = request.councilId ? this.plans.get(request.councilId) : undefined;
    const planWarnings: string[] = [];
    if (request.councilId && !plan) {
      planWarnings.push(`Council plan ${request.councilId} is unavailable; routing used the current inventory.`);
    }
    if (plan?.inventoryFingerprint && plan.inventoryFingerprint !== modelInventoryFingerprint(models)) {
      planWarnings.push(`Council plan ${plan.id} was built against a different model inventory; routing was refreshed.`);
    }
    const planned = plan?.experts.find((expert) => expert.role === request.role);
    const ranked = rankModels({
      models,
      role: request.role,
      config: this.config,
      constraints: constraintsWithAssessment(request.constraints, this.modelAssessment, runtimeCapabilities),
      telemetry: aggregates,
    });
    if (planned) {
      if (!ranked.candidates.some((candidate) => candidate.model === planned.model)) {
        planWarnings.push(`Planned model ${planned.model} is no longer eligible for ${request.role}; a current alternative was selected.`);
      }
      ranked.candidates.sort((a, b) => (a.model === planned.model ? -1 : b.model === planned.model ? 1 : b.score - a.score));
    }
    if (!ranked.candidates.length) {
      const result: ExpertResult = {
        status: "failed",
        role: request.role,
        model: "unassigned",
        summary: "No eligible model satisfies the role and runtime constraints.",
        risks: [...planWarnings, ...ranked.rejected.flatMap((candidate) => candidate.rejected ?? [])].slice(0, 8),
        executionMetadata: { executionId: id, attempts: 0, failureType: "permission_error", durationMs: Date.now() - started },
      };
      Object.assign(state, { status: result.status, finishedAt: new Date().toISOString() });
      return result;
    }

    const failures: EscalationRequest["previousFailures"] = [];
    const unavailableMarked: string[] = [];
    let current = ranked.candidates[0]!;
    let retriesForCurrent = 0;
    let escalations = 0;
    let lastResult: ExpertResult | undefined;
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
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        attempt: state.attempts,
        ...(failures.length ? { priorFailure: { type: failures.at(-1)!.type, summary: failures.at(-1)!.summary } } : {}),
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

      if (lastResult.status === "success") break;
      // A Main-Agent abort is deliberate: never classify, retry, or escalate it.
      if (lastResult.status === "aborted") break;
      const failure = failureTypeForResult(lastResult);
      failures.push({ model: current.model, type: failure, summary: lastResult.summary });
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

  /** Mark provider-wide quota evidence: quota exhaustion applies to every model of the provider. */
  private async markModelAvailability(modelKey: string, reason: string, providerSiblings: string[] = []): Promise<{ kind: "unavailable" | "quota-exhausted"; markedKeys: string[] }> {
    const observedAt = new Date().toISOString();
    const kind = classifyAvailabilityEvidence(reason) ?? "unavailable";
    const markedKeys: string[] = [];
    const markOne = (key: string) => {
      if (this.modelAssessment) {
        this.modelAssessment = withModelAvailabilityMarker(this.modelAssessment, key, reason, observedAt, kind);
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
          next = withModelAvailabilityMarker(next, key, reason, observedAt, kind);
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
