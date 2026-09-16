import { describe, expect, it } from "vitest";
import type { PendingInteraction, RunningExecutionView } from "../packages/core/src/index.js";
import {
  buildGuardrailNotification,
  buildInteractionNotification,
  watchForInteractions,
  type GuardrailNotification,
} from "../packages/pi-package/src/interaction-watch.js";

function running(overrides: Partial<RunningExecutionView> & { id: string }): RunningExecutionView {
  return { role: "scout", status: "running", elapsedMs: 1_000, ...overrides };
}

function pending(
  kind: PendingInteraction["request"]["kind"],
  round: number,
  extra: Partial<PendingInteraction["request"]> = {},
): PendingInteraction {
  return { request: { kind, ...extra }, openedAt: "2026-09-15T00:00:00.000Z", round };
}

const decision = () =>
  pending("decision", 1, {
    question: "Which length?",
    options: [
      { label: "A", description: "about 12 words" },
      { label: "B", description: "about 25 words" },
    ],
    allowOther: true,
    context: "x".repeat(2_000),
  });

describe("pi-package interaction watcher", () => {
  it("notifies each newly opened interaction exactly once and stops when the run ends", async () => {
    const views: RunningExecutionView[][] = [
      [running({ id: "exec_a", pendingInteraction: decision() })],
      // Same round observed again: must not spam the host.
      [running({ id: "exec_a", pendingInteraction: decision() })],
      [running({ id: "exec_a", pendingInteraction: pending("tool_approval", 2, { tool: "powershell", reason: "count lines" }) })],
      [],
    ];
    let poll = 0;
    let clock = 0;
    const seen: Array<Record<string, unknown>> = [];
    const sent = await watchForInteractions({
      listRunning: async () => views[Math.min((poll += 1) - 1, views.length - 1)]!,
      executionIds: ["exec_a"],
      labels: { exec_a: "0.8.0 probe" },
      deadlineMs: 100_000,
      intervalMs: 1,
      sleep: async () => {},
      now: () => (clock += 1_000),
      send: (notification) => {
        seen.push(notification);
      },
    });
    expect(sent).toBe(2);
    expect(seen.map((notice) => `${notice.kind}:${notice.round}`)).toEqual(["decision:1", "tool_approval:2"]);
    expect(seen[0]).toMatchObject({ executionId: "exec_a", taskDescription: "0.8.0 probe", options: ["A", "B"], allowOther: true });
    expect(seen[1]).toMatchObject({ tool: "powershell", reason: "count lines" });
    expect(String(seen[1]!.action)).toContain("expert_respond");
  });

  it("ends quietly when the status source fails instead of throwing at the host", async () => {
    const sent = await watchForInteractions({
      listRunning: async () => {
        throw new Error("status unavailable");
      },
      executionIds: ["exec_a"],
      deadlineMs: 5_000,
      intervalMs: 1,
      sleep: async () => {},
      send: () => {
        throw new Error("must not send");
      },
    });
    expect(sent).toBe(0);
  });

  it("ignores other executions and never watches an empty batch", async () => {
    let polls = 0;
    const sent = await watchForInteractions({
      listRunning: async () => {
        polls += 1;
        return [running({ id: "exec_other", pendingInteraction: decision() })];
      },
      executionIds: ["exec_a"],
      deadlineMs: 5_000,
      intervalMs: 1,
      sleep: async () => {},
      now: (() => {
        let clock = 0;
        return () => (clock += 4_000);
      })(),
      send: () => {},
    });
    expect(sent).toBe(0);
    expect(polls).toBe(1);
    expect(
      await watchForInteractions({
        listRunning: async () => {
          throw new Error("must not poll");
        },
        executionIds: [],
        deadlineMs: 1,
        send: () => {},
      }),
    ).toBe(0);
  });

  it("does not claim a notice the host rejected, and does not retry it every poll", async () => {
    let clock = 0;
    let poll = 0;
    let attempts = 0;
    const sent = await watchForInteractions({
      listRunning: async () => {
        poll += 1;
        return poll > 2 ? [] : [running({ id: "exec_a", pendingInteraction: decision() })];
      },
      executionIds: ["exec_a"],
      deadlineMs: 100_000,
      intervalMs: 1,
      sleep: async () => {},
      now: () => (clock += 1_000),
      send: () => {
        attempts += 1;
        throw new Error("session busy");
      },
    });
    // Nothing was delivered, so nothing may be counted as delivered (defect #29) - while
    // the dedupe key is still consumed, so a rejecting host is not spammed every poll.
    expect(sent).toBe(0);
    expect(attempts).toBe(1);
  });

  it("builds a bounded decision notice without inventing options", () => {
    const notice = buildInteractionNotification(running({ id: "exec_b" }), pending("decision", 3, { question: "Pick" }));
    expect(notice).toMatchObject({ executionId: "exec_b", kind: "decision", round: 3, question: "Pick", options: [] });
    expect(notice.allowOther).toBeUndefined();
    expect(notice.context).toBeUndefined();
    const truncated = buildInteractionNotification(running({ id: "exec_b" }), decision());
    expect(String(truncated.context).length).toBeLessThanOrEqual(600);
  });
});

describe("guardrail notices ride the same poll", () => {
  const running = (attention: unknown[]): RunningExecutionView =>
    ({
      id: "exec_g", role: "implementation-worker", status: "running", model: "p/m", elapsedMs: 1_000,
      attention,
    }) as unknown as RunningExecutionView;

  const warning = { code: "consecutive_tool_failures", at: "2026-09-02T00:00:00.000Z", detail: "3 consecutive tool calls failed (3 of 5 observed).", toolCalls: 5, toolErrors: 3, nudgedExpert: true };

  it("sends each guardrail warning once while the expert keeps running", async () => {
    const guardrails: GuardrailNotification[] = [];
    let polls = 0;
    const sent = await watchForInteractions({
      listRunning: async () => {
        polls += 1;
        // Same warning present on three polls: it must be delivered exactly once.
        return polls >= 3 ? [] : [running(polls === 1 ? [] : [warning])];
      },
      executionIds: ["exec_g"],
      deadlineMs: 1_000,
      intervalMs: 1,
      send: () => undefined,
      sendGuardrail: (notification) => { guardrails.push(notification); },
      sleep: async () => undefined,
    });
    expect(guardrails).toHaveLength(1);
    expect(sent).toBe(1);
    expect(guardrails[0]!.code).toBe("consecutive_tool_failures");
    expect(guardrails[0]!.detail).toContain("consecutive tool calls failed");
    expect(guardrails[0]!.nudgedExpert).toBe(true);
  });

  it("keeps budget warnings distinct per fraction and says so in the action text", () => {
    const notice = buildGuardrailNotification(
      running([]),
      { code: "budget_fraction", at: "2026-09-02T00:00:00.000Z", detail: "85% of the execution budget used with no result yet.", budgetFractionUsed: 0.85 },
      "refactor the parser",
    );
    expect(notice.taskDescription).toBe("refactor the parser");
    expect(notice.budgetFractionUsed).toBe(0.85);
    // Informational by construction: nothing was aborted, and the notice says so.
    expect(notice.action).toContain("nothing was aborted");
    expect(notice.action).toContain("not steered");
  });

  it("stays compatible with hosts that never wired a guardrail sink", async () => {
    const interactions: unknown[] = [];
    await watchForInteractions({
      listRunning: async () => [],
      executionIds: ["exec_g"],
      deadlineMs: 1,
      intervalMs: 1,
      send: (notification) => { interactions.push(notification); },
      sleep: async () => undefined,
    });
    expect(interactions).toEqual([]);
  });
});
