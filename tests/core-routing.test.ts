import { describe, expect, it } from "vitest";
import {
  activeModelAvailability,
  billingCostScore,
  buildCouncilPlan,
  classifyTask,
  ConfigValidationError,
  DEFAULT_CAPABILITY_PROFILE,
  getRole,
  indicatesModelUnavailable,
  mergeModelProfiles,
  normalizePiModel,
  parseCouncilConfig,
  parseModelAssessmentSnapshot,
  preserveModelAvailability,
  publishedApiCostScore,
  rankModels,
  routePolicyExcludes,
  rolesForTask,
  withModelAvailabilityMarker,
} from "../packages/core/src/index.js";
import { capabilities, model } from "./helpers.js";

describe("availability evidence classification", () => {
  it("classifies quota exhaustion ahead of the generic unavailable markers", async () => {
    const { classifyAvailabilityEvidence } = await import("../packages/core/src/failures.js");
    expect(classifyAvailabilityEvidence("403 AccessDenied: insufficient_quota - You exceeded your current quota.")).toBe("quota-exhausted");
    expect(classifyAvailabilityEvidence("账户欠费，请充值后重试")).toBe("quota-exhausted");
    expect(classifyAvailabilityEvidence("Provider returned 402 payment required")).toBe("quota-exhausted");
    expect(classifyAvailabilityEvidence("model_not_found for p/dead")).toBe("unavailable");
    expect(classifyAvailabilityEvidence("Provider returned 429 rate limit exceeded.")).toBeUndefined();
    expect(classifyAvailabilityEvidence("tool call failed")).toBeUndefined();
  });

  it("expires quota markers on a shorter lifetime than dead-model markers", async () => {
    const { activeModelAvailability, MODEL_QUOTA_MARKER_TTL_MS } = await import("../packages/core/src/model-assessment.js");
    const now = new Date("2026-09-05T12:00:00.000Z");
    const assessment = {
      asOf: "2026-09-05T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: {},
      modelAvailability: {
        "p/quota": { callable: false, kind: "quota-exhausted", observedAt: "2026-09-05T05:00:00.000Z", reason: "insufficient_quota", source: "runtime-failure" },
        "p/dead": { callable: false, kind: "unavailable", observedAt: "2026-09-05T05:00:00.000Z", reason: "model_not_found", source: "runtime-failure" },
      },
    };
    const active = activeModelAvailability(assessment, now);
    expect(Object.keys(active)).toEqual(["p/dead"]);
    expect(MODEL_QUOTA_MARKER_TTL_MS).toBeLessThan(24 * 60 * 60_000);
  });
});

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

  it("combines published API price with real billing policy for metered models", () => {
    expect(publishedApiCostScore({ inputPerMillion: 0, outputPerMillion: 0 })).toBeUndefined();
    expect(publishedApiCostScore({ inputPerMillion: 0.1, outputPerMillion: 0.5 })).toBeGreaterThan(
      publishedApiCostScore({ inputPerMillion: 20, outputPerMillion: 60 })!,
    );
    const config = parseCouncilConfig({
      billing: { providers: { metered: { billingType: "metered", marginalCostClass: "normal" } } },
      profiles: { models: {
        "metered/cheap": { coding: 8 },
        "metered/expensive": { coding: 8 },
      } },
    });
    const ranked = rankModels({
      models: [
        model("metered", "expensive", { apiCost: { inputPerMillion: 20, outputPerMillion: 60 } }),
        model("metered", "cheap", { apiCost: { inputPerMillion: 0.1, outputPerMillion: 0.5 } }),
      ],
      role: "reviewer",
      config,
    });
    expect(ranked.candidates[0]?.model).toBe("metered/cheap");
  });

  it("keeps billing scores finite when a caller supplies a non-finite weight", () => {
    expect(billingCostScore(
      { billingType: "metered", marginalCostClass: "normal" },
      { inputPerMillion: 1, outputPerMillion: 2 },
      Number.NaN,
    )).toSatisfy(Number.isFinite);
  });

  it("lets a Main Agent billing audit prefer included Token Plan access over metered access", () => {
    const config = parseCouncilConfig({});
    const ranked = rankModels({
      models: [
        model("qwen-token-plan-cn", "glm-5.2", { apiCost: { inputPerMillion: 0, outputPerMillion: 0 } }),
        model("zai", "glm-5.2", { apiCost: { inputPerMillion: 1.4, outputPerMillion: 4.4 } }),
      ],
      role: "scout",
      config,
      constraints: {
        costPolicy: "economy",
        billingOverrides: {
          "qwen-token-plan-cn": {
            billingType: "subscription",
            marginalCostClass: "very-low",
            usagePreference: "consume-first",
          },
          zai: { billingType: "metered", marginalCostClass: "normal" },
        },
      },
    });
    expect(ranked.candidates[0]?.model).toBe("qwen-token-plan-cn/glm-5.2");
  });

  it("keeps explicit user billing authoritative over a Main Agent assessment", () => {
    const config = parseCouncilConfig({
      billing: { providers: { p: { billingType: "quota", marginalCostClass: "scarce" } } },
    });
    expect(rankModels({
      models: [model("p", "m")],
      role: "scout",
      config,
      constraints: {
        billingOverrides: { p: { billingType: "free", marginalCostClass: "very-low" } },
      },
    }).candidates[0]?.reasons).toContain("quota/scarce billing");
  });

  it("prefers a different reviewer provider and model family when quality is otherwise equal", () => {
    const config = parseCouncilConfig({});
    const ranked = rankModels({
      models: [
        model("worker-provider", "alpha-worker"),
        model("worker-provider", "alpha-review"),
        model("other-provider", "beta-review"),
      ],
      role: "reviewer",
      config,
      selectedModels: ["worker-provider/alpha-worker"],
    });
    expect(ranked.candidates[0]?.model).toBe("other-provider/beta-review");
    expect(ranked.candidates[1]?.reasons).toContain("reviewer diversity penalty applied");
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

  it("makes audited speed materially more important under the speed policy", () => {
    const config = parseCouncilConfig({
      profiles: { models: {
        "p/steady": { coding: 7, toolReliability: 7, autonomousExecution: 7, bashReliability: 7, speed: 2 },
        "p/fast": { coding: 6, toolReliability: 6, autonomousExecution: 6, bashReliability: 6, speed: 10 },
      } },
    });
    const models = [model("p", "steady"), model("p", "fast")];
    expect(rankModels({ models, role: "implementation-worker", config }).candidates[0]?.model).toBe("p/steady");
    expect(rankModels({
      models,
      role: "implementation-worker",
      config,
      constraints: { costPolicy: "speed" },
    }).candidates[0]?.model).toBe("p/fast");
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
    expect(rolesForTask("complex-feature", 3)).toEqual(["planner", "implementation-worker", "verifier"]);
  });

  it("keeps the execution-critical role when a complex council is capped", () => {
    expect(rolesForTask("complex-feature", 1)).toEqual(["implementation-worker"]);
    expect(rolesForTask("complex-feature", 2)).toEqual(["implementation-worker", "verifier"]);
    expect(rolesForTask("complex-debugging", 1)).toEqual(["debugger"]);
    expect(rolesForTask("complex-debugging", 2)).toEqual(["debugger", "verifier"]);
    expect(rolesForTask("complex-debugging", 3)).toEqual(["scout", "debugger", "verifier"]);
    expect(rolesForTask("architecture", 1)).toEqual(["architecture-oracle"]);
  });

  it("warns when a council cap omits supporting roles", () => {
    const config = parseCouncilConfig({ routing: { maxExperts: 1 } });
    const plan = buildCouncilPlan(
      { task: "Implement a complex cross-package security feature", constraints: { runtimeCapabilities: capabilities } },
      [model("p", "present")],
      config,
    );
    expect(plan.experts.map((expert) => expert.role)).toEqual(["implementation-worker"]);
    expect(plan.warnings[0]).toContain("omitted roles: planner, reviewer, verifier");
  });

  it("warns mutation councils when worktrees would omit source changes", () => {
    const config = parseCouncilConfig({});
    const plan = buildCouncilPlan(
      {
        task: "Implement a complex cross-package security feature",
        constraints: { runtimeCapabilities: { ...capabilities, sourceWorkspaceDirty: true } },
      },
      [model("p", "present")],
      config,
    );
    expect(plan.experts.some((expert) => !expert.readOnly)).toBe(true);
    expect(plan.warnings[0]).toContain("uncommitted changes");
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

describe("runtime availability markers", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const models = [model("p", "dead"), model("p", "alive")];
  const marker = {
    callable: false as const,
    observedAt: "2026-09-03T10:00:00.000Z",
    reason: "provider returned model_not_found",
    source: "runtime-failure" as const,
  };

  it("classifies dead-model provider failures without misreading transient outages", () => {
    expect(indicatesModelUnavailable("Selected model p/dead is not currently available.")).toBe(true);
    expect(indicatesModelUnavailable("Provider API returned model_not_found for p/dead.")).toBe(true);
    expect(indicatesModelUnavailable("Pi model registry no longer contains p/dead.")).toBe(true);
    expect(indicatesModelUnavailable("Upstream reported the model has been discontinued.")).toBe(true);
    expect(indicatesModelUnavailable(
      '403: {"message":"Access to model denied. Please make sure you are eligible for using the model.","code":"AccessDenied.Unpurchased"}',
    )).toBe(true);
    expect(indicatesModelUnavailable("Provider rate limit reached")).toBe(false);
    expect(indicatesModelUnavailable("Invalid API key supplied")).toBe(false);
    expect(indicatesModelUnavailable("src/app.ts does not exist")).toBe(false);
    expect(indicatesModelUnavailable(undefined)).toBe(false);
  });

  it("rejects marked models in role routing until explicitly overridden", () => {
    const constraints = { modelAvailability: { "p/dead": marker } };
    const ranked = rankModels({
      models,
      role: "implementation-worker",
      config: parseCouncilConfig({}),
      constraints,
    });
    expect(ranked.candidates.map((candidate) => candidate.model)).toEqual(["p/alive"]);
    expect(ranked.rejected.find((candidate) => candidate.model === "p/dead")?.rejected?.join(" "))
      .toContain("runtime marked model unavailable");

    const overridden = rankModels({
      models,
      role: "implementation-worker",
      config: parseCouncilConfig({}),
      constraints: {
        ...constraints,
        modelOverrides: { "p/dead": { overrideUnavailableMarker: true } },
      },
    });
    expect(overridden.candidates.map((candidate) => candidate.model)).toContain("p/dead");
  });

  it("expires markers after the conservative TTL and ignores future-dated entries", () => {
    const assessment = {
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/dead": { coding: 7 }, "p/alive": { coding: 7 } },
      modelAvailability: {
        "p/dead": { ...marker },
        "p/alive": { ...marker, observedAt: "2026-09-03T13:00:00.000Z" },
      },
    };
    expect(Object.keys(activeModelAvailability(assessment, now))).toEqual(["p/dead"]);
    expect(Object.keys(activeModelAvailability(assessment, new Date("2026-09-04T10:00:01.000Z")))).toEqual(["p/alive"]);
    expect(Object.keys(activeModelAvailability(assessment, new Date("2026-09-04T13:00:01.000Z")))).toEqual([]);
  });

  it("merges markers and preserves them across a freshly submitted audit", () => {
    const saved = {
      asOf: "2026-09-03T09:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/dead": { coding: 9 }, "p/alive": { coding: 8 } },
    };
    const marked = withModelAvailabilityMarker(saved, "p/dead", "model_not_found", "2026-09-03T11:00:00.000Z");
    expect(marked.modelAvailability?.["p/dead"]).toMatchObject({ callable: false, source: "runtime-failure" });
    expect(withModelAvailabilityMarker(marked, "p/dead", "older", "2026-09-03T10:00:00.000Z")).toBe(marked);

    const submitted = {
      asOf: "2026-09-03T12:00:00.000Z",
      sources: ["https://livebench.ai/", "https://lmsys.org/"],
      models: { "p/dead": { coding: 9 }, "p/alive": { coding: 9 } },
    };
    const preserved = preserveModelAvailability(marked, submitted);
    expect(preserved.asOf).toBe(submitted.asOf);
    expect(preserved.modelAvailability?.["p/dead"]?.callable).toBe(false);
    expect(preserveModelAvailability(undefined, submitted)).toEqual(submitted);
  });

  it("validates modelAvailability through the shared snapshot schema", () => {
    const valid = parseModelAssessmentSnapshot({
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/dead": { coding: 7 } },
      modelAvailability: { "p/dead": marker },
    });
    expect(valid.modelAvailability?.["p/dead"]).toMatchObject({ callable: false });
    expect(() => parseModelAssessmentSnapshot({
      asOf: "2026-09-03T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/dead": { coding: 7 } },
      modelAvailability: { "p/dead": { ...marker, callable: true } },
    })).toThrow(ConfigValidationError);
  });
});

describe("route policy exclusion", () => {
  it("supports exact models and whole providers, with deny winning over allow", () => {
    const policy = { allow: ["q/one", "r"], deny: ["r/two"] };
    expect(routePolicyExcludes(policy, "q/one")).toBe(false);
    expect(routePolicyExcludes(policy, "q/other")).toBe(true);
    expect(routePolicyExcludes(policy, "r/one")).toBe(false);
    expect(routePolicyExcludes(policy, "r/two")).toBe(true);
    expect(routePolicyExcludes({ deny: ["q"] }, "q/anything")).toBe(true);
    expect(routePolicyExcludes({ deny: ["q"] }, "r/one")).toBe(false);
    expect(routePolicyExcludes(undefined, "q/one")).toBe(false);
    expect(routePolicyExcludes({}, "q/one")).toBe(false);
  });
});

describe("per-model billing entries", () => {
  const models = [model("sub", "flagship"), model("sub", "flash")];

  function rankedWith(overrides: Record<string, unknown>, config = parseCouncilConfig({})) {
    return rankModels({
      models,
      role: "scout",
      config,
      constraints: { costPolicy: "economy", billingOverrides: overrides as never },
    });
  }

  it("lets a provider/id entry override the provider-level cost class", () => {
    // Provider-level: everything very-low. Model-level: flagship burns quota faster.
    // balanced preference keeps the raw class scores distinguishable (10 vs 9.5).
    const ranked = rankedWith({
      sub: { billingType: "subscription", marginalCostClass: "very-low", usagePreference: "balanced" },
      "sub/flagship": { billingType: "subscription", marginalCostClass: "low", usagePreference: "balanced" },
    });
    // Under economy weights the light model must outrank the flagship.
    expect(ranked.candidates[0]?.model).toBe("sub/flash");
    const flagship = ranked.candidates.find((candidate) => candidate.model === "sub/flagship");
    expect(flagship?.reasons.join(" ")).toContain("subscription/low billing");
  });

  it("prefers config provider entries over assessment overrides at the same level, then falls back per model", () => {
    // No provider-level key anywhere: each model resolves its own entry.
    const config = parseCouncilConfig({
      billing: { providers: { "sub/flagship": { billingType: "subscription", marginalCostClass: "high", usagePreference: "consume-first" } } },
    });
    const ranked = rankedWith({}, config);
    const flagship = ranked.candidates.find((candidate) => candidate.model === "sub/flagship");
    expect(flagship?.reasons.join(" ")).toContain("subscription/high billing");
  });

  it("keeps billingProfile bindings ahead of model-level entries", () => {
    const config = parseCouncilConfig({
      billing: {
        providers: {
          "bound-profile": { billingType: "subscription", marginalCostClass: "scarce", usagePreference: "consume-first" },
        },
      },
      profiles: { models: { "sub/flagship": { billingProfile: "bound-profile" } } },
    });
    const ranked = rankedWith({ "sub/flagship": { billingType: "subscription", marginalCostClass: "low", usagePreference: "consume-first" } }, config);
    const flagship = ranked.candidates.find((candidate) => candidate.model === "sub/flagship");
    expect(flagship?.reasons.join(" ")).toContain("subscription/scarce billing");
  });
});
