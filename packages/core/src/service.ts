import { buildCouncilPlan, classifyTask } from "./council.js";
import { type CouncilConfig, getModelProfile, parseCouncilConfig } from "./config.js";
import { decideEscalation } from "./escalation.js";
import { listRoles } from "./roles.js";
import { rankModels } from "./routing.js";
import { MemoryTelemetryStore } from "./telemetry.js";
import type {
  BuildCouncilRequest,
  CouncilPlan,
  CouncilStatus,
  DelegationRequest,
  EscalationRequest,
  ExpertCouncil,
  ExpertOutcome,
  ExpertResult,
  ExpertRuntime,
  FailureType,
  ResourceInventory,
  TelemetryStore,
} from "./types.js";

interface ExecutionState {
  id: string;
  role: DelegationRequest["role"];
  status: "running" | "success" | "partial" | "failed";
  model?: string;
  attempts: number;
  startedAt: string;
  finishedAt?: string;
}

function executionId(): string {
  return `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseModelKey(key: string): { provider: string; id: string } {
  const [provider, ...parts] = key.split("/");
  return { provider: provider ?? "unknown", id: parts.join("/") };
}

function failureType(result: ExpertResult): FailureType {
  return result.executionMetadata?.failureType ?? (result.status === "failed" ? "unknown" : "unknown");
}

export class ExpertCouncilService implements ExpertCouncil {
  readonly config: CouncilConfig;
  private readonly plans = new Map<string, CouncilPlan>();
  private readonly executions = new Map<string, ExecutionState>();

  constructor(
    private readonly runtime: ExpertRuntime,
    config: unknown = {},
    private readonly telemetry: TelemetryStore = new MemoryTelemetryStore(),
  ) {
    this.config = parseCouncilConfig(config);
  }

  async inspectResources(): Promise<ResourceInventory> {
    const [models, skills, runtimeCapabilities] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.runtime.listSkills(),
      this.runtime.getCapabilities(),
    ]);
    const configuredUnavailable = Object.keys(this.config.profiles.models).filter(
      (key) => !models.some((model) => `${model.provider}/${model.id}` === key),
    );
    return {
      models,
      skills,
      billing: { ...this.config.billing.providers },
      roles: listRoles(),
      runtimeCapabilities,
      warnings: configuredUnavailable.map((key) => `Configured profile ${key} is not currently available and was ignored.`),
    };
  }

  async buildCouncil(request: BuildCouncilRequest): Promise<CouncilPlan> {
    const [models, aggregates, runtimeCapabilities] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.telemetry.aggregate(),
      this.runtime.getCapabilities(),
    ]);
    const constraints = { ...request.constraints, runtimeCapabilities };
    const plan = buildCouncilPlan({ ...request, constraints }, models, this.config, aggregates);
    this.plans.set(plan.id, plan);
    return plan;
  }

  async delegate(request: DelegationRequest): Promise<ExpertResult> {
    const id = executionId();
    const state: ExecutionState = {
      id,
      role: request.role,
      status: "running",
      attempts: 0,
      startedAt: new Date().toISOString(),
    };
    this.executions.set(id, state);
    const started = Date.now();
    const runtimeCapabilities = await this.runtime.getCapabilities();
    const [models, aggregates, availableSkills] = await Promise.all([
      this.runtime.listAvailableModels(),
      this.telemetry.aggregate(),
      this.runtime.listSkills(),
    ]);
    const plan = request.councilId ? this.plans.get(request.councilId) : undefined;
    const planned = plan?.experts.find((expert) => expert.role === request.role);
    const ranked = rankModels({
      models,
      role: request.role,
      config: this.config,
      constraints: { ...request.constraints, runtimeCapabilities },
      telemetry: aggregates,
    });
    if (planned) {
      ranked.candidates.sort((a, b) => (a.model === planned.model ? -1 : b.model === planned.model ? 1 : b.score - a.score));
    }
    if (!ranked.candidates.length) {
      const result: ExpertResult = {
        status: "failed",
        role: request.role,
        model: "unassigned",
        summary: "No eligible model satisfies the role and runtime constraints.",
        risks: ranked.rejected.flatMap((candidate) => candidate.rejected ?? []).slice(0, 5),
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
    const maxAttempts = this.config.retry.maxAttempts;

    while (state.attempts < maxAttempts) {
      state.attempts += 1;
      state.model = current.model;
      const modelParts = parseModelKey(current.model);
      const profile = getModelProfile(this.config, modelParts.provider, modelParts.id);
      const member = plan?.experts.find((expert) => expert.role === request.role);
      const role = listRoles().find((definition) => definition.role === request.role)!;
      const activatableSkills = new Set(
        availableSkills
          .filter(
            (skill) =>
              skill.installed &&
              skill.enabled &&
              (skill.trusted !== false || this.config.security.trustedSkills.includes(skill.name)),
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
        ...((current.reasoningLevel ?? profile.preferredReasoningByRole?.[request.role])
          ? { reasoningLevel: current.reasoningLevel ?? profile.preferredReasoningByRole?.[request.role] }
          : {}),
        readOnly: role.readOnly,
        ...(request.workspace ? { workspace: request.workspace } : {}),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        attempt: state.attempts,
        ...(failures.length ? { priorFailure: { type: failures.at(-1)!.type, summary: failures.at(-1)!.summary } } : {}),
      });

      if (lastResult.status === "success") break;
      const failure = failureType(lastResult);
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
    };
    Object.assign(state, { status: result.status, model: result.model, finishedAt: new Date().toISOString() });
    const parsed = parseModelKey(result.model);
    await this.telemetry.record({
      timestamp: new Date().toISOString(),
      model: parsed.id,
      provider: parsed.provider,
      role: request.role,
      taskCategory: classifyTask(request.task),
      success: result.status === "success",
      firstPass: result.status === "success" && state.attempts === 1,
      toolErrors: failures.filter((failure) => failure.type === "tool_call_error").length,
      retryCount: Math.max(0, state.attempts - 1),
      timedOut: failures.some((failure) => failure.type === "timeout"),
      escalationCount: escalations,
      attempts: Math.max(1, state.attempts),
      hostType: runtimeCapabilities.hostType,
    });
    return result;
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
      constraints: { ...request.constraints, allowEscalationOnly: true, runtimeCapabilities },
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
      executions: [...this.executions.values()].map((execution) => ({ ...execution })),
      telemetry: await this.telemetry.aggregate(),
    };
  }

  async recordOutcome(outcome: ExpertOutcome): Promise<void> {
    await this.telemetry.record(outcome);
  }
}
