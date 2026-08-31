import type { ExpertCouncil, ExpertRole, FailureType } from "@expert-council/core";
import { createExpertCouncil } from "@expert-council/pi-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const councils = new Map<string, Promise<ExpertCouncil>>();

function councilFor(cwd: string): Promise<ExpertCouncil> {
  const existing = councils.get(cwd);
  if (existing) return existing;
  const created = createExpertCouncil({ cwd });
  councils.set(cwd, created);
  return created;
}

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined };
}

const Role = Type.Union([
  Type.Literal("planner"),
  Type.Literal("scout"),
  Type.Literal("architecture-oracle"),
  Type.Literal("implementation-worker"),
  Type.Literal("debugger"),
  Type.Literal("reviewer"),
  Type.Literal("verifier"),
]);

const Failure = Type.Union([
  Type.Literal("tool_call_error"),
  Type.Literal("reasoning_failure"),
  Type.Literal("test_failure"),
  Type.Literal("timeout"),
  Type.Literal("provider_error"),
  Type.Literal("missing_context"),
  Type.Literal("permission_error"),
  Type.Literal("unknown"),
]);

export default function expertCouncilExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "expert_inspect",
    label: "Expert Inspect",
    description: "Inspect callable Pi models, billing, roles, skills, and runtime capabilities.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await councilFor(ctx.cwd)).inspectResources());
    },
  });

  pi.registerTool({
    name: "expert_build",
    label: "Expert Build",
    description: "Build a small deterministic cost-aware expert council for a host task.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }),
      maxExperts: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      costPolicy: Type.Optional(Type.Union([Type.Literal("economy"), Type.Literal("balanced"), Type.Literal("quality")])),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await councilFor(ctx.cwd)).buildCouncil({
        task: params.task,
        ...((params.maxExperts ?? params.costPolicy) ? {
          constraints: {
            ...(params.maxExperts ? { maxExperts: params.maxExperts } : {}),
            ...(params.costPolicy ? { costPolicy: params.costPolicy } : {}),
          },
        } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "expert_delegate",
    label: "Expert Delegate",
    description: "Execute one bounded semantic expert assignment with least-privilege resources.",
    parameters: Type.Object({
      role: Role,
      task: Type.String({ minLength: 1 }),
      councilId: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await councilFor(ctx.cwd)).delegate({
        role: params.role as ExpertRole,
        task: params.task,
        ...(params.councilId ? { councilId: params.councilId } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "expert_escalate",
    label: "Expert Escalate",
    description: "Choose a corrected retry, alternative model, or bounded stop from failure evidence.",
    parameters: Type.Object({
      role: Role,
      task: Type.String({ minLength: 1 }),
      currentModel: Type.String({ minLength: 3 }),
      previousFailures: Type.Array(Type.Object({
        model: Type.String(),
        type: Failure,
        summary: Type.String(),
      }), { minItems: 1, maxItems: 8 }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await councilFor(ctx.cwd)).escalate({
        role: params.role as ExpertRole,
        task: params.task,
        currentModel: params.currentModel,
        previousFailures: params.previousFailures.map((failure) => ({
          model: failure.model,
          type: failure.type as FailureType,
          summary: failure.summary,
        })),
      }));
    },
  });

  pi.registerTool({
    name: "expert_status",
    label: "Expert Status",
    description: "Return compact council plans, execution states, and local aggregate outcomes.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await councilFor(ctx.cwd)).getStatus());
    },
  });
}
