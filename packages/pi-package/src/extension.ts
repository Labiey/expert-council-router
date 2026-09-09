import {
  evaluateModelAssessment,
  MODEL_ASSESSMENT_JSON_SCHEMA,
  presentCouncilPlan,
  presentResourceInventory,
  resolveModelAssessment,
  type CostPolicy,
  type DelegationRequest,
  type ExpertCouncil,
  type ExpertRole,
  type FailureType,
  type ModelAssessmentSnapshot,
} from "@expert-council/core";
import { createExpertCouncil } from "@expert-council/pi-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";

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
const ModelAssessment = Type.Unsafe<ModelAssessmentSnapshot>(MODEL_ASSESSMENT_JSON_SCHEMA as TSchema);
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

function omitEmptyModelAssessment(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const candidate = args as Record<string, unknown>;
  const assessment = candidate.modelAssessment;
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) return args;
  const models = (assessment as Record<string, unknown>).models;
  if (!models || typeof models !== "object" || Array.isArray(models) || Object.keys(models).length > 0) return args;
  const { modelAssessment: _ignored, ...rest } = candidate;
  return rest;
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
  model: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 200,
    pattern: "^[^/]+/[^/]+$",
    description: "Optional model pin: one provider/id key from the role's composition pool for single or concurrent dispatch.",
  })),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 3600000 }),
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

  /** Pi session identity: stable across resume/continue, so persisted per-session route policies reattach. */
  const sessionKeyOf = (ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): string => {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      return id && id.length >= 1 && id.length <= 200 ? id : "default";
    } catch {
      return "default";
    }
  };

  pi.registerTool({
    name: "expert_inspect",
    label: "Expert Inspect",
    description: "Inspect a compact summary of callable Pi resources. Request full detail only when exact model metadata is required.",
    parameters: Type.Object({ detail: Detail }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const inventory = await (await getCouncil(ctx.cwd)).inspectResources({ sessionKey: sessionKeyOf(ctx) });
      return output(presentResourceInventory(inventory, params.detail));
    },
  });

  pi.registerTool({
    name: "expert_build",
    label: "Expert Build",
    description: "Build a small deterministic expert council. A current complete model assessment is mandatory; the first council in a Pi conversation offers saved compositions plus an auto (cost policy) option.",
    promptGuidelines: [
      "Before the first council in a conversation, present the composition menu returned by the tool: saved compositions plus the auto option. The auto option asks the user once to choose economy (lowest effective cost), balanced (cost/time/success), or speed (fastest completion); never choose that first preference silently. Saved compositions are already the user's stated roster.",
      "After the first council, omit composition and costPolicy to reuse the session choice. Supply either again only when the user explicitly changes it.",
      "When the model-assessment gate reports missing, stale, or inventory-changed, do not build or delegate. Use an already available web/research tool for researchModels only, preserve saved scores for other requiredModels entries, then retry once with a complete dated, sourced modelAssessment. Never install a web tool or third-party package automatically.",
      "Use the actual host clock for modelAssessment.asOf and 1 to 12 consolidated source URLs. If the gate reports future-dated, keep the existing evidence and scores, correct only the timestamp, and do not browse again.",
      "When expert_inspect reports modelAssessment.status='current', omit modelAssessment from expert_build and reuse the saved snapshot. Never send an empty or reconstructed assessment.",
    ],
    parameters: Type.Object({
      task: TaskText,
      maxExperts: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      costPolicy: Type.Optional(CostPolicySchema),
      composition: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 80,
        description: "Name of a saved council composition from council-compositions.json; restricts each role's candidate pool.",
      })),
      minimumContextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
      modelAssessment: Type.Optional(ModelAssessment),
      detail: Detail,
    }),
    prepareArguments(args) {
      return omitEmptyModelAssessment(args) as never;
    },
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const previousPreference = sessionAssemblyPreference(ctx);
      const requestedPreference = params.costPolicy as CostPolicy | undefined;
      const requestedComposition = params.composition as string | undefined;
      if (requestedPreference && requestedPreference !== previousPreference) {
        pi.appendEntry(ASSEMBLY_PREFERENCE_ENTRY, { costPolicy: requestedPreference, recordedAt: new Date().toISOString() });
      }
      const costPolicy = requestedPreference ?? previousPreference;
      const council = await getCouncil(ctx.cwd);
      const inventory = await council.inspectResources();
      const assessment = resolveModelAssessment(
        inventory.models,
        inventory.modelAssessment,
        params.modelAssessment,
      );
      if (assessment.status.status === "required") {
        return output({
          ...assessment.status,
          assessmentStatus: assessment.status.status,
          status: "model-assessment-required",
          providerBilling: inventory.billing,
          billingSources: inventory.billingSources,
          warning: "expert_build did not assemble a council. Complete the required web audit, then retry once with modelAssessment.",
        });
      }
      // With neither a composition nor an established cost policy the service
      // returns a bounded composition menu instead of a cost-policy reminder.
      const plan = await council.buildCouncil({
        task: params.task,
        sessionKey: sessionKeyOf(ctx),
        ...(requestedComposition ? { composition: requestedComposition } : {}),
        ...(assessment.source === "submitted" && assessment.assessment
          ? { modelAssessment: assessment.assessment }
          : {}),
        ...(costPolicy || params.maxExperts !== undefined || params.minimumContextWindow !== undefined
          ? {
              constraints: {
                ...(params.maxExperts ? { maxExperts: params.maxExperts } : {}),
                ...(costPolicy ? { costPolicy } : {}),
                ...(params.minimumContextWindow ? { minimumContextWindow: params.minimumContextWindow } : {}),
              },
            }
          : {}),
      });
      return output({
        ...presentCouncilPlan({
          ...plan,
          warnings: [
            ...plan.warnings,
            ...(assessment.ignoredSubmittedAssessment
              ? ["Ignored an incomplete, stale, or future-dated submitted modelAssessment and reused the current saved assessment."]
              : []),
          ],
        }, params.detail),
        ...(plan.compositionMenu
          ? {
              status: "composition-menu-required",
              guidance: "Present these saved compositions plus the auto option to the user. Pass the chosen name back as composition; the auto option asks the cost policy once.",
            }
          : {}),
        ...(costPolicy
          ? {
              assemblyPreference: {
                costPolicy,
                source: requestedPreference ? "user-selected" : "reused-from-session",
              },
            }
          : {}),
      });
    },
  });

  pi.registerTool({
    name: "expert_delegate",
    label: "Expert Delegate",
    description: "Start one or up to eight bounded semantic expert assignments in the background and immediately return execution IDs. timeoutMs is required for every assignment: set it explicitly from task difficulty (read-only investigation 5–15 min, implementation/debugging 30–60 min).",
    promptGuidelines: [
      "Dispatch every independent assignment selected for the current batch before ending the turn; prefer the assignments array when two or more tasks are ready.",
      "model is optional: pin one model from the role's composition pool per assignment to dispatch several same-role experts concurrently, one per model.",
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
      model: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 200,
        pattern: "^[^/]+/[^/]+$",
        description: "Optional model pin: one provider/id key from the role's composition pool for single or concurrent dispatch.",
      })),
      timeoutMs: Type.Integer({ minimum: 1000, maximum: 3600000 }),
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
      const inventory = await council.inspectResources({ sessionKey: sessionKeyOf(ctx) });
      const assessmentStatus = evaluateModelAssessment(inventory.models, inventory.modelAssessment);
      if (assessmentStatus.status === "required") {
        return output({
          ...assessmentStatus,
          assessmentStatus: assessmentStatus.status,
          status: "model-assessment-required",
          providerBilling: inventory.billing,
          billingSources: inventory.billingSources,
          warning: "expert_delegate did not start any execution. Complete the required web audit through expert_build first.",
        });
      }
      const requestedAssignments: DelegationAssignmentInput[] = batch ? rawAssignments as DelegationAssignmentInput[] : [{
        role: params.role!,
        task: params.task!,
        ...(params.taskDescription ? { taskDescription: params.taskDescription } : {}),
        ...(params.councilId ? { councilId: params.councilId } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.model ? { model: params.model } : {}),
        timeoutMs: params.timeoutMs,
      }];
      const assignments = requestedAssignments.map((assignment): DelegationRequest => ({
        role: assignment.role as ExpertRole,
        task: assignment.task,
        sessionKey: sessionKeyOf(ctx),
        ...(assignment.taskDescription ? { taskDescription: assignment.taskDescription } : {}),
        ...(assignment.councilId ? { councilId: assignment.councilId } : {}),
        ...(assignment.workspace ? { workspace: assignment.workspace } : {}),
        ...(assignment.model ? { model: assignment.model } : {}),
        timeoutMs: assignment.timeoutMs,
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
    description: "Retrieve completed expert feedback by execution ID, or report that the task is still running or unknown. Pass includeProgress while a task is still running to receive a bounded progress snapshot (last assistant output, elapsed time, files changed so far) for verification, handoff, or intervention decisions.",
    parameters: Type.Object({
      executionId: ExecutionIdentifier,
      includeProgress: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const council = await getCouncil(ctx.cwd);
      const lookup = await council.getResult(params.executionId);
      if (lookup.status === "running" && params.includeProgress) {
        const progress = await council.inspectExecution(params.executionId);
        if (progress) return output(progress);
      }
      return output(lookup);
    },
  });

  pi.registerTool({
    name: "expert_abort",
    label: "Expert Abort",
    description: "Deliberately stop a running expert execution whose direction no longer matches expectations. The attempt is marked aborted and never retried or escalated, completed work such as a mutation worktree stays preserved until expert_cleanup, and the returned progress snapshot doubles as the handoff brief for a follow-up delegation. Verify in-progress work first with expert_result includeProgress.",
    parameters: Type.Object({
      executionId: ExecutionIdentifier,
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return output(await (await getCouncil(ctx.cwd)).abortExecution({
        executionId: params.executionId,
        ...(params.reason ? { reason: params.reason } : {}),
      }));
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
    description: "Remove every retry/escalation worktree for an execution after its result has been integrated or rejected. Integrate changes from the result's filesChanged list (it already includes untracked new files) — never from `git diff HEAD` alone.",
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
