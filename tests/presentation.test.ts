import { describe, expect, it } from "vitest";
import {
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
