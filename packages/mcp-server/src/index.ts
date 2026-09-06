import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  evaluateModelAssessment,
  modelAssessmentSnapshotSchema,
  presentCouncilPlan,
  presentResourceInventory,
  resolveModelAssessment,
  type DelegationRequest,
  type ExpertCouncil,
  type ExpertRole,
  type FailureType,
} from "@expert-council/core";
import { createExpertCouncil, type CreateCouncilOptions } from "@expert-council/pi-runtime";
import { z } from "zod";

export const MCP_TOOL_NAMES = [
  "expert_inspect",
  "expert_build",
  "expert_delegate",
  "expert_wait",
  "expert_result",
  "expert_abort",
  "expert_feedback",
  "expert_cleanup",
  "expert_escalate",
  "expert_status",
] as const;

const role = z.enum([
  "planner",
  "scout",
  "architecture-oracle",
  "implementation-worker",
  "debugger",
  "reviewer",
  "verifier",
]);
const failureType = z.enum([
  "tool_call_error",
  "reasoning_failure",
  "test_failure",
  "timeout",
  "provider_error",
  "missing_context",
  "permission_error",
  "unknown",
]);
const detail = z.enum(["compact", "full"]).optional();
const boundedText = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => !value.includes("\0"),
  { message: "must not contain NUL bytes" },
);
const taskText = boundedText(100_000);
const workspacePath = boundedText(32_768);
const executionIdentifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const delegationAssignment = z.object({
  role,
  task: taskText.describe("A bounded semantic assignment"),
  taskDescription: boundedText(500).optional().describe("An optional concise host-facing label for the background task"),
  councilId: executionIdentifier.optional(),
  workspace: workspacePath.optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional()
    .describe("Explicit expert execution deadline chosen for this assignment's difficulty"),
});

export const MCP_INPUT_SCHEMAS = {
  expert_inspect: {
    detail,
  },
  expert_build: {
    task: taskText.describe("The host-level task to analyze"),
    constraints: z.object({
      maxExperts: z.number().int().min(1).max(8).optional(),
      costPolicy: z.enum(["economy", "balanced", "speed", "quality"]).optional(),
      minimumContextWindow: z.number().int().positive().optional(),
    }).optional(),
    modelAssessment: modelAssessmentSnapshotSchema.optional(),
    detail,
  },
  expert_delegate: {
    role: role.optional().describe("Required for a single assignment; omit when assignments is provided"),
    task: taskText.optional().describe("Required for a single assignment; omit when assignments is provided"),
    taskDescription: boundedText(500).optional().describe("An optional concise host-facing label for the background task"),
    councilId: executionIdentifier.optional(),
    workspace: workspacePath.optional(),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).optional()
      .describe("Explicit expert execution deadline chosen for this assignment's difficulty"),
    assignments: z.array(delegationAssignment).min(1).max(8).optional()
      .describe("Use for two or more independent assignments so all are dispatched before the host turn ends"),
  },
  expert_wait: {
    executionIds: z.array(executionIdentifier).min(1).max(8)
      .refine((ids) => new Set(ids).size === ids.length, { message: "executionIds must be unique" })
      .describe("Execution IDs returned by expert_delegate"),
    mode: z.enum(["any", "all"]).optional().describe("Wait for any execution or all executions; defaults to all"),
    timeoutMs: z.number().int().min(1_000).max(3_600_000)
      .describe("Bounded wait selected from expected remaining task difficulty; this does not extend expert execution deadlines"),
  },
  expert_result: {
    executionId: executionIdentifier,
    includeProgress: z.boolean().optional(),
  },
  expert_abort: {
    executionId: executionIdentifier,
    reason: z.string().min(1).max(1_000).optional(),
  },
  expert_cleanup: {
    executionId: executionIdentifier,
  },
  expert_feedback: {
    executionId: executionIdentifier,
    verificationPassed: z.boolean(),
  },
  expert_escalate: {
    role,
    task: taskText,
    currentModel: boundedText(500),
    previousFailures: z.array(z.object({
      model: boundedText(500),
      type: failureType,
      summary: z.string().min(1).max(2_000),
    })).min(1).max(8),
  },
} as const;

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const configuredTimeout = Number.parseInt(process.env.EXPERT_COUNCIL_MCP_TIMEOUT_MS ?? "30000", 10);
const MCP_TOOL_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000
  ? configuredTimeout
  : 30_000;

export async function withMcpTimeout<T>(operation: Promise<T>, timeoutMs = MCP_TOOL_TIMEOUT_MS): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error(`Expert Council MCP tool timed out after ${timeoutMs}ms.`)), {
      once: true,
    });
  });
  return Promise.race([operation, timeout]);
}

export const CODEX_SANDBOX_STATE_META_CAPABILITY = "codex/sandbox-state-meta";

type CouncilProvider = (requestContext?: unknown) => Promise<ExpertCouncil>;

function createMcpServerWithProvider(councilProvider: CouncilProvider): McpServer {
  const server = new McpServer(
    { name: "expert-council", version: "0.5.4" },
    { capabilities: { experimental: { [CODEX_SANDBOX_STATE_META_CAPABILITY]: {} } } },
  );
  // A stdio server process serves exactly one host conversation, so this
  // session-scoped flag is the reliable in-band channel for the cost-policy
  // establishment requirement even when the host skips expert_build.
  const session = { costPolicyEstablished: false };
  const COST_POLICY_REMINDER = "No cost policy has been established in this conversation. Ask the user once whether to optimize for economy, balanced, or speed, then pass it as constraints.costPolicy to expert_build and reuse the answer for later councils and delegations.";

  server.registerTool(
    "expert_inspect",
    {
      title: "Inspect Expert Resources",
      description: "Inspect a compact summary of callable Pi resources. Request full detail only when exact model metadata is required.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_inspect,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      return response(presentResourceInventory(
        await withMcpTimeout(council.inspectResources()),
        input.detail,
      ));
    },
  );
  server.registerTool(
    "expert_build",
    {
      title: "Build Expert Council",
      description: "Classify a task and deterministically assemble a small semantic expert team. A current, complete, dated Main Agent model assessment is mandatory. Before the first council in a conversation, establish exactly one cost policy with the user — economy (lowest effective cost), balanced (cost, time, and success probability), or speed (fastest completion) — and pass it as constraints.costPolicy; reuse the answer for later councils in this conversation. When costPolicy is omitted, the response includes a reminder to ask.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_build,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      const inventory = await withMcpTimeout(council.inspectResources());
      const assessment = resolveModelAssessment(
        inventory.models,
        inventory.modelAssessment,
        input.modelAssessment,
      );
      if (assessment.status.status === "required") {
        return response({
          ...assessment.status,
          assessmentStatus: assessment.status.status,
          status: "model-assessment-required",
          providerBilling: inventory.billing,
          billingSources: inventory.billingSources,
          warning: "expert_build did not assemble a council. Complete the required web audit, then retry once with modelAssessment.",
        });
      }
      const plan = await withMcpTimeout(council.buildCouncil({
        task: input.task,
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(assessment.source === "submitted" && assessment.assessment
          ? { modelAssessment: assessment.assessment }
          : {}),
      }));
      if (input.constraints?.costPolicy) session.costPolicyEstablished = true;
      return response(presentCouncilPlan({
        ...plan,
        warnings: [
          ...plan.warnings,
          ...(assessment.ignoredSubmittedAssessment
            ? ["Ignored an incomplete, stale, or future-dated submitted modelAssessment and reused the current saved assessment."]
            : []),
        ],
      }, input.detail));
    },
  );
  server.registerTool(
    "expert_delegate",
    {
      title: "Delegate Expert Task",
      description: "Start one or up to eight bounded Pi expert assignments in the background and immediately return execution IDs. Prefer this over doing substantial multi-file investigation, implementation, review, or debugging inline whenever delegation saves Main Agent context or model quota; for a substantial task with no council yet, call expert_build first to classify it and size the team. Before the first delegation or council in a conversation, establish one cost policy with the user — economy, balanced, or speed — via expert_build's constraints.costPolicy; until then every response carries a reminder to ask. Set each timeoutMs explicitly from task difficulty.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_delegate,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      if (input.assignments && (input.role || input.task)) {
        throw new Error("expert_delegate accepts either role/task or assignments, not both");
      }
      if (!input.assignments && (!input.role || !input.task)) {
        throw new Error("expert_delegate requires role/task or a non-empty assignments array");
      }
      const inventory = await withMcpTimeout(council.inspectResources());
      const assessmentStatus = evaluateModelAssessment(inventory.models, inventory.modelAssessment);
      if (assessmentStatus.status === "required") {
        return response({
          ...assessmentStatus,
          assessmentStatus: assessmentStatus.status,
          status: "model-assessment-required",
          providerBilling: inventory.billing,
          billingSources: inventory.billingSources,
          warning: "expert_delegate did not start any execution. Complete the required web audit through expert_build first.",
        });
      }
      const assignments: DelegationRequest[] = input.assignments
        ? input.assignments.map((assignment) => ({
          ...assignment,
          role: assignment.role as ExpertRole,
        }))
        : [{
          role: input.role as ExpertRole,
          task: input.task!,
          ...(input.taskDescription ? { taskDescription: input.taskDescription } : {}),
          ...(input.councilId ? { councilId: input.councilId } : {}),
          ...(input.workspace ? { workspace: input.workspace } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        }];
      const receipts = assignments.map((assignment) => {
        const handle = council.startDelegation(assignment);
        return {
          executionId: handle.executionId,
          role: assignment.role,
          ...(assignment.taskDescription ? { taskDescription: assignment.taskDescription } : {}),
          status: "running" as const,
        };
      });
      const reminders = session.costPolicyEstablished ? [] : [COST_POLICY_REMINDER];
      return response(input.assignments
        ? { status: "running", executions: receipts, ...(reminders.length ? { reminders } : {}) }
        : { executionId: receipts[0]!.executionId, status: "running", ...(reminders.length ? { reminders } : {}) });
    },
  );
  server.registerTool(
    "expert_wait",
    {
      title: "Wait for Expert Completion",
      description: "After all other useful host work is finished, wait without polling for any or all background expert executions. Choose a finite timeoutMs from expected remaining task difficulty, then use expert_result for feedback.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_wait,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      return response(await council.waitForResults({
        executionIds: input.executionIds,
        ...(input.mode ? { mode: input.mode } : {}),
        timeoutMs: input.timeoutMs,
      }));
    },
  );
  server.registerTool(
    "expert_result",
    {
      title: "Get Expert Result",
      description: "Retrieve completed expert feedback by execution ID, or report that the task is still running or unknown. Pass includeProgress while a task is still running to receive a bounded progress snapshot (last assistant output, elapsed time, files changed so far) for verification, handoff, or intervention decisions.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_result,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      const lookup = await withMcpTimeout(council.getResult(input.executionId));
      if (lookup.status === "running" && input.includeProgress) {
        const progress = await withMcpTimeout(council.inspectExecution(input.executionId)).catch(() => undefined);
        if (progress) return response(progress);
      }
      return response(lookup);
    },
  );
  server.registerTool(
    "expert_abort",
    {
      title: "Abort Expert Execution",
      description: "Deliberately stop a running expert execution whose direction no longer matches expectations. The attempt is marked aborted and never retried or escalated, completed work such as a mutation worktree stays preserved until expert_cleanup, and the returned progress snapshot doubles as the handoff brief for a follow-up delegation. Verify in-progress work first with expert_result includeProgress.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_abort,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      return response(await withMcpTimeout(council.abortExecution({
        executionId: input.executionId,
        ...(input.reason ? { reason: input.reason } : {}),
      })));
    },
  );
  server.registerTool(
    "expert_feedback",
    {
      title: "Record Expert Outcome Feedback",
      description: "Record whether Main Agent verification accepted a completed expert result for local routing telemetry.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_feedback,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      return response(await withMcpTimeout(council.recordFeedback(input)));
    },
  );
  server.registerTool(
    "expert_cleanup",
    {
      title: "Clean Up Expert Workspace",
      description: "Remove every retry/escalation worktree for an execution after its result has been integrated or rejected.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_cleanup,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      return response(await withMcpTimeout(council.cleanup(input.executionId)));
    },
  );
  server.registerTool(
    "expert_escalate",
    {
      title: "Escalate Expert Failure",
      description: "Choose a corrected retry, the next eligible model, or a bounded stop from structured failure evidence.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_escalate,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      const council = await councilProvider(extra);
      return response(await withMcpTimeout(council.escalate({
        role: input.role as ExpertRole,
        task: input.task,
        currentModel: input.currentModel,
        previousFailures: input.previousFailures.map((failure) => ({
          model: failure.model,
          type: failure.type as FailureType,
          summary: failure.summary,
        })),
      })));
    },
  );
  server.registerTool(
    "expert_status",
    {
      title: "Expert Council Status",
      description: "Return compact durable plans, execution states, and local aggregate outcomes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (_input, extra) => {
      const council = await councilProvider(extra);
      return response(await withMcpTimeout(council.getStatus()));
    },
  );
  return server;
}

export function createMcpServer(council: ExpertCouncil): McpServer {
  return createMcpServerWithProvider(async () => council);
}

export async function createDefaultMcpServer(options: CreateCouncilOptions = {}): Promise<McpServer> {
  return createMcpServer(await createExpertCouncil(options));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nearestMarkerDirectory(start: string, markers: readonly string[]): string | undefined {
  let current = start;
  while (true) {
    if (markers.some((marker) => existsSync(path.join(current, marker)))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function projectRootFromCwd(cwd: string): string {
  const canonical = realpathSync(cwd);
  if (!statSync(canonical).isDirectory()) {
    throw new Error("Codex sandbox metadata did not identify a local directory.");
  }
  return nearestMarkerDirectory(canonical, [".git", ".jj", ".hg"])
    ?? nearestMarkerDirectory(canonical, ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"])
    ?? canonical;
}

/**
 * Resolve the current Codex task workspace from host-owned MCP request metadata.
 * The value is deliberately read from the request context, never tool arguments.
 */
export function workspaceRootFromCodexSandbox(requestContext: unknown): string | undefined {
  const request = record(requestContext);
  const direct = record(request?._meta)?.[CODEX_SANDBOX_STATE_META_CAPABILITY];
  const requestInfo = record(request?.requestInfo);
  const forwarded = record(requestInfo?._meta)?.[CODEX_SANDBOX_STATE_META_CAPABILITY];

  if (direct !== undefined && forwarded !== undefined && !isDeepStrictEqual(direct, forwarded)) {
    throw new Error("Codex supplied conflicting sandbox metadata.");
  }
  if (direct === undefined && forwarded === undefined) return undefined;

  const state = record(direct ?? forwarded);
  if (!state || !record(state.permissionProfile)) {
    throw new Error("Codex supplied incomplete sandbox metadata.");
  }
  if (typeof state.sandboxCwd !== "string" || !state.sandboxCwd.trim() || state.sandboxCwd.includes("\0")) {
    throw new Error("Codex supplied an invalid sandbox working directory.");
  }

  let cwd: string;
  try {
    cwd = state.sandboxCwd.startsWith("file:")
      ? fileURLToPath(state.sandboxCwd)
      : state.sandboxCwd;
  } catch {
    throw new Error("Codex supplied an invalid sandbox working-directory URI.");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("Codex sandbox working directory must be absolute.");
  }
  return projectRootFromCwd(cwd);
}

function fileWorkspaceRoots(roots: Array<{ uri: string }>): string[] {
  const paths: string[] = [];
  for (const root of roots) {
    let url: URL;
    try {
      url = new URL(root.uri);
    } catch {
      continue;
    }
    if (url.protocol !== "file:") continue;
    const workspace = fileURLToPath(url);
    if (!paths.includes(workspace)) paths.push(workspace);
  }
  return paths;
}

export function createClientRootMcpServer(
  options: CreateCouncilOptions = {},
  councilFactory: (options: CreateCouncilOptions) => Promise<ExpertCouncil> = createExpertCouncil,
): McpServer {
  const configuredWorkspace = options.cwd;
  const councilCache = new Map<string, Promise<ExpertCouncil>>();
  let server: McpServer;

  const councilProvider: CouncilProvider = async (requestContext) => {
    let workspaceRoots: string[];
    if (server.server.getClientCapabilities()?.roots) {
      workspaceRoots = fileWorkspaceRoots((await withMcpTimeout(server.server.listRoots(), 10_000)).roots);
    } else {
      workspaceRoots = [];
    }
    if (!workspaceRoots.length) {
      const codexWorkspace = workspaceRootFromCodexSandbox(requestContext);
      if (codexWorkspace) workspaceRoots = [codexWorkspace];
    }
    if (!workspaceRoots.length && configuredWorkspace) {
      workspaceRoots = [configuredWorkspace];
    }
    if (!workspaceRoots.length) {
      throw new Error(
        "No trusted local workspace was supplied by MCP roots, Codex sandbox metadata, or EXPERT_COUNCIL_WORKSPACE. Expert Council will not use its plugin installation directory.",
      );
    }

    const cacheKey = JSON.stringify(workspaceRoots);
    let council = councilCache.get(cacheKey);
    if (!council) {
      council = councilFactory({
        ...options,
        cwd: workspaceRoots[0],
        trustedWorkspaceRoots: workspaceRoots,
      });
      councilCache.set(cacheKey, council);
      void council.catch(() => councilCache.delete(cacheKey));
    }
    return council;
  };

  server = createMcpServerWithProvider(councilProvider);
  return server;
}
