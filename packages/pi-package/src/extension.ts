import {
  presentCouncilPlan,
  presentResourceInventory,
  type CostPolicy,
  type DelegationRequest,
  type ExpertCouncil,
  type ExpertRole,
  type FailureType,
} from "@expert-council/core";
import { createExpertCouncil } from "@expert-council/pi-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

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

const Detail = Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("full")]));
const CostPolicySchema = Type.Union([
  Type.Literal("economy"),
  Type.Literal("balanced"),
  Type.Literal("speed"),
  Type.Literal("quality"),
]);
const CapabilityScore = Type.Optional(Type.Number({ minimum: 0, maximum: 10 }));
const AuditedCapabilityProfile = Type.Object({
  reasoning: CapabilityScore,
  planning: CapabilityScore,
  architecture: CapabilityScore,
  coding: CapabilityScore,
  debugging: CapabilityScore,
  review: CapabilityScore,
  longContext: CapabilityScore,
  toolReliability: CapabilityScore,
  bashReliability: CapabilityScore,
  autonomousExecution: CapabilityScore,
  speed: CapabilityScore,
}, { additionalProperties: false });
const AssessedBillingEntry = Type.Object({
  billingType: Type.Union([
    Type.Literal("subscription"),
    Type.Literal("metered"),
    Type.Literal("quota"),
    Type.Literal("free"),
    Type.Literal("unknown"),
  ]),
  marginalCostClass: Type.Optional(Type.Union([
    Type.Literal("very-low"),
    Type.Literal("low"),
    Type.Literal("normal"),
    Type.Literal("high"),
    Type.Literal("scarce"),
  ])),
  usagePreference: Type.Optional(Type.Union([
    Type.Literal("consume-first"),
    Type.Literal("balanced"),
    Type.Literal("quality-sensitive"),
    Type.Literal("escalation-only"),
  ])),
}, { additionalProperties: false });
const ModelAssessment = Type.Object({
  asOf: Type.String({ minLength: 20, maxLength: 100, description: "ISO-8601 timestamp for the capability audit." }),
  sources: Type.Array(Type.String({ minLength: 8, maxLength: 2000 }), { minItems: 1, maxItems: 12 }),
  models: Type.Record(
    Type.String({ minLength: 3, maxLength: 500, pattern: "^[^/\\x00-\\x1f]+/.+$" }),
    AuditedCapabilityProfile,
  ),
  billing: Type.Optional(Type.Record(
    Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\x00-\\x1f]+$" }),
    AssessedBillingEntry,
  )),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
}, { additionalProperties: false });
const TaskText = Type.String({ minLength: 1, maxLength: 100_000, pattern: "^[^\\x00]+$" });
const WorkspacePath = Type.String({ minLength: 1, maxLength: 32_768, pattern: "^[^\\x00]+$" });
const ExecutionIdentifier = Type.String({ minLength: 1, maxLength: 200, pattern: "^[a-zA-Z0-9_-]+$" });
const ASSEMBLY_PREFERENCE_ENTRY = "expert-council-assembly-preference";

function parseStringifiedAssignments(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 1_000_000) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function sessionAssemblyPreference(ctx: { sessionManager?: { getBranch?: () => readonly unknown[] } }): CostPolicy | undefined {
  const entries = ctx.sessionManager?.getBranch?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== ASSEMBLY_PREFERENCE_ENTRY) continue;
    const policy = (entry.data as { costPolicy?: unknown } | undefined)?.costPolicy;
    if (["economy", "balanced", "speed", "quality"].includes(String(policy))) return policy as CostPolicy;
  }
  return undefined;
}

const DelegationAssignment = Type.Object({
  role: Role,
  task: TaskText,
  taskDescription: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Optional concise host-facing label included in the completion notification.",
  })),
  councilId: Type.Optional(ExecutionIdentifier),
  workspace: Type.Optional(WorkspacePath),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
});
type DelegationAssignmentInput = Static<typeof DelegationAssignment>;

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
    description: "Inspect a compact summary of callable Pi resources. Request full detail only when exact model metadata is required.",
    parameters: Type.Object({ detail: Detail }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const inventory = await (await getCouncil(ctx.cwd)).inspectResources();
      return output(presentResourceInventory(inventory, params.detail));
    },
  });

  pi.registerTool({
    name: "expert_build",
    label: "Expert Build",
    description: "Build a small deterministic expert council. The first council in a Pi conversation requires a user-selected economy, balanced, or speed preference; later councils reuse it.",
    promptGuidelines: [
      "Before the first council in a conversation, ask the user once to choose economy (lowest effective cost), balanced (cost/time/success), or speed (fastest completion), unless their request already states the choice. Never choose that first preference silently.",
      "After the first council, omit costPolicy to reuse the session preference. Supply it again only when the user explicitly changes preference.",
      "When a durable capability audit is missing, materially stale, or explicitly requested, use an already available web/research tool to assess only callable models and verified provider access/billing methods, then pass a dated, sourced modelAssessment. Never install a web tool or third-party package automatically.",
    ],
    parameters: Type.Object({
      task: TaskText,
      maxExperts: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      costPolicy: Type.Optional(CostPolicySchema),
      minimumContextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
      modelAssessment: Type.Optional(ModelAssessment),
      detail: Detail,
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const previousPreference = sessionAssemblyPreference(ctx);
      const requestedPreference = params.costPolicy as CostPolicy | undefined;
      if (!previousPreference && !requestedPreference) {
        return output({
          status: "preference-required",
          question: "这是本对话第一次组建专家委员会。请选择组建方式：价格优先、综合价格/时间/成功率，或速度优先。",
          choices: [
            { costPolicy: "economy", label: "价格优先", description: "优先最低有效边际成本。" },
            { costPolicy: "balanced", label: "综合平衡", description: "平衡价格、完成时间与成功率。" },
            { costPolicy: "speed", label: "速度优先", description: "优先最快完成。" },
          ],
        });
      }
      const costPolicy = requestedPreference ?? previousPreference!;
      if (requestedPreference && requestedPreference !== previousPreference) {
        pi.appendEntry(ASSEMBLY_PREFERENCE_ENTRY, { costPolicy: requestedPreference, recordedAt: new Date().toISOString() });
      }
      const plan = await (await getCouncil(ctx.cwd)).buildCouncil({
        task: params.task,
        ...(params.modelAssessment ? { modelAssessment: params.modelAssessment } : {}),
        ...(params.maxExperts !== undefined || params.costPolicy !== undefined || params.minimumContextWindow !== undefined ? {
          constraints: {
            ...(params.maxExperts ? { maxExperts: params.maxExperts } : {}),
            costPolicy,
            ...(params.minimumContextWindow ? { minimumContextWindow: params.minimumContextWindow } : {}),
          },
        } : { constraints: { costPolicy } }),
      });
      return output({
        ...presentCouncilPlan(plan, params.detail),
        assemblyPreference: {
          costPolicy,
          source: requestedPreference ? "user-selected" : "reused-from-session",
        },
      });
    },
  });

  pi.registerTool({
    name: "expert_delegate",
    label: "Expert Delegate",
    description: "Start one or up to eight bounded semantic expert assignments in the background and immediately return execution IDs.",
    promptGuidelines: [
      "Dispatch every independent assignment selected for the current batch before ending the turn; prefer the assignments array when two or more tasks are ready.",
      "Pass assignments as a real JSON array, never as a quoted or stringified JSON value.",
      "After expert_delegate reports that a task has completed, call expert_result with its executionId before using the feedback.",
      "After verifying the completed result, call expert_feedback with the same executionId and verification outcome so local routing can learn.",
      "Native Pi completion notifications wake the Main Agent automatically; after dispatching background work, stop the turn instead of polling or silently waiting when no other useful work remains.",
    ],
    parameters: Type.Object({
      role: Type.Optional(Role),
      task: Type.Optional(TaskText),
      taskDescription: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Optional concise host-facing label included in the completion notification.",
      })),
      councilId: Type.Optional(ExecutionIdentifier),
      workspace: Type.Optional(WorkspacePath),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
      assignments: Type.Optional(Type.Array(DelegationAssignment, { minItems: 1, maxItems: 8 })),
    }, { additionalProperties: false }),
    prepareArguments(args) {
      if (!args || typeof args !== "object" || Array.isArray(args)) return args as never;
      const candidate = args as Record<string, unknown>;
      return { ...candidate, assignments: parseStringifiedAssignments(candidate.assignments) } as never;
    },
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const council = await getCouncil(ctx.cwd);
      const rawAssignments = parseStringifiedAssignments(
        (params as typeof params & { assignments?: unknown }).assignments,
      );
      if (rawAssignments !== undefined && !Array.isArray(rawAssignments)) {
        throw new Error("expert_delegate assignments must be a JSON array, not a string or object.");
      }
      const batch = Array.isArray(rawAssignments);
      if (batch && (params.role !== undefined || params.task !== undefined)) {
        throw new Error("expert_delegate accepts either assignments or a single role/task pair, not both.");
      }
      if (!batch && (!params.role || !params.task)) {
        throw new Error("expert_delegate requires a non-empty assignments array or both role and task for one assignment.");
      }
      const requestedAssignments: DelegationAssignmentInput[] = batch ? rawAssignments as DelegationAssignmentInput[] : [{
        role: params.role!,
        task: params.task!,
        ...(params.taskDescription ? { taskDescription: params.taskDescription } : {}),
        ...(params.councilId ? { councilId: params.councilId } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      }];
      const assignments = requestedAssignments.map((assignment): DelegationRequest => ({
        role: assignment.role as ExpertRole,
        task: assignment.task,
        ...(assignment.taskDescription ? { taskDescription: assignment.taskDescription } : {}),
        ...(assignment.councilId ? { councilId: assignment.councilId } : {}),
        ...(assignment.workspace ? { workspace: assignment.workspace } : {}),
        ...(assignment.timeoutMs ? { timeoutMs: assignment.timeoutMs } : {}),
      }));
      const receipts = assignments.map((assignment) => {
        const handle = council.startDelegation(assignment);
        void handle.result.then(() => {
          try {
            const delivery = ctx.isIdle() ? "followUp" : "steer";
            const notification = {
              executionId: handle.executionId,
              ...(assignment.taskDescription ? { taskDescription: assignment.taskDescription } : {}),
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
        return {
          executionId: handle.executionId,
          role: assignment.role,
          ...(assignment.taskDescription ? { taskDescription: assignment.taskDescription } : {}),
          status: "running" as const,
        };
      });
      return output(batch
        ? { status: "running", executions: receipts }
        : { executionId: receipts[0]!.executionId, status: "running" });
    },
  });

  pi.registerTool({
    name: "expert_result",
    label: "Expert Result",
    description: "Retrieve completed expert feedback by execution ID, or report that the task is still running or unknown.",
    parameters: Type.Object({
      executionId: ExecutionIdentifier,
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await getCouncil(ctx.cwd)).getResult(params.executionId));
    },
  });

  pi.registerTool({
    name: "expert_feedback",
    label: "Expert Feedback",
    description: "Record whether Main Agent verification accepted a completed expert result for local routing telemetry.",
    parameters: Type.Object({
      executionId: ExecutionIdentifier,
      verificationPassed: Type.Boolean(),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await getCouncil(ctx.cwd)).recordFeedback(params));
    },
  });

  pi.registerTool({
    name: "expert_cleanup",
    label: "Expert Cleanup",
    description: "Remove an isolated mutation worktree after its result has been integrated or rejected.",
    parameters: Type.Object({
      executionId: ExecutionIdentifier,
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await getCouncil(ctx.cwd)).cleanup(params.executionId));
    },
  });

  pi.registerTool({
    name: "expert_escalate",
    label: "Expert Escalate",
    description: "Choose a corrected retry, alternative model, or bounded stop from failure evidence.",
    parameters: Type.Object({
      role: Role,
      task: TaskText,
      currentModel: Type.String({ minLength: 3, maxLength: 500, pattern: "^[^\\x00]+$" }),
      previousFailures: Type.Array(Type.Object({
        model: Type.String({ minLength: 1, maxLength: 500, pattern: "^[^\\x00]+$" }),
        type: Failure,
        summary: Type.String({ minLength: 1, maxLength: 2000, pattern: "^[^\\x00]+$" }),
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
