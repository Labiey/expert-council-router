import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fileURLToPath } from "node:url";
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

type CouncilProvider = () => Promise<ExpertCouncil>;
export type WorkspaceRootProvider = () => Promise<string[]>;

function createMcpServerWithProvider(councilProvider: CouncilProvider): McpServer {
  const server = new McpServer({ name: "expert-council", version: "0.3.0" });

  server.registerTool(
    "expert_inspect",
    {
      title: "Inspect Expert Resources",
      description: "Inspect a compact summary of callable Pi resources. Request full detail only when exact model metadata is required.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_inspect,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const council = await councilProvider();
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
      description: "Classify a task and deterministically assemble a small semantic expert team. A current, complete, dated Main Agent model assessment is mandatory.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_build,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const council = await councilProvider();
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
      description: "Start one or up to eight bounded Pi expert assignments in the background and immediately return execution IDs. Set each timeoutMs explicitly from task difficulty.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_delegate,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const council = await councilProvider();
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
      return response(input.assignments
        ? { status: "running", executions: receipts }
        : { executionId: receipts[0]!.executionId, status: "running" });
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
    async (input) => {
      const council = await councilProvider();
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
      description: "Retrieve completed expert feedback by execution ID, or report that the task is still running or unknown.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_result,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const council = await councilProvider();
      return response(await withMcpTimeout(council.getResult(input.executionId)));
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
    async (input) => {
      const council = await councilProvider();
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
    async (input) => {
      const council = await councilProvider();
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
    async (input) => {
      const council = await councilProvider();
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
    async () => {
      const council = await councilProvider();
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
  fallbackWorkspaceRoots?: WorkspaceRootProvider,
): McpServer {
  const configuredWorkspace = options.cwd;
  const councilCache = new Map<string, Promise<ExpertCouncil>>();
  let server: McpServer;

  const councilProvider: CouncilProvider = async () => {
    let workspaceRoots: string[];
    if (configuredWorkspace) {
      workspaceRoots = [configuredWorkspace];
    } else {
      if (server.server.getClientCapabilities()?.roots) {
        workspaceRoots = fileWorkspaceRoots((await withMcpTimeout(server.server.listRoots(), 10_000)).roots);
      } else {
        workspaceRoots = [];
      }
      if (!workspaceRoots.length && fallbackWorkspaceRoots) {
        workspaceRoots = await withMcpTimeout(fallbackWorkspaceRoots(), 10_000);
      }
      if (!workspaceRoots.length) {
        throw new Error(
          "No trusted local workspace was supplied by MCP roots or the Codex workspace hook. Trust the bundled hook and retry in a local project, or configure EXPERT_COUNCIL_WORKSPACE explicitly. Expert Council will not use its plugin installation directory.",
        );
      }
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
