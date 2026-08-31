import { describe, expect, it } from "vitest";
import {
  billingCostScore,
  buildCouncilPlan,
  classifyTask,
  ConfigValidationError,
  DEFAULT_CAPABILITY_PROFILE,
  getRole,
  mergeModelProfiles,
  normalizePiModel,
  parseCouncilConfig,
  rankModels,
  rolesForTask,
} from "../packages/core/src/index.js";
import { capabilities, model } from "./helpers.js";

describe("model normalization", () => {
  it("normalizes current Pi metadata and reasoning support safely", () => {
    const normalized = normalizePiModel({
      provider: "p",
      id: "m",
      name: "Model",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 8_000,
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      thinkingLevelMap: { low: "low", high: "high", xhigh: null },
    });
    expect(normalized).toMatchObject({
      provider: "p",
      id: "m",
      displayName: "Model",
      supportedReasoningLevels: ["low", "high"],
      maxOutputTokens: 8_000,
      inputModalities: ["text", "image"],
      apiCost: { inputPerMillion: 1, outputPerMillion: 2 },
    });
    expect(normalizePiModel({ id: "missing-provider" })).toBeUndefined();
  });
});

describe("billing and deterministic role scoring", () => {
  it("favors free and subscription marginal cost over metered scarce access", () => {
    expect(billingCostScore({ billingType: "free", marginalCostClass: "very-low" })).toBeGreaterThan(
      billingCostScore({ billingType: "metered", marginalCostClass: "scarce" }),
    );
  });

  it("selects reliable execution over abstract strength for a worker", () => {
    const config = parseCouncilConfig({
      profiles: { models: {
        "p/theorist": { reasoning: 10, coding: 9, toolReliability: 4, autonomousExecution: 3, bashReliability: 3 },
        "p/worker": { reasoning: 6, coding: 8, toolReliability: 9, autonomousExecution: 9, bashReliability: 9 },
      } },
    });
    const ranked = rankModels({
      models: [model("p", "theorist"), model("p", "worker")],
      role: "implementation-worker",
      config,
      constraints: { runtimeCapabilities: capabilities },
    });
    expect(ranked.candidates[0]?.model).toBe("p/worker");
  });

  it("lets a long-context subscription model win oracle work", () => {
    const config = parseCouncilConfig({
      billing: { providers: {
        subscription: { billingType: "subscription", marginalCostClass: "very-low", usagePreference: "consume-first" },
        metered: { billingType: "metered", marginalCostClass: "normal" },
      } },
      profiles: { models: {
        "subscription/oracle": { architecture: 9, planning: 9, longContext: 10, review: 9 },
        "metered/executor": { architecture: 6, planning: 6, longContext: 6, review: 7, toolReliability: 10 },
      } },
    });
    const ranked = rankModels({
      models: [model("subscription", "oracle", { contextWindow: 1_000_000 }), model("metered", "executor")],
      role: "architecture-oracle",
      config,
    });
    expect(ranked.candidates[0]?.model).toBe("subscription/oracle");
  });

  it("applies hard constraints before scoring", () => {
    const config = parseCouncilConfig({
      profiles: { models: {
        "p/disabled": { disabled: true },
        "p/unreliable": { toolReliability: 2 },
        "p/good": { toolReliability: 8 },
      } },
    });
    const ranked = rankModels({
      models: [model("p", "disabled"), model("p", "unreliable"), model("p", "good")],
      role: "implementation-worker",
      config,
      constraints: { runtimeCapabilities: capabilities },
    });
    expect(ranked.candidates.map((item) => item.model)).toEqual(["p/good"]);
    expect(ranked.rejected).toHaveLength(2);
  });

  it("gives unknown models conservative defaults without crashing", () => {
    const config = parseCouncilConfig({});
    const ranked = rankModels({ models: [model("new", "unknown")], role: "reviewer", config });
    expect(ranked.candidates[0]?.score).toBeGreaterThan(0);
    expect(DEFAULT_CAPABILITY_PROFILE.autonomousExecution).toBe(4);
  });
});

describe("council sizing and permissions", () => {
  it("uses smaller councils for tiny and normal tasks", () => {
    expect(classifyTask("Rename a local symbol")).toBe("tiny");
    expect(rolesForTask("tiny", 4)).toEqual(["implementation-worker"]);
    expect(rolesForTask("normal", 4)).toEqual(["implementation-worker", "verifier"]);
    expect(rolesForTask("complex-feature", 3)).toHaveLength(3);
  });

  it("classifies equivalent English and Chinese tasks consistently", () => {
    expect(classifyTask("Fix the login button color")).toBe("normal");
    expect(classifyTask("修复登录按钮颜色")).toBe("normal");
    expect(classifyTask("Debug a distributed concurrency race across multiple packages")).toBe("complex-debugging");
    expect(classifyTask("调试跨模块分布式并发竞态问题")).toBe("complex-debugging");
    expect(classifyTask("Review the service architecture")).toBe("architecture");
    expect(classifyTask("评审服务架构")).toBe("architecture");
  });

  it("never grants mutation tools to read-only roles", () => {
    for (const role of ["planner", "scout", "architecture-oracle", "reviewer"] as const) {
      expect(getRole(role).tools).not.toContain("edit");
      expect(getRole(role).tools).not.toContain("write");
      expect(getRole(role).readOnly).toBe(true);
    }
  });

  it("ignores missing configured models", () => {
    const config = parseCouncilConfig({ profiles: { models: { "missing/model": { coding: 10 } } } });
    const plan = buildCouncilPlan(
      { task: "Rename a local symbol", constraints: { runtimeCapabilities: capabilities } },
      [model("p", "present")],
      config,
    );
    expect(plan.experts[0]?.model).toBe("p/present");
  });
});

describe("configuration", () => {
  it("deep-merges reasoning preferences and lets null unset inherited profile values", () => {
    expect(mergeModelProfiles(
      { coding: 9, review: 8, preferredReasoningByRole: { reviewer: "high", planner: "medium" } },
      { coding: null, preferredReasoningByRole: { reviewer: null } },
    )).toEqual({
      review: 8,
      preferredReasoningByRole: { planner: "medium" },
    });
    expect(parseCouncilConfig({ profiles: { models: { "p/m": { coding: null } } } }).profiles.models["p/m"]?.coding).toBeNull();
  });

  it("returns actionable paths for invalid values", () => {
    expect(() => parseCouncilConfig({ routing: { maxExperts: 99 } })).toThrow(ConfigValidationError);
    try {
      parseCouncilConfig({ routing: { maxExperts: 99 } });
    } catch (error) {
      expect((error as Error).message).toContain("routing.maxExperts");
    }
  });
});
