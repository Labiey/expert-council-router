import { z } from "zod";
import { expertRoleSchema, modelAssessmentSnapshotSchema } from "./config.js";
import type { CouncilStateSnapshot } from "./types.js";

const identifier = z.string().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
  message: "must not contain control characters",
});
const boundedText = (maximum: number) => z.string().max(maximum).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  { message: "must not contain unsafe control characters" },
);
const timestamp = z.string().min(1).max(100);
const taskClass = z.enum(["tiny", "normal", "complex-feature", "complex-debugging", "architecture"]);
const costPolicy = z.enum(["economy", "balanced", "speed", "quality"]);
const executionStatus = z.enum(["running", "success", "partial", "failed"]);
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

const candidate = z.object({
  model: identifier,
  provider: identifier,
  family: identifier.optional(),
  score: z.number().finite(),
  reasons: z.array(boundedText(2_000)).max(20),
  rejected: z.array(boundedText(2_000)).max(20).optional(),
  reasoningLevel: identifier.optional(),
}).strict();

const councilMember = z.object({
  role: expertRoleSchema,
  model: identifier,
  provider: identifier,
  family: identifier.optional(),
  score: z.number().finite(),
  reason: z.array(boundedText(2_000)).max(20),
  alternatives: z.array(candidate).max(20),
  tools: z.array(identifier).max(50),
  skills: z.array(identifier).max(50),
  readOnly: z.boolean(),
  reasoningLevel: identifier.optional(),
}).strict();

const councilPlan = z.object({
  id: identifier,
  taskClass,
  task: boundedText(100_000),
  experts: z.array(councilMember).max(8),
  createdAt: timestamp,
  warnings: z.array(boundedText(2_000)).max(100),
  costPolicy: costPolicy.optional(),
  inventoryFingerprint: boundedText(1_000_000).optional(),
}).strict();

const attempt = z.object({
  attempt: z.number().int().min(1).max(100),
  model: identifier,
  status: executionStatus,
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  failureType: failureType.optional(),
  summary: boundedText(500).optional(),
}).strict();

const execution = z.object({
  id: identifier,
  role: expertRoleSchema,
  status: executionStatus,
  model: identifier.optional(),
  attempts: z.number().int().min(0).max(100),
  attemptHistory: z.array(attempt).max(100).optional(),
  taskCategory: taskClass.optional(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
}).strict();

const testResult = z.object({
  command: boundedText(1_000).optional(),
  status: z.enum(["passed", "failed", "not-run"]),
  summary: boundedText(2_000).optional(),
}).strict();

const usage = z.record(
  identifier,
  z.union([z.number().finite(), boundedText(1_000), z.boolean(), z.null()]),
);

const expertResult = z.object({
  status: z.enum(["success", "partial", "failed"]),
  role: expertRoleSchema,
  model: identifier,
  summary: boundedText(4_000),
  filesChanged: z.array(boundedText(32_768)).max(1_000).optional(),
  tests: z.array(testResult).max(20).optional(),
  findings: z.array(boundedText(2_000)).max(20).optional(),
  risks: z.array(boundedText(2_000)).max(20).optional(),
  recommendedNextAction: boundedText(1_000).optional(),
  executionMetadata: z.object({
    executionId: identifier.optional(),
    attempts: z.number().int().min(0).max(100).optional(),
    failureType: failureType.optional(),
    usage: usage.optional(),
    durationMs: z.number().finite().min(0).optional(),
    workspace: boundedText(32_768).optional(),
    isolated: z.boolean().optional(),
    escalationCount: z.number().int().min(0).max(100).optional(),
  }).strict().optional(),
}).strict();

export const councilStateSnapshotSchema = z.object({
  version: z.literal(1),
  plans: z.array(councilPlan).max(1_000),
  executions: z.array(execution).max(10_000),
  results: z.array(z.object({ executionId: identifier, result: expertResult }).strict()).max(10_000),
  modelAssessment: modelAssessmentSnapshotSchema.optional(),
}).strict();

export function parseCouncilStateSnapshot(input: unknown): CouncilStateSnapshot {
  const parsed = councilStateSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`unsupported or malformed state snapshot: ${details}`);
  }
  return parsed.data as CouncilStateSnapshot;
}
