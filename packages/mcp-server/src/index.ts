import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExpertCouncil, ExpertRole, FailureType } from "@expert-council/core";
import { createExpertCouncil, type CreateCouncilOptions } from "@expert-council/pi-runtime";
import { z } from "zod";

export const MCP_TOOL_NAMES = [
  "expert_inspect",
  "expert_build",
  "expert_delegate",
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

export const MCP_INPUT_SCHEMAS = {
  expert_build: {
    task: z.string().min(1).describe("The host-level task to analyze"),
    constraints: z.object({
      maxExperts: z.number().int().min(1).max(8).optional(),
      costPolicy: z.enum(["economy", "balanced", "quality"]).optional(),
      minimumContextWindow: z.number().int().positive().optional(),
    }).optional(),
  },
  expert_delegate: {
    role,
    task: z.string().min(1).describe("A bounded semantic assignment"),
    taskDescription: z.string().min(1).max(500).optional().describe("An optional concise host-facing label for the background task"),
    councilId: z.string().optional(),
    workspace: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  },
  expert_result: {
    executionId: z.string().min(1),
  },
  expert_cleanup: {
    executionId: z.string().min(1),
  },
  expert_feedback: {
    executionId: z.string().min(1),
    verificationPassed: z.boolean(),
  },
  expert_escalate: {
    role,
    task: z.string().min(1),
    currentModel: z.string().min(3),
    previousFailures: z.array(z.object({
      model: z.string().min(3),
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

export function createMcpServer(council: ExpertCouncil): McpServer {
  const server = new McpServer({ name: "expert-council", version: "0.1.0" });

  server.registerTool(
    "expert_inspect",
    {
      title: "Inspect Expert Resources",
      description: "Inspect currently callable Pi models, billing policy, roles, installed skills, and runtime capabilities.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => response(await withMcpTimeout(council.inspectResources())),
  );
  server.registerTool(
    "expert_build",
    {
      title: "Build Expert Council",
      description: "Classify a task and deterministically assemble a small cost-aware semantic expert team.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_build,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => response(await withMcpTimeout(council.buildCouncil(input))),
  );
  server.registerTool(
    "expert_delegate",
    {
      title: "Delegate Expert Task",
      description: "Start one bounded Pi expert assignment in the background and immediately return its execution ID.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_delegate,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const handle = council.startDelegation({
        role: input.role as ExpertRole,
        task: input.task,
        ...(input.taskDescription ? { taskDescription: input.taskDescription } : {}),
        ...(input.councilId ? { councilId: input.councilId } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      return response({ executionId: handle.executionId, status: "running" });
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
    async (input) => response(await withMcpTimeout(council.getResult(input.executionId))),
  );
  server.registerTool(
    "expert_feedback",
    {
      title: "Record Expert Outcome Feedback",
      description: "Record whether Main Agent verification accepted a completed expert result for local routing telemetry.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_feedback,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => response(await withMcpTimeout(council.recordFeedback(input))),
  );
  server.registerTool(
    "expert_cleanup",
    {
      title: "Clean Up Expert Workspace",
      description: "Remove an isolated mutation worktree after its result has been integrated or rejected.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_cleanup,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => response(await withMcpTimeout(council.cleanup(input.executionId))),
  );
  server.registerTool(
    "expert_escalate",
    {
      title: "Escalate Expert Failure",
      description: "Choose a corrected retry, the next eligible model, or a bounded stop from structured failure evidence.",
      inputSchema: MCP_INPUT_SCHEMAS.expert_escalate,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => response(await withMcpTimeout(council.escalate({
      role: input.role as ExpertRole,
      task: input.task,
      currentModel: input.currentModel,
      previousFailures: input.previousFailures.map((failure) => ({
        model: failure.model,
        type: failure.type as FailureType,
        summary: failure.summary,
      })),
    }))),
  );
  server.registerTool(
    "expert_status",
    {
      title: "Expert Council Status",
      description: "Return compact durable plans, execution states, and local aggregate outcomes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => response(await withMcpTimeout(council.getStatus())),
  );
  return server;
}

export async function createDefaultMcpServer(options: CreateCouncilOptions = {}): Promise<McpServer> {
  return createMcpServer(await createExpertCouncil(options));
}
