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

export interface ExpertCouncilExtensionDependencies {
  councilFor?: (cwd: string) => Promise<ExpertCouncil>;
}

export default function expertCouncilExtension(
  pi: ExtensionAPI,
  dependencies: ExpertCouncilExtensionDependencies = {},
) {
  const getCouncil = dependencies.councilFor ?? councilFor;

  pi.registerTool({
    name: "expert_inspect",
    label: "Expert Inspect",
    description: "Inspect callable Pi models, billing, roles, skills, and runtime capabilities.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await getCouncil(ctx.cwd)).inspectResources());
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
      return output(await (await getCouncil(ctx.cwd)).buildCouncil({
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
    description: "Start one bounded semantic expert assignment in the background and immediately return its execution ID.",
    promptGuidelines: [
      "After expert_delegate reports that a task has completed, call expert_result with its executionId before using the feedback.",
      "Native Pi completion notifications wake the Main Agent automatically; after dispatching background work, stop the turn instead of polling or silently waiting when no other useful work remains.",
    ],
    parameters: Type.Object({
      role: Role,
      task: Type.String({ minLength: 1 }),
      taskDescription: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Optional concise host-facing label included in the completion notification.",
      })),
      councilId: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const council = await getCouncil(ctx.cwd);
      const handle = council.startDelegation({
        role: params.role as ExpertRole,
        task: params.task,
        ...(params.taskDescription ? { taskDescription: params.taskDescription } : {}),
        ...(params.councilId ? { councilId: params.councilId } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      });
      void handle.result.then(() => {
        try {
          const delivery = ctx.isIdle() ? "followUp" : "steer";
          const notification = {
            executionId: handle.executionId,
            ...(params.taskDescription ? { taskDescription: params.taskDescription } : {}),
          };
          pi.sendMessage({
            customType: "expert-council-completed",
            content: JSON.stringify(notification),
            display: true,
            details: notification,
          }, { deliverAs: delivery, triggerTurn: true });
        } catch {
          // The originating Pi session may have been replaced or shut down.
          // The result remains available through expert_result in the council service.
        }
      });
      return output({ executionId: handle.executionId, status: "running" });
    },
  });

  pi.registerTool({
    name: "expert_result",
    label: "Expert Result",
    description: "Retrieve completed expert feedback by execution ID, or report that the task is still running or unknown.",
    parameters: Type.Object({
      executionId: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await getCouncil(ctx.cwd)).getResult(params.executionId));
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
      return output(await (await getCouncil(ctx.cwd)).escalate({
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
      return output(await (await getCouncil(ctx.cwd)).getStatus());
    },
  });
}
