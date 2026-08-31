import type { ExpertOutcome, ExpertRole, TelemetryAggregate, TelemetryStore } from "./types.js";

export function sanitizeOutcome(outcome: ExpertOutcome): ExpertOutcome {
  return {
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
    ...(outcome.verificationPassed !== undefined ? { verificationPassed: outcome.verificationPassed } : {}),
    escalationCount: Math.max(0, outcome.escalationCount),
    attempts: Math.max(1, outcome.attempts),
    hostType: outcome.hostType,
    ...(outcome.approximateUsage ? { approximateUsage: { ...outcome.approximateUsage } } : {}),
  };
}

export function aggregateOutcomes(outcomes: readonly ExpertOutcome[]): TelemetryAggregate[] {
  const groups = new Map<string, ExpertOutcome[]>();
  for (const outcome of outcomes) {
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
  const signal = aggregate.successRate * 0.55 + aggregate.firstPassSuccessRate * 0.3 + (1 - Math.min(1, aggregate.toolErrorRate)) * 0.15;
  return Math.max(-maxAdjustment, Math.min(maxAdjustment, (signal - 0.5) * 2 * confidence * maxAdjustment));
}
