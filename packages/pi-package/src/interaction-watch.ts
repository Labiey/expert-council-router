import type { ExpertAttention, PendingInteraction, RunningExecutionView } from "@expert-council/core";

/** Compact host-facing notice that an expert is blocked waiting for an answer. */
export type InteractionNotification = {
  executionId: string;
  taskDescription?: string;
  kind: PendingInteraction["request"]["kind"];
  round: number;
  question?: string;
  options?: string[];
  allowOther?: boolean;
  tool?: string;
  reason?: string;
  context?: string;
  action: string;
};

export interface InteractionWatchOptions {
  /** Snapshot of currently running executions; supplied by the caller so this stays testable. */
  listRunning: () => Promise<RunningExecutionView[]>;
  executionIds: string[];
  /** Host-facing labels per execution, mirrored into the notice for recognition. */
  labels?: Record<string, string | undefined>;
  deadlineMs: number;
  intervalMs?: number;
  send: (notification: InteractionNotification) => void;
  /**
   * Optional sink for non-blocking guardrail warnings. Separate from `send` because an
   * answer is required for one and optional for the other; hosts that only wire `send`
   * keep working unchanged.
   */
  sendGuardrail?: (notification: GuardrailNotification) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Compact host-facing notice that an expert looks stuck rather than merely busy. */
export type GuardrailNotification = {
  executionId: string;
  taskDescription?: string;
  code: ExpertAttention["code"];
  detail: string;
  toolCalls?: number;
  toolErrors?: number;
  budgetFractionUsed?: number;
  nudgedExpert?: boolean;
  action: string;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Build the host-facing notice for one open interaction. */
export function buildInteractionNotification(
  execution: RunningExecutionView,
  pending: PendingInteraction,
  taskDescription?: string,
): InteractionNotification {
  const request = pending.request;
  return {
    executionId: execution.id,
    ...(taskDescription ? { taskDescription } : {}),
    kind: request.kind,
    round: pending.round,
    ...(request.kind === "decision"
      ? {
        ...(request.question ? { question: request.question } : {}),
        options: (request.options ?? []).map((option) => option.label).filter((label) => label.length > 0),
        ...(request.allowOther ? { allowOther: true } : {}),
        ...(request.context ? { context: request.context.slice(0, 600) } : {}),
      }
      : { ...(request.tool ? { tool: request.tool } : {}), ...(request.reason ? { reason: request.reason.slice(0, 400) } : {}) }),
    action:
      request.kind === "decision"
        ? "Answer with expert_respond (kind \"decision\", choice from options or otherText); the expert continues in the same session."
        : "Answer with expert_respond (kind \"tool_approval\", scope \"once\", \"persistent\" or \"reject\").",
  };
}

/** Build the host-facing notice for one guardrail warning. */
export function buildGuardrailNotification(
  execution: RunningExecutionView,
  attention: ExpertAttention,
  taskDescription?: string,
): GuardrailNotification {
  return {
    executionId: execution.id,
    ...(taskDescription ? { taskDescription } : {}),
    code: attention.code,
    detail: attention.detail,
    ...(typeof attention.toolCalls === "number" ? { toolCalls: attention.toolCalls } : {}),
    ...(typeof attention.toolErrors === "number" ? { toolErrors: attention.toolErrors } : {}),
    ...(typeof attention.budgetFractionUsed === "number" ? { budgetFractionUsed: attention.budgetFractionUsed } : {}),
    ...(attention.nudgedExpert ? { nudgedExpert: true } : {}),
    action:
      "Informational: nothing was aborted. Check with expert_result (includeProgress), intervene with expert_abort, or let it run - the expert was " +
      `${attention.nudgedExpert ? "steered once" : "not steered"}` +
      " and can still recover on its own.",
  };
}

/**
 * Watch a set of dispatched executions and report every newly opened interaction
 * once. Native Pi cannot be pushed to from the expert session, so this polls the
 * running view; MCP hosts keep polling themselves. Observation must never break a
 * run, so every failure path returns quietly and each (execution, round) is
 * notified at most once.
 *
 * Guardrail warnings are reported through the same loop, because they share the one
 * thing that makes both useful: a cheap periodic read of the running view. Each
 * (execution, code, budget fraction) is sent at most once, and the return value counts
 * notices of either kind that the host actually accepted - a rejected notice is reported
 * as zero, because an operator who believes a notice appeared is worse off than one who
 * knows none did (defect #29).
 */
export async function watchForInteractions(options: InteractionWatchOptions): Promise<number> {
  const intervalMs = options.intervalMs ?? 2_500;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const wanted = new Set(options.executionIds);
  const startedAt = now();
  const notified = new Set<string>();
  let sent = 0;

  if (wanted.size === 0) return 0;

  while (now() - startedAt <= options.deadlineMs) {
    let running: RunningExecutionView[];
    try {
      const listed = await options.listRunning();
      // A host or stub whose view shape lacks `running` must not kill the watcher.
      running = Array.isArray(listed) ? listed : [];
    } catch {
      return sent;
    }
    const tracked = running.filter((execution) => wanted.has(execution.id));
    if (tracked.length === 0) return sent;
    for (const execution of tracked) {
      if (options.sendGuardrail) {
        for (const attention of execution.attention ?? []) {
          const guardrailKey = `${execution.id}:${attention.code}:${attention.budgetFractionUsed ?? ""}`;
          if (notified.has(guardrailKey)) continue;
          notified.add(guardrailKey);
          try {
            options.sendGuardrail(buildGuardrailNotification(execution, attention, options.labels?.[execution.id]));
            sent += 1;
          } catch {
            // Same rule as interactions: a host that refuses the notice loses nothing.
          }
        }
      }
      const pending = execution.pendingInteraction;
      if (!pending) continue;
      const key = `${execution.id}:${pending.round}`;
      if (notified.has(key)) continue;
      notified.add(key);
      try {
        options.send(buildInteractionNotification(execution, pending, options.labels?.[execution.id]));
        // Counted after the send, like the guardrail counter above: a host that refused the
        // notice did not receive it, and `sent` claims to mean notices delivered (defect #29).
        sent += 1;
      } catch {
        // A host that refuses the notice still discovers it through expert_status.
      }
    }
    await sleep(intervalMs);
  }
  return sent;
}
