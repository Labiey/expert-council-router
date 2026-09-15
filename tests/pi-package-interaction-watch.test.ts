import { describe, expect, it } from "vitest";
import type { PendingInteraction, RunningExecutionView } from "../packages/core/src/index.js";
import {
  buildInteractionNotification,
  watchForInteractions,
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

  it("survives a host that rejects the notice", async () => {
    let clock = 0;
    let poll = 0;
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
        throw new Error("session busy");
      },
    });
    expect(sent).toBe(1);
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
