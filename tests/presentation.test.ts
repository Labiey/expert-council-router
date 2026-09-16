import { describe, expect, it } from "vitest";
import {
  EXPERT_EVENT_KINDS,
  formatExpertEvent,
  presentCouncilPlan,
  presentResourceInventory,
  type CouncilPlan,
  type ResourceInventory,
} from "../packages/core/src/index.js";
import { capabilities, model } from "./helpers.js";

describe("compact host presentation", () => {
  const inventory: ResourceInventory = {
    models: [
      model("subscription", "reasoner", { reasoning: true }),
      model("subscription", "worker", { reasoning: false }),
      model("metered", "reviewer", { reasoning: true }),
    ],
    skills: [
      { name: "enabled", installed: true, enabled: true },
      { name: "disabled", installed: true, enabled: false },
    ],
    billing: {
      subscription: { billingType: "subscription" },
      metered: { billingType: "metered" },
    },
    roles: [{
      role: "scout",
      description: "Explore",
      readOnly: true,
      tools: ["read"],
      skills: [],
      weights: { speed: 1 },
    }],
    runtimeCapabilities: capabilities,
    warnings: [],
  };

  it("forwards 0.8.0 interaction and permission capabilities to the host view", () => {
    const compact = presentResourceInventory(inventory) as any;
    // Hosts must be able to discover that experts can raise decision points and
    // request tools; a runtime that reports these flags has to survive presentation.
    expect(compact.runtimeCapabilities).toMatchObject({
      realtimeInteraction: true,
      dynamicToolPermissions: true,
    });
  });

  it("forwards the interactive event-stream capability so hosts can discover the window", () => {
    // 0.8.0 lesson: a capability field the runtime reports but presentation drops is
    // invisible to every host. The window is only reachable if this survives.
    const withStream: ResourceInventory = {
      ...inventory,
      runtimeCapabilities: {
        ...capabilities,
        eventStream: { enabled: true, dir: "/tmp/ec/observability", redactToolArgs: true },
      },
    };
    expect((presentResourceInventory(withStream) as any).runtimeCapabilities.eventStream)
      .toEqual({ enabled: true, dir: "/tmp/ec/observability", redactToolArgs: true });
    // A runtime that reports no stream must not grow a fabricated one.
    expect(presentResourceInventory(inventory) as any).not.toHaveProperty("runtimeCapabilities.eventStream");
  });

  it("omits individual model metadata and role weights by default", () => {
    const compact = presentResourceInventory(inventory) as any;
    expect(compact.summary).toEqual({ modelCount: 3, providerCount: 2, enabledSkillCount: 1, roleCount: 1 });
    expect(compact.providers).toEqual([
      { provider: "subscription", modelCount: 2, reasoningModelCount: 1, billingType: "subscription" },
      { provider: "metered", modelCount: 1, reasoningModelCount: 1, billingType: "metered" },
    ]);
    expect(compact.roles).toEqual([{ role: "scout", readOnly: true }]);
    expect(JSON.stringify(compact)).not.toContain("contextWindow");
    expect(JSON.stringify(compact)).not.toContain("weights");
    expect(presentResourceInventory(inventory, "full")).toBe(inventory);
  });

  it("keeps selected experts but omits task copies, alternatives, tools, and scores", () => {
    const plan: CouncilPlan = {
      id: "council_compact",
      taskClass: "normal",
      task: "A long host task that should not be repeated into the model context",
      experts: [{
        role: "scout",
        model: "subscription/reasoner",
        provider: "subscription",
        score: 8.5,
        reason: ["reason one", "reason two", "reason three"],
        alternatives: [{ model: "metered/reviewer", provider: "metered", score: 7, reasons: ["alternative"] }],
        tools: ["read", "grep"],
        skills: [],
        readOnly: true,
      }],
      createdAt: "now",
      warnings: [],
    };
    const compact = presentCouncilPlan(plan) as any;
    expect(compact.experts).toEqual([{
      role: "scout",
      model: "subscription/reasoner",
      reason: ["reason one", "reason two"],
      readOnly: true,
    }]);
    expect(compact).not.toHaveProperty("task");
    expect(compact.experts[0]).not.toHaveProperty("alternatives");
    expect(compact.experts[0]).not.toHaveProperty("score");
    expect(presentCouncilPlan(plan, "full")).toBe(plan);
  });
});

describe("formatExpertEvent - the renderer shipped in core, not a CLI stub", () => {
  const at = "2026-09-16T11:18:05.123Z";
  const base = { t: at, executionId: "exec_1" };

  it("renders tool activity, narration, and waits with the model that produced them", () => {
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "tool_started", tool: "grep" })).toBe("11:18:05 [scout p/m] tool grep");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "tool_finished", tool: "grep", ok: false })).toBe("11:18:05 [scout p/m] tool grep FAILED");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "assistant_text", text: "checking the build" })).toBe("11:18:05 [scout p/m] says: checking the build");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "interaction_opened", text: "which one?" })).toContain("WAITING FOR HOST");
  });

  it("labels an attempt only once a delegation has more than one", () => {
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "started" })).toBe("11:18:05 [scout p/m] started");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "started", attempt: 1 })).toBe("11:18:05 [scout p/m] started");
    expect(formatExpertEvent({ ...base, role: "worker", model: "p/other", kind: "started", attempt: 2 })).toBe("11:18:05 [worker p/other #2] started");
  });

  it("names the delegation-level terminator", () => {
    expect(formatExpertEvent({ ...base, role: "worker", kind: "delegation_final" })).toContain("delegation finished");
  });

  it("never lets one event occupy more than a single terminal line", () => {
    const noisy = formatExpertEvent({ ...base, role: "scout", kind: "assistant_text", text: "first line\nsecond line" });
    expect(noisy.includes("\n")).toBe(false);
  });
});

describe("struggle warnings reach the window with their meaning", () => {
  const at = "2026-09-16T11:38:41.000Z";

  it("renders an attention event as a warning carrying detail and numbers, not a bare kind name", () => {
    const rendered = formatExpertEvent({
      t: at,
      executionId: "exec_1",
      role: "scout",
      model: "p/m",
      kind: "attention",
      attempt: 1,
      text: "60% of the execution budget used with no result yet.",
      toolCalls: 2,
      toolErrors: 1,
      budgetFractionUsed: 0.6,
      nudgedExpert: true,
    });
    // Defect #21: there was no `attention` case at all, so the shared renderer fell through
    // to its default branch and printed the bare kind name - the window said `attention`
    // and threw the sentence away. Observed live.
    expect(rendered).toContain("WARNING");
    expect(rendered).toContain("60% of the execution budget used with no result yet.");
    expect(rendered).toContain("budget 60%");
    expect(rendered).toContain("tool errors 1/2");
    expect(rendered).toContain("expert steered");
    expect(rendered).not.toBe("11:38:41 [scout p/m] attention");
  });

  it("still renders a warning that carries no counters", () => {
    expect(formatExpertEvent({ t: at, executionId: "exec_1", role: "scout", kind: "attention" }))
      .toBe("11:38:41 [scout] WARNING: struggle detected");
  });
});

import type { ExpertEventKind, ExpertObservabilityEvent } from "../packages/core/src/index.js";

describe("every event kind the stream can carry renders meaningfully", () => {
  const at = "2026-09-16T11:38:41.000Z";

  const cases: Array<{ kind: ExpertEventKind; event: Partial<ExpertObservabilityEvent>; expected: string }> = [
    { kind: "started", event: {}, expected: "started" },
    { kind: "tool_started", event: { tool: "read" }, expected: "tool read" },
    { kind: "tool_finished", event: { tool: "read", ok: true }, expected: "tool read ok" },
    { kind: "assistant_text", event: { text: "looking now" }, expected: "says: looking now" },
    { kind: "attention", event: { text: "budget spent", toolErrors: 1, toolCalls: 2 }, expected: "WARNING: budget spent" },
    { kind: "interaction_opened", event: { text: "pick one" }, expected: "WAITING FOR HOST: pick one" },
    { kind: "interaction_answered", event: { text: "chose ls" }, expected: "host answered: chose ls" },
    { kind: "stopped", event: { status: "partial", failureType: "missing_context" }, expected: "stopped by expert: partial (missing_context)" },
    { kind: "completed", event: { status: "success", durationMs: 3000 }, expected: "completed: success in 3s" },
    { kind: "failed", event: { status: "failed", failureType: "timeout", durationMs: 9000 }, expected: "failed: failed (timeout) in 9s" },
    { kind: "stream_truncated", event: { text: "too many events" }, expected: "stream truncated: too many events" },
    { kind: "delegation_final", event: {}, expected: "delegation finished" },
  ];

  it("covers exactly the kinds the union defines, so a new one cannot skip the renderer", () => {
    // Drift guard for defect #21: an unlisted kind still compiles and still streams, but
    // it falls through to the default branch and prints a bare word. The `Record` over the
    // union in core makes an unlisted kind a build failure; this makes an untested one red.
    expect([...EXPERT_EVENT_KINDS].sort()).toEqual(cases.map((item) => item.kind).sort());
  });

  it.each(cases)("renders $kind with its own wording, on one line", ({ kind, event, expected }) => {
    const rendered = formatExpertEvent({ t: at, executionId: "exec_1", role: "scout", model: "p/m", kind, ...event });
    expect(rendered).toContain(expected);
    expect(rendered.includes(String.fromCharCode(10))).toBe(false);
  });
});
