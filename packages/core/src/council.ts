import type { CouncilConfig } from "./config.js";
import { getRole } from "./roles.js";
import { rankModels } from "./routing.js";
import type {
  AvailableModel,
  BuildCouncilRequest,
  CouncilMember,
  CouncilPlan,
  ExpertRole,
  TaskClass,
  TelemetryAggregate,
} from "./types.js";

export function classifyTask(task: string): TaskClass {
  const normalized = task.toLowerCase();
  const debugging = /\b(bug|debug|race|deadlock|crash|failure|failing|regression|修复|故障|竞态|报错)\b/.test(normalized);
  const architecture = /\b(architect|design review|migration strategy|架构|设计评审)\b/.test(normalized);
  const complexitySignals = [
    /\b(cross[- ]?package|cross[- ]?service|distributed|concurrency|security boundary|migrate|重构|跨模块|并发|安全边界)\b/,
    /\b(implement|build|feature|integrate|开发|实现|集成)\b/,
  ].filter((pattern) => pattern.test(normalized)).length;
  if (architecture && (task.length > 180 || complexitySignals > 0)) return "architecture";
  if (debugging && (task.length > 140 || complexitySignals > 0)) return "complex-debugging";
  if (task.length < 80 && complexitySignals === 0 && !debugging) return "tiny";
  if (task.length > 220 || complexitySignals > 1) return "complex-feature";
  return debugging ? "complex-debugging" : "normal";
}

export function rolesForTask(taskClass: TaskClass, maxExperts: number): ExpertRole[] {
  const roles: ExpertRole[] =
    taskClass === "tiny"
      ? ["implementation-worker"]
      : taskClass === "normal"
        ? ["implementation-worker", "verifier"]
        : taskClass === "complex-debugging"
          ? ["scout", "debugger", "architecture-oracle", "verifier"]
          : taskClass === "architecture"
            ? ["architecture-oracle", "reviewer"]
            : ["planner", "implementation-worker", "reviewer", "verifier"];
  return roles.slice(0, Math.max(1, maxExperts));
}

export function buildCouncilPlan(
  request: BuildCouncilRequest,
  models: AvailableModel[],
  config: CouncilConfig,
  telemetry: TelemetryAggregate[] = [],
): CouncilPlan {
  const taskClass = classifyTask(request.task);
  const maxExperts = Math.min(request.constraints?.maxExperts ?? config.routing.maxExperts, config.routing.maxExperts);
  const roles = rolesForTask(taskClass, maxExperts);
  const experts: CouncilMember[] = [];
  const warnings: string[] = [];
  const selectedModels: string[] = [];

  for (const role of roles) {
    const ranked = rankModels({
      models,
      role,
      config,
      ...(request.constraints ? { constraints: request.constraints } : {}),
      telemetry,
      selectedModels,
    });
    const selected = ranked.candidates[0];
    if (!selected) {
      warnings.push(`No eligible model for ${role}; ${ranked.rejected.length} candidate(s) rejected.`);
      continue;
    }
    selectedModels.push(selected.model);
    const definition = getRole(role);
    experts.push({
      role,
      model: selected.model,
      provider: selected.provider,
      score: selected.score,
      reason: selected.reasons,
      alternatives: ranked.candidates.slice(1, 4),
      tools: [...definition.tools],
      skills: [...definition.skills],
      readOnly: definition.readOnly,
      ...(selected.reasoningLevel ? { reasoningLevel: selected.reasoningLevel } : {}),
    });
  }

  return {
    id: `council_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    taskClass,
    task: request.task,
    experts,
    createdAt: new Date().toISOString(),
    warnings,
  };
}
