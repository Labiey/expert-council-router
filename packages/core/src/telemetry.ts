import type { ExpertOutcome, ExpertRole, TelemetryAggregate, TelemetryStore } from "./types.js";

export function sanitizeOutcome(outcome: ExpertOutcome): ExpertOutcome {
  return {
    ...(outcome.executionId ? { executionId: outcome.executionId } : {}),
    timestamp: outcome.timestamp,
    model: outcome.model,
    provider: outcome.provider,
    role: outcome.role,
    taskCategory: outcome.taskCategory,
    success: outcome.success,
    firstPass: outcome.firstPass,
    toolErrors: Math.max(0, outcome.toolErrors),
    retryCount: Math.max(0, outcome.retryCount),
    timedOut: outcome.timedOut,
    ...(outcome.aborted !== undefined ? { aborted: outcome.aborted } : {}),
    ...(outcome.verificationPassed !== undefined ? { verificationPassed: outcome.verificationPassed } : {}),
    // Whitelist projection: a field not copied here is silently dropped before it
    // reaches the store, so newly added ExpertOutcome fields must be listed here too.
    ...(typeof outcome.interactionRounds === "number"
      ? { interactionRounds: Math.max(0, Math.floor(outcome.interactionRounds)) }
      : {}),
    // Observed failing tool calls (a real count, not the old 0/1 attempt flag) and the
    // terminal failure type, which aggregation needs in order to keep infrastructure
    // faults out of a model's reliability signal. Both must be listed in this
    // whitelist or they vanish silently on the way to disk.
    ...(typeof outcome.toolErrorsObserved === "number"
      ? { toolErrorsObserved: Math.max(0, Math.floor(outcome.toolErrorsObserved)) }
      : {}),
    ...(outcome.failureType ? { failureType: outcome.failureType } : {}),
    // Same whitelist hazard again: any new ExpertOutcome field must be listed here or
    // it is silently dropped on the way to disk.
    ...(typeof outcome.toolCalls === "number" ? { toolCalls: Math.max(0, Math.floor(outcome.toolCalls)) } : {}),
    ...(outcome.attentionCodes?.length ? { attentionCodes: outcome.attentionCodes.slice(0, 8) } : {}),
    escalationCount: Math.max(0, outcome.escalationCount),
    attempts: Math.max(1, outcome.attempts),
    hostType: outcome.hostType,
    ...(outcome.approximateUsage ? { approximateUsage: { ...outcome.approximateUsage } } : {}),
  };
}

/**
 * Failures that are not attributable to the model's own capability. A supplier
 * outage or a dropped connection says nothing about whether the model is good at the
 * role, so those samples are excluded instead of being scored as losses: counting
 * them would punish exactly the models that happen to be routed during an outage.
 */
const LEARNING_NEUTRAL_FAILURE_TYPES = new Set<string>(["provider_error"]);

export function aggregateOutcomes(outcomes: readonly ExpertOutcome[]): TelemetryAggregate[] {
  const attributable = outcomes.filter(
    (outcome) => !(outcome.failureType && LEARNING_NEUTRAL_FAILURE_TYPES.has(outcome.failureType)),
  );
  const latestByExecution = new Map<string, ExpertOutcome>();
  const anonymous: ExpertOutcome[] = [];
  for (const outcome of attributable) {
    if (outcome.executionId) latestByExecution.set(outcome.executionId, outcome);
    else anonymous.push(outcome);
  }
  const groups = new Map<string, ExpertOutcome[]>();
  for (const outcome of [...anonymous, ...latestByExecution.values()]) {
    const key = `${outcome.provider}/${outcome.model}/${outcome.role}`;
    const group = groups.get(key) ?? [];
    group.push(outcome);
    groups.set(key, group);
  }

  return [...groups.values()].map((items) => {
    const first = items[0]!;
    const verified = items.filter((item) => item.verificationPassed !== undefined);
    return {
      model: first.model,
      provider: first.provider,
      role: first.role,
      samples: items.length,
      successRate: items.filter((item) => item.success).length / items.length,
      firstPassSuccessRate: items.filter((item) => item.firstPass && item.success).length / items.length,
      toolErrorRate: items.reduce((sum, item) => sum + item.toolErrors, 0) / items.length,
      retryRate: items.filter((item) => item.retryCount > 0).length / items.length,
      ...(verified.length
        ? { verificationPassRate: verified.filter((item) => item.verificationPassed).length / verified.length }
        : {}),
      averageAttempts: items.reduce((sum, item) => sum + item.attempts, 0) / items.length,
    };
  });
}

export class MemoryTelemetryStore implements TelemetryStore {
  private readonly outcomes: ExpertOutcome[] = [];

  async record(outcome: ExpertOutcome): Promise<void> {
    this.outcomes.push(sanitizeOutcome(outcome));
  }

  async list(): Promise<ExpertOutcome[]> {
    return this.outcomes.map((outcome) => ({ ...outcome }));
  }

  async aggregate(): Promise<TelemetryAggregate[]> {
    return aggregateOutcomes(this.outcomes);
  }
}

export function observedAdjustment(
  aggregates: readonly TelemetryAggregate[],
  modelKey: string,
  role: ExpertRole,
  maxAdjustment: number,
): number {
  const [provider, ...modelParts] = modelKey.split("/");
  const model = modelParts.join("/");
  const aggregate = aggregates.find((item) => item.provider === provider && item.model === model && item.role === role);
  if (!aggregate || aggregate.samples < 3) return 0;
  const confidence = Math.min(1, aggregate.samples / 20);
  const signal = aggregate.verificationPassRate === undefined
    ? aggregate.successRate * 0.55 + aggregate.firstPassSuccessRate * 0.3 + (1 - Math.min(1, aggregate.toolErrorRate)) * 0.15
    : aggregate.successRate * 0.45
      + aggregate.firstPassSuccessRate * 0.25
      + (1 - Math.min(1, aggregate.toolErrorRate)) * 0.15
      + aggregate.verificationPassRate * 0.15;
  return Math.max(-maxAdjustment, Math.min(maxAdjustment, (signal - 0.5) * 2 * confidence * maxAdjustment));
}
