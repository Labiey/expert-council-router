import type { CouncilConfig } from "./config.js";
import { getRole } from "./roles.js";
import { rankModels } from "./routing.js";
import type {
  AvailableModel,
  BuildCouncilRequest,
  CompositionPools,
  CouncilMember,
  CouncilPlan,
  ExpertRole,
  TaskClass,
  TelemetryAggregate,
} from "./types.js";

export interface TaskClassificationOptions {
  tinyMaxWords: number;
  tinyMaxCjkChars: number;
  complexMinWords: number;
  complexMinCjkChars: number;
  complexSignalThreshold: number;
}

const DEFAULT_TASK_CLASSIFICATION: TaskClassificationOptions = {
  tinyMaxWords: 8,
  tinyMaxCjkChars: 18,
  complexMinWords: 35,
  complexMinCjkChars: 60,
  complexSignalThreshold: 2,
};

function englishTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

function cjkTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function classifyTask(
  task: string,
  options: TaskClassificationOptions = DEFAULT_TASK_CLASSIFICATION,
): TaskClass {
  const normalized = task.toLowerCase().normalize("NFKC");
  const wordCount = normalized.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g)?.length ?? 0;
  const cjkCount = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const debugging = englishTerm(normalized, ["bug", "debug", "race", "deadlock", "crash", "failure", "failing", "regression", "fix"])
    || cjkTerm(normalized, ["修复", "故障", "竞态", "死锁", "崩溃", "报错", "回归"]);
  const architecture = englishTerm(normalized, ["architect", "architecture"])
    || normalized.includes("design review")
    || normalized.includes("migration strategy")
    || cjkTerm(normalized, ["架构", "设计评审", "迁移策略"]);
  const feature = englishTerm(normalized, ["implement", "build", "feature", "integrate", "develop"])
    || cjkTerm(normalized, ["开发", "实现", "集成", "功能"]);
  const complexitySignals = [
    englishTerm(normalized, ["distributed"]) || cjkTerm(normalized, ["分布式"]),
    englishTerm(normalized, ["concurrency", "concurrent", "deadlock", "race"]) || cjkTerm(normalized, ["并发", "死锁", "竞态"]),
    normalized.includes("security boundary") || cjkTerm(normalized, ["安全边界", "权限边界"]),
    /\bcross[- ]?(package|service|module)\b/i.test(normalized) || cjkTerm(normalized, ["跨包", "跨服务", "跨模块"]),
    englishTerm(normalized, ["migrate", "migration", "refactor"]) || cjkTerm(normalized, ["迁移", "重构"]),
    normalized.includes("repository-wide") || normalized.includes("multiple packages") || cjkTerm(normalized, ["全仓库", "多模块", "多个包"]),
    englishTerm(normalized, ["complex", "difficult", "large-scale"]) || cjkTerm(normalized, ["复杂", "困难", "大规模"]),
  ].filter(Boolean).length;
  const longTask = wordCount >= options.complexMinWords || cjkCount >= options.complexMinCjkChars;
  const complex = longTask || complexitySignals >= options.complexSignalThreshold;

  if (architecture) return "architecture";
  if (debugging) return complex ? "complex-debugging" : "normal";
  if (feature && complex) return "complex-feature";
  if (complex) return "complex-feature";
  if (!feature && wordCount <= options.tinyMaxWords && cjkCount <= options.tinyMaxCjkChars) return "tiny";
  return "normal";
}

export function modelInventoryFingerprint(models: readonly AvailableModel[]): string {
  return models
    .map((model) => [
      model.provider,
      model.id,
      model.available ? "1" : "0",
      model.contextWindow ?? "",
      model.reasoning ? "1" : "0",
      ...(model.supportedReasoningLevels ?? []),
    ].join(":"))
    .sort()
    .join("|");
}

export function rolesForTask(taskClass: TaskClass, maxExperts: number): ExpertRole[] {
  const limit = Number.isFinite(maxExperts) ? Math.max(1, Math.floor(maxExperts)) : 1;
  if (taskClass === "tiny") return ["implementation-worker"];
  if (taskClass === "normal") {
    return limit === 1 ? ["implementation-worker"] : ["implementation-worker", "verifier"];
  }
  if (taskClass === "architecture") {
    return limit === 1 ? ["architecture-oracle"] : ["architecture-oracle", "reviewer"];
  }
  if (taskClass === "complex-debugging") {
    if (limit === 1) return ["debugger"];
    if (limit === 2) return ["debugger", "verifier"];
    if (limit === 3) return ["scout", "debugger", "verifier"];
    return ["scout", "debugger", "architecture-oracle", "verifier"];
  }
  if (limit === 1) return ["implementation-worker"];
  if (limit === 2) return ["implementation-worker", "verifier"];
  if (limit === 3) return ["planner", "implementation-worker", "verifier"];
  return ["planner", "implementation-worker", "reviewer", "verifier"];
}

export interface CouncilCompositionInput {
  name: string;
  pools: CompositionPools;
}

export function buildCouncilPlan(
  request: BuildCouncilRequest,
  models: AvailableModel[],
  config: CouncilConfig,
  telemetry: TelemetryAggregate[] = [],
  composition?: CouncilCompositionInput,
): CouncilPlan {
  const taskClass = classifyTask(request.task, config.routing.taskClassification);
  const maxExperts = Math.min(request.constraints?.maxExperts ?? config.routing.maxExperts, config.routing.maxExperts);
  const roles = rolesForTask(taskClass, maxExperts);
  const experts: CouncilMember[] = [];
  const warnings: string[] = [];
  const fullCouncilRoles = rolesForTask(taskClass, 8);
  const omittedRoles = fullCouncilRoles.filter((role) => !roles.includes(role));
  if (omittedRoles.length) {
    warnings.push(`Council capped at ${roles.length} expert(s); omitted roles: ${omittedRoles.join(", ")}.`);
  }
  const selectedModels: string[] = [];

  for (const role of roles) {
    // A composition restricts the role's candidate pool; route-policy and
    // cap/concurrency exclusions were already applied to `models`, so this
    // intersection cannot resurrect a denied model. An empty pool auto-routes.
    const pool = composition?.pools[role] ?? [];
    const roleModels = pool.length
      ? models.filter((model) => pool.includes(`${model.provider}/${model.id}`))
      : models;
    const ranked = rankModels({
      models: roleModels,
      role,
      config,
      ...(request.constraints ? { constraints: request.constraints } : {}),
      telemetry,
      selectedModels,
    });
    const selected = ranked.candidates[0];
    if (!selected) {
      if (pool.length) {
        warnings.push(
          `Composition "${composition!.name}" restricts ${role} to ${pool.join(", ")}, but none of those models are eligible (route policy, provider caps/concurrency, or hard constraints); the role is unstaffable.`,
        );
      } else {
        warnings.push(`No eligible model for ${role}; ${ranked.rejected.length} candidate(s) rejected.`);
      }
      continue;
    }
    selectedModels.push(selected.model);
    const definition = getRole(role);
    experts.push({
      role,
      model: selected.model,
      provider: selected.provider,
      ...(selected.family ? { family: selected.family } : {}),
      score: selected.score,
      reason: selected.reasons,
      alternatives: ranked.candidates.slice(1, 4),
      tools: [...definition.tools],
      skills: [...definition.skills],
      readOnly: definition.readOnly,
      ...(selected.reasoningLevel ? { reasoningLevel: selected.reasoningLevel } : {}),
    });
  }

  if (request.constraints?.runtimeCapabilities?.sourceWorkspaceDirty && experts.some((expert) => !expert.readOnly)) {
    warnings.unshift("Source workspace has uncommitted changes; mutation worktrees start from committed HEAD and will not include them.");
  }

  if (config.security.workspaceProvisioning.mode === "none" && experts.some((expert) => !expert.readOnly)) {
    warnings.push(
      "Mutation experts run in isolated worktrees that are not provisioned (security.workspaceProvisioning.mode=none); they must not install dependencies. Set security.workspaceProvisioning.mode=auto to provision from the repository lockfile.",
    );
  }

  return {
    id: `council_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    taskClass,
    task: request.task,
    experts,
    createdAt: new Date().toISOString(),
    warnings,
    ...(request.constraints?.costPolicy ? { costPolicy: request.constraints.costPolicy } : {}),
    ...(composition ? { composition: composition.name } : {}),
    inventoryFingerprint: modelInventoryFingerprint(models),
  };
}
