import { buildCouncilPlan, classifyTask, modelInventoryFingerprint } from "./council.js";
import {
  type CouncilConfig,
  getModelProfile,
  mergeModelProfiles,
  parseCouncilConfig,
  parseModelAssessmentSnapshot,
} from "./config.js";
import { decideEscalation } from "./escalation.js";
import { failureTypeForResult } from "./failures.js";
import { evaluateModelAssessment } from "./model-assessment.js";
import { listRoles } from "./roles.js";
import { rankModels } from "./routing.js";
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
  };
}

export class ExpertCouncilService implements ExpertCouncil {
  readonly config: CouncilConfig;
  private readonly plans = new Map<string, CouncilPlan>();
  private readonly executions = new Map<string, ExecutionState>();
  private readonly results = new Map<string, ExpertResult>();
  private readonly executionPromises = new Map<string, Promise<ExpertResult>>();
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

  async inspectResources(): Promise<ResourceInventory> {
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
    return {
      models,
      skills,
      billing,
      billingSources,
      roles: listRoles(),
      runtimeCapabilities,
      ...(this.modelAssessment ? { modelAssessment: this.modelAssessment } : {}),
      modelAssessmentStatus: evaluateModelAssessment(models, this.modelAssessment),
      warnings: [
        ...configuredUnavailable.map((key) => `Configured profile ${key} is not currently available and was ignored.`),
        ...assessedUnavailable.map((key) => `Audited model ${key} is not currently available and was ignored.`),
        ...providers
          .filter((provider) => (billing[provider]?.billingType ?? "unknown") === "unknown")
          .map((provider) => `Provider ${provider} billing is unknown: ${billingSources[provider]?.reason ?? "no reliable evidence"}`),
      ],
    };
  }

  async buildCouncil(request: BuildCouncilRequest): Promise<CouncilPlan> {
    const [models, aggregates, runtimeCapabilities, runtimeBilling] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.telemetry.aggregate(),
      this.runtime.getCapabilities(),
      this.runtime.listProviderBilling?.() ?? Promise.resolve<Record<string, RuntimeBillingDiscovery>>({}),
    ]);
    if (request.modelAssessment) this.modelAssessment = parseModelAssessmentSnapshot(request.modelAssessment);
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
    const runtimeCapabilities = await this.runtime.getCapabilities();
    const [models, aggregates, availableSkills] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.telemetry.aggregate(),
      this.runtime.listSkills(),
    ]);
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
    let current = ranked.candidates[0]!;
    let retriesForCurrent = 0;
    let escalations = 0;
    let lastResult: ExpertResult | undefined;
    const cumulativeUsage: NonNullable<ExpertOutcome["approximateUsage"]> = {};
    const maxAttempts = this.config.retry.maxAttempts;

    while (state.attempts < maxAttempts) {
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
      const failure = failureTypeForResult(lastResult);
      failures.push({ model: current.model, type: failure, summary: lastResult.summary });
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
    Object.assign(state, { status: result.status, model: result.model, finishedAt: new Date().toISOString() });
    const parsed = parseModelKey(result.model);
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
      escalationCount: escalations,
      attempts: Math.max(1, state.attempts),
      hostType: runtimeCapabilities.hostType,
      ...(approximateUsage(result) ? { approximateUsage: approximateUsage(result) } : {}),
    });
    return result;
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
