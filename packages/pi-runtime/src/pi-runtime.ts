import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { Type } from "typebox";
import path from "node:path";
import {
  CONTENT_LEVELS,
  TERMINAL_EVENT_KINDS,
  getRole,
  inferFailureType,
  inferFailureTypeFromSummary,
  normalizePiModels,
  type AbortExecutionRequest,
  type AbortExecutionResult,
  type AvailableModel,
  type CouncilConfig,
  type ExecutionProgress,
  type ExpertAttention,
  type ExpertEventKind,
  type ExpertExecutionRequest,
  type ExpertObservabilityEvent,
  type ExpertResult,
  type ExpertRole,
  type ExpertRuntime,
  type FailureType,
  type InteractionRequest,
  type InteractionResponse,
  type PendingInteraction,
  type RespondToInteractionResult,
  type RuntimeBillingDiscovery,
  type RuntimeCapabilities,
  type SkillInfo,
  type VerifyCommandRequest,
  type VerifyCommandResult,
  type WorkspaceProvisioningConfig
} from "@expert-council/core";
import {
  loadPiSdk,
  validatePiSdk,
  validatePiModelRuntime,
  validatePiSession,
  type PiModelRuntimeLike,
  type PiSdkLike,
  type PiSessionLike,
} from "./pi-sdk.js";
import { WorkspaceBoundary, runBoundedCommand, scrubProvisioningEnv, tailCommandOutput, type BoundedCommandRunner, type PreparedWorkspace, type WorkspaceProvisioningStatus } from "./workspace.js";
import { ObserverWindowLauncher, type ObserverWindowLauncherOptions } from "./window-launcher.js";
import { ContentRecorder, recordsToolArgs, resolveContentLevel } from "./content-stream.js";

export interface PiExpertRuntimeOptions {
  /**
   * Overrides for the opt-in observer window launcher. Only `spawn`, `platform` and
   * `resolveCli` are meaningful to callers: the test suite must never open a real window,
   * and an operator can point the follower at a specific CLI build.
   */
  observerWindow?: ObserverWindowLauncherOptions;
  cwd: string;
  config: CouncilConfig;
  roleDirectory?: string;
  sdk?: PiSdkLike;
  modelRuntime?: PiModelRuntimeLike;
  packageName?: string;
  /** Max decision/tool-approval interactions per execution before the expert is told to decide autonomously. Default 3. */
  maxInteractionRounds?: number;
  /** How long an expert may block awaiting a host response before continuing autonomously. Default 900000ms. */
  interactionTimeoutMs?: number;
  /**
   * Directory for the cross-process observability event stream, written only when
   * `security.observability.expertWindow` is `"interactive"`. Without it the tier
   * degrades to `"events"` and `getCapabilities` says so.
   */
  observabilityDir?: string;
}

/** Filler that must never be credited as delivered work in a stop report. */
function isPlaceholderText(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[.!]+$/, "");
  if (normalized.length < 4) return true;
  return /^(placeholder|placeholders|tbd|todo|n\/a|na|none|nothing|xxx+|\?+|\.+|\u2026)$/.test(normalized);
}

/** One terminal event per execution, so a watcher can stop on its own. */
function terminalKindFor(result: ExpertResult): ExpertEventKind {
  if (result.executionMetadata?.stoppedByExpert) return "stopped";
  return result.status === "failed" ? "failed" : "completed";
}

class ExecutionTimeoutError extends Error {}

/** Hard caps on one execution's event stream; the file is an operator convenience, not a log service. */
const OBSERVABILITY_MAX_EVENTS = 2_000;
const OBSERVABILITY_MAX_BYTES = 256 * 1024;
const OBSERVABILITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ObservabilityStreamState {
  file: string;
  events: number;
  bytes: number;
  truncated?: boolean;
  /** Per-file byte ceiling: raised from the historical default only when a content dial is on. */
  maxBytes: number;
  /** Recorder for the active content dial; absent at `none`. */
  content?: ContentRecorder;
  /** Serializes appends so events cannot interleave or be lost. */
  chain: Promise<void>;
  /** Attempt number carried onto every event, so a retry is visible in the window. */
  attempt?: number;
}

/** Collapse a value to one bounded line: no control characters, no multi-line sprawl on disk. */
function boundedText(value: string, max = 400): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}\u2026` : oneLine;
}

/** Execution ids are generated internally, but a path component is never trusted to stay sane. */
function streamFileName(executionId: string): string {
  return `${executionId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`;
}

export function inferPiProviderBilling(
  provider: string,
  runtimeSubscription = false,
  hasPublishedMeteredPrice = false,
): RuntimeBillingDiscovery {
  if (runtimeSubscription) {
    return {
      policy: { billingType: "subscription", costMultiplier: 0.1 },
      source: "pi-runtime",
      reason: "Pi reports that the authenticated provider uses subscription access.",
    };
  }
  if (/(?:^|-)token-plan(?:-|$)/i.test(provider)) {
    return {
      policy: { billingType: "subscription", costMultiplier: 0.1 },
      source: "pi-provider-catalog",
      reason: `Pi provider ${provider} is a named Token Plan access catalog.`,
    };
  }
  if (hasPublishedMeteredPrice) {
    return {
      policy: { billingType: "metered", costMultiplier: 1.0 },
      source: "pi-model-catalog",
      reason: `Pi exposes non-zero per-token catalog prices for provider ${provider} and does not report subscription access.`,
    };
  }
  return {
    policy: { billingType: "unknown" },
    source: "unverified",
    reason: "Pi confirms authentication but does not expose a reliable billing/access classification for this provider.",
  };
}

const FAILURE_TYPES = new Set<FailureType>([
  "tool_call_error",
  "reasoning_failure",
  "test_failure",
  "timeout",
  "provider_error",
  "missing_context",
  "permission_error",
  "unknown",
]);

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const part = item as Record<string, unknown>;
      return part.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

/**
 * Tool results arrive in several shapes (Pi's content blocks, a plain string, or a host
 * object). Only `text` parts are ever extracted, so a `thinking`/`reasoning` part cannot
 * reach the stream by riding in a tool payload; anything unrecognised is serialised rather
 * than dropped, because a missing record is a worse observer failure than an ugly one.
 */
function toolResultText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.content)) return textFromContent(record.content) || textFromContent(value);
  return textFromContent(value) || safeJson(value) || null;
}

/** JSON that never throws: a cyclic or exotic payload must not break an observer. */
function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function finalAssistantText(session: PiSessionLike): string {
  const messages = session.messages ?? session.state?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown>;
    if (message.role === "assistant") {
      const text = textFromContent(message.content);
      if (text) return text;
    }
  }
  return "";
}

/**
 * Pi sessions surface upstream provider failures as a final assistant message
 * with `stopReason: "error"` and the provider diagnostic in `errorMessage`.
 * Returning that diagnostic keeps model-access denials visible to routing
 * instead of degrading into a vague empty-response result.
 */
function finalSessionError(session: PiSessionLike): string | undefined {
  const messages = session.messages ?? session.state?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "error") return undefined;
    const error = message.errorMessage;
    if (typeof error === "string" && error.trim()) return error;
    return "The expert session ended with a provider error and no diagnostic message.";
  }
  return undefined;
}

function sessionUsage(session: PiSessionLike): Record<string, number> | undefined {
  const messages = session.messages ?? session.state?.messages ?? [];
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };
  let found = false;
  const add = (value: unknown, key: keyof typeof total) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      total[key] += Math.max(0, value);
      found = true;
    }
  };
  for (const value of messages) {
    const message = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (message.role !== "assistant" || !message.usage || typeof message.usage !== "object") continue;
    const usage = message.usage as Record<string, unknown>;
    add(usage.input, "inputTokens");
    add(usage.output, "outputTokens");
    add(usage.cacheRead, "cacheReadTokens");
    add(usage.cacheWrite, "cacheWriteTokens");
    const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
    add(cost.total, "estimatedCost");
  }
  return found ? total : undefined;
}

/**
 * Extract the first syntactically valid JSON object from prose, scanning
 * balanced braces instead of guessing boundaries from the first and last
 * curly brace. String literals and escapes are respected so a `}` inside a
 * string cannot terminate the scan early.
 */
function firstBalancedJsonObject(text: string): string | undefined {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break; // Not a valid JSON object; advance to the next opening brace.
          }
        }
      }
    }
  }
  return undefined;
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, firstBalancedJsonObject(text), text].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next safe extraction candidate.
    }
  }
  return undefined;
}

function safeText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();
  return sanitized ? sanitized.slice(0, maximum) : undefined;
}

function normalizeResult(
  parsed: Record<string, unknown> | undefined,
  request: ExpertExecutionRequest,
  rawText: string,
  changedFiles: string[],
  workspace: PreparedWorkspace,
  usage?: Record<string, number>,
  verification?: VerificationEntry[],
): ExpertResult {
  const status = parsed?.status === "success" || parsed?.status === "partial" || parsed?.status === "failed" ? parsed.status : "partial";
  const tests = Array.isArray(parsed?.tests)
    ? parsed.tests.slice(0, 20).flatMap((test) => {
        if (!test || typeof test !== "object") return [];
        const item = test as Record<string, unknown>;
        if (item.status !== "passed" && item.status !== "failed" && item.status !== "not-run") return [];
        const testStatus = item.status as "passed" | "failed" | "not-run";
        const boundedInt = (value: unknown, maximum: number): number | undefined =>
          typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum ? value : undefined;
        const exitCode = boundedInt(item.exitCode, 255);
        const testsRun = boundedInt(item.testsRun, 1_000_000);
        const failedCount = boundedInt(item.failedCount, 1_000_000);
        const errorCount = boundedInt(item.errorCount, 1_000_000);
        const skippedCount = boundedInt(item.skippedCount, 1_000_000);
        const durationMs = typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
          ? item.durationMs
          : undefined;
        return [{
          ...(safeText(item.command, 1_000) ? { command: safeText(item.command, 1_000) } : {}),
          status: testStatus,
          ...(safeText(item.summary, 2_000) ? { summary: safeText(item.summary, 2_000) } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(testsRun !== undefined ? { testsRun } : {}),
          ...(failedCount !== undefined ? { failedCount } : {}),
          ...(errorCount !== undefined ? { errorCount } : {}),
          ...(skippedCount !== undefined ? { skippedCount } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(safeText(item.outputTail, 2_000) ? { outputTail: safeText(item.outputTail, 2_000) } : {}),
        }];
      })
    : undefined;
  const stringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value.flatMap((item) => safeText(item, 2_000) ?? []).slice(0, 20)
      : undefined;
  const explicitFailureType = typeof parsed?.failureType === "string" && FAILURE_TYPES.has(parsed.failureType as FailureType)
    ? parsed.failureType as FailureType
    : undefined;
  // Report text is not an error message: an expert can quote transport vocabulary while
  // describing the bug it was asked to investigate, and classifying that as a supplier
  // outage would blame the model for prose. Only failure-shaped summaries are classified.
  const summaryFailureType = inferFailureTypeFromSummary(
    typeof parsed?.summary === "string" ? parsed.summary : rawText,
    "reasoning_failure",
  );
  const inferredFailureType = status !== "success"
    ? explicitFailureType
      ?? (tests?.some((test) => test.status === "failed") ? "test_failure" : undefined)
      ?? summaryFailureType
    : undefined;

  return {
    status,
    role: request.role,
    model: request.model,
    summary:
      safeText(parsed?.summary, 4_000)
        ?? safeText(rawText, 4_000)
        ?? "Expert completed without a textual summary.",
    ...(changedFiles.length ? { filesChanged: changedFiles.slice(0, 1_000) } : {}),
    ...(tests?.length ? { tests } : {}),
    ...(stringArray(parsed?.findings)?.length ? { findings: stringArray(parsed?.findings) } : {}),
    ...(stringArray(parsed?.risks)?.length ? { risks: stringArray(parsed?.risks) } : {}),
    ...(safeText(parsed?.recommendedNextAction, 1_000)
      ? { recommendedNextAction: safeText(parsed?.recommendedNextAction, 1_000) }
      : {}),
    executionMetadata: {
      attempts: request.attempt,
      workspace: workspace.root,
      isolated: workspace.isolated,
      provisioning: workspace.provisioning,
      ...(verification?.length ? { verification } : {}),
      ...(inferredFailureType ? { failureType: inferredFailureType } : {}),
      ...(usage ? { usage } : {}),
    },
  };
}

export interface VerificationEntry {
  command?: string;
  status: "passed" | "failed" | "not-run";
  summary?: string;
  exitCode?: number;
  outputTail?: string;
}

export interface VerificationStep {
  command: string[];
  label: string;
}

/** Verification argv: an explicit override, else repository typecheck then tests. */
export function planVerification(config: WorkspaceProvisioningConfig): VerificationStep[] {
  if (config.verifyCommand?.length) {
    return [{ command: [...config.verifyCommand], label: config.verifyCommand.join(" ") }];
  }
  return [
    { command: ["npm", "run", "typecheck"], label: "npm run typecheck" },
    { command: ["npm", "test"], label: "npm test" },
  ];
}

async function runVerification(
  workspace: PreparedWorkspace,
  config: WorkspaceProvisioningConfig,
  runner: BoundedCommandRunner = runBoundedCommand,
): Promise<VerificationEntry[]> {
  const entries: VerificationEntry[] = [];
  const env = config.scrubEnv ? scrubProvisioningEnv() : { ...process.env };
  for (const step of planVerification(config)) {
    const outcome = await runner(step.command, { cwd: workspace.root, timeoutMs: config.timeoutMs, env });
    const passed = outcome.exitCode === 0 && !outcome.timedOut;
    const tail = tailCommandOutput(outcome.stderr || outcome.stdout, 2_000);
    const summary = passed
      ? "exit code 0"
      : `exit code ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}${tail ? `: ${tail}` : ""}`;
    entries.push({
      command: step.label.slice(0, 1_000),
      status: passed ? "passed" : "failed",
      summary: summary.slice(0, 2_000),
      exitCode: outcome.exitCode,
      outputTail: tailCommandOutput(`${outcome.stdout}\n${outcome.stderr}`, 1_500),
    });
  }
  return entries;
}

/**
 * Apply the runtime verification gate: a failed verification downgrades an
 * otherwise successful expert result to `partial` with `test_failure`, which
 * engages the existing corrected-retry escalation path.
 */
export function applyVerificationGate(result: ExpertResult): ExpertResult {
  const verification = result.executionMetadata?.verification;
  if (!verification?.some((entry) => entry.status === "failed")) return result;
  if (result.status !== "success") return result;
  return {
    ...result,
    status: "partial",
    executionMetadata: { ...result.executionMetadata, failureType: "test_failure" },
  };
}

async function rolePrompt(role: string, roleDirectory?: string): Promise<string> {
  if (roleDirectory) return readFile(path.resolve(roleDirectory, `${role}.md`), "utf8");
  return readFile(new URL(`./roles/${role}.md`, import.meta.url), "utf8");
}

function dependencyGuidance(provisioning?: WorkspaceProvisioningStatus): string {
  if (provisioning?.status === "ready") {
    return `The runtime provisioned this worktree (${provisioning.packageManager ?? "package manager"}); dependencies are installed. Self-verify with the repository's typecheck command and then its test command, and report both in \`tests\`. Do NOT run a package-manager install, and do NOT run a build/release/pack script — in this repository a build regenerates Git-tracked artifacts and would pollute the diff you hand back.`;
  }
  if (provisioning?.detail) {
    return `Dependencies are NOT installed in this worktree. ${provisioning.detail} Report \`tests\` entries as not-run with the reason instead of attempting an install.`;
  }
  return "Isolated worktrees contain only Git-tracked files; untracked local artifacts (dependencies, environments, caches) are absent — account for this before planning commands. Dependencies are NOT installed; report `tests` entries as not-run with the reason instead of attempting an install.";
}

function executionPrompt(
  request: ExpertExecutionRequest,
  roleInstructions: string,
  provisioning?: WorkspaceProvisioningStatus,
): string {
  return `${roleInstructions}\n\n## Bounded assignment\n${request.task}\n\n## Execution constraints\n- Do not delegate to another agent.\n- Use only the provided tools and workspace.\n- Never modify an existing file before inspecting the relevant content.\n- Prefer targeted edits over rewriting whole files.\n- Verify paths rather than guessing.\n- ${dependencyGuidance(provisioning)}\n- If the task cannot be completed with the assigned tools and workspace (missing tool, absent environment, permission denied), or you determine continued work cannot reach the goal, call the report_and_stop tool immediately with the exact blocker, useful findings, risks, and a recommendedNextAction; then end your turn. Do not burn the budget on silent workarounds.\n- For a genuinely major, hard-to-reverse, or ambiguous direction the task did not settle, call request_decision with 2-4 recommended options (best first); the Main Agent will choose and you continue in this same session. Do NOT use it for routine choices you can decide yourself.\n- If your role is read-only, delivering the requested content, analysis, or replacement text inside your report IS completion: return status success and state that applying it needs a writer-capable pass. Reserve permission_error for when you could not produce the requested result at all, and never downgrade a finished read-only deliverable because you were not allowed to write files.\n- If you genuinely need a tool your role does not grant, call request_tool with the tool name and a concrete reason; the Main Agent may approve once or persistently. Do not request tools you do not need, and mutating/shell tools cannot be granted to read-only roles.\n- Diagnose a failed tool call before retrying with a changed approach.\n- Use finite, non-interactive test commands and set an explicit command timeout based on expected difficulty whenever the shell tool supports it.\n- Do not reveal or request chain-of-thought.\n${request.priorFailure ? `- Previous failure: ${request.priorFailure.type}: ${request.priorFailure.summary}\n` : ""}\nReturn only one compact JSON object with: status, summary, failureType, filesChanged, tests, findings, risks, recommendedNextAction. Omit failureType on success; otherwise use one of tool_call_error, reasoning_failure, test_failure, timeout, provider_error, missing_context, permission_error, or unknown. Test entries use status passed, failed, or not-run. Each \`tests\` entry must include \`command\` and \`exitCode\`, and when known \`testsRun\`, \`failedCount\`, \`errorCount\`, \`skippedCount\`, \`durationMs\`, plus \`outputTail\` (last lines of real output). Never claim a test ran without an exit code.`;
}

/** Structured stop report submitted by the expert through `report_and_stop`. */
export interface ExpertStopReport {
  reason: string;
  findings?: string[];
  risks?: string[];
  recommendedNextAction?: string;
}

interface ActiveExpertSession {
  session: PiSessionLike;
  startedAt: number;
  workspace: PreparedWorkspace;
  role: string;
  model: string;
  abortRequested: boolean;
  timedOut: boolean;
  /** Set when the expert itself reported the task impossible via report_and_stop. */
  stopRequested: boolean;
  /** Bounces already spent on a contentless stop report (at most one, never a loop). */
  stopRejections?: number;
  /** Tool calls and failures the runtime actually observed, not what the expert reported. */
  toolCalls: number;
  toolErrors: number;
  consecutiveToolErrors: number;
  /** Non-blocking struggle warnings raised so far, oldest first, capped. */
  attention: ExpertAttention[];
  /** Steers already injected into this session (hard cap 2). */
  nudgesSent: number;
  /** Budget-fraction timers; always cleared on teardown so nothing can outlive the run. */
  budgetTimers: NodeJS.Timeout[];
  timeoutMs?: number;
  reason?: string;
  /** Resolved by abortExecution to force the execution race to settle. */
  forceSettle?: () => void;
  /** Resolved by the report_and_stop tool with the expert's structured report. */
  forceStop?: (report: ExpertStopReport) => void;
  /** Live interaction the expert is blocked on, surfaced to the host through inspectEntry. */
  pendingInteraction?: PendingInteraction;
  /** Resolves the currently-awaited interaction with the host's answer. */
  resolveInteraction?: (response: InteractionResponse) => void;
  /** Interaction rounds consumed so far by this execution. */
  interactionRounds?: number;
  /** Tool names currently active for the session, tracked for dynamic grants. */
  activeToolNames?: string[];
  /** Tools granted "once" that must deactivate after their first use. */
  onceTools?: Set<string>;
  /** Unsubscribe for the progress/revoke event pump. */
  unsubscribe?: () => void;
}

const DIFF_UNREADABLE_NOTE = "The workspace diff could not be read, so filesChanged may be incomplete:";

/**
 * Merge the "diff unreadable" note into a result's risks, so an absent `filesChanged`
 * never silently reads as "the expert changed nothing" on any delivered path - including
 * the failure paths, which is precisely where the host most needs to salvage work
 * (defect #35, the incomplete half of defect #28).
 */
function risksWithDiffNote(
  diffError: string | undefined,
  ...groups: Array<string[] | undefined>
): { risks?: string[] } {
  const merged = [
    ...(diffError ? [`${DIFF_UNREADABLE_NOTE} ${diffError}`] : []),
    ...groups.filter((group): group is string[] => Array.isArray(group)).flat(),
  ].slice(0, 20);
  return merged.length ? { risks: merged } : {};
}

export class PiExpertRuntime implements ExpertRuntime {
  private readonly boundary: WorkspaceBoundary;
  private readonly activeSessions = new Map<string, ActiveExpertSession>();
  /** Cached capability probe for Pi's runtime tool-set narrowing API. */
  private canNarrowTools: boolean | undefined;
  /** Execution ids whose current interaction was answered by the host (vs. by the wait timeout). */
  private readonly lastHostResponded = new Map<string, boolean>();
  /** Per-execution state for the interactive observability event stream. */
  private readonly observabilityStreams = new Map<string, ObservabilityStreamState>();
  /** Guardrail observations kept past the entry's lifetime so the result can carry them. */
  private readonly lastGuardrails = new Map<string, { toolCalls: number; toolErrors: number; attention: ExpertAttention[] }>();
  private skillDiscoveryWarning?: string;

  /**
   * Set only when security.observability.autoOpenWindow is on. Windows are an operator
   * convenience: the launcher never throws, never blocks, and cannot change what an expert
   * does or sees - it only reads the same event stream another terminal could follow.
   */
  private readonly observerWindows: ObserverWindowLauncher | undefined;
  private readonly observerWindowWarnings: string[] = [];
  private readonly contentWarnings: string[] = [];
  /** The content dial in effect per delegation, so status can say what is on disk. */
  private readonly contentDials = new Map<string, string>();

  /** A content warning is operator-facing and fires once per distinct problem. */
  private noteContentWarning(message: string): void {
    const bounded = boundedText(message, 200);
    if (!this.contentWarnings.includes(bounded) && this.contentWarnings.length < 8) this.contentWarnings.push(bounded);
  }

  private constructor(
    private readonly sdk: PiSdkLike,
    private readonly models: PiModelRuntimeLike,
    private readonly options: PiExpertRuntimeOptions,
    private readonly packageName: string,
  ) {
    this.boundary = new WorkspaceBoundary(options.cwd, options.config.security);
    this.observerWindows = options.config.security.observability.autoOpenWindow
      ? new ObserverWindowLauncher({
          ...(options.observerWindow ?? {}),
          onWarning: (message) => {
            // Once per distinct message: a degraded convenience must not spam the host.
            const bounded = boundedText(message) ?? "Observer window warning unavailable.";
            if (!this.observerWindowWarnings.includes(bounded) && this.observerWindowWarnings.length < 5) {
              this.observerWindowWarnings.push(bounded);
            }
          },
        })
      : undefined;
  }

  static async create(options: PiExpertRuntimeOptions): Promise<PiExpertRuntime> {
    const loaded = options.sdk ? { sdk: options.sdk, packageName: options.packageName ?? "injected-pi-sdk" } : await loadPiSdk();
    const sdk = validatePiSdk(loaded.sdk, loaded.packageName);
    const modelRuntime = validatePiModelRuntime(
      options.modelRuntime ?? (await sdk.ModelRuntime.create({ allowModelNetwork: false })),
      `${loaded.packageName} ModelRuntime`,
    );
    const runtime = new PiExpertRuntime(sdk, modelRuntime, options, loaded.packageName);
    // Stream files are an operator convenience: sweep expired ones so the directory
    // cannot grow without bound across many runs.
    await runtime.pruneObservabilityStreams();
    return runtime;
  }

  /**
   * Public entry point. Wraps the execution so that however a run ends - success,
   * partial, failure, expert stop, or a thrown error - its observability stream is
   * closed with exactly one terminal event and flushed before returning.
   */
  async executeExpert(input: ExpertExecutionRequest): Promise<ExpertResult> {
    // The stream and the guardrail bookkeeping are both keyed by execution id, so a
    // delegation that arrives without one is given a stable id here, before any event
    // is written and before the inner execution reads it: both must agree.
    const executionId = input.executionId ?? `exec-${Date.now()}`;
    const request: ExpertExecutionRequest = { ...input, executionId };
    this.openObservabilityStream(request);
    let result: ExpertResult;
    try {
      result = await this.executeExpertInner(request);
    } catch (error) {
      this.lastGuardrails.delete(executionId);
      this.emitObservability(executionId, request.role, request.model, "failed", {
        status: "failed",
        text: boundedText(error instanceof Error ? error.message : String(error)),
      });
      await this.closeObservabilityStream(executionId);
      throw error;
    }
    result = this.withGuardrailEvidence(executionId, result);
    this.emitObservability(executionId, request.role, request.model ?? result.model, terminalKindFor(result), {
      status: result.status,
      ...(result.executionMetadata?.failureType ? { failureType: String(result.executionMetadata.failureType) } : {}),
      ...(typeof result.executionMetadata?.durationMs === "number" ? { durationMs: result.executionMetadata.durationMs } : {}),
    });
    await this.closeObservabilityStream(executionId);
    return result;
  }

  /** Whether an interactive stream is open for this execution (cheap check, never creates one). */
  private observabilityActive(executionId: string | undefined): boolean {
    return executionId !== undefined && this.observabilityStreams.has(executionId);
  }

  private observabilityState(executionId: string | undefined): ObservabilityStreamState | undefined {
    // An execution without an id cannot be correlated to a file, so it gets no stream.
    if (executionId === undefined) return undefined;
    if (this.options.config.security.observability.expertWindow !== "interactive" || !this.options.observabilityDir) return undefined;
    const existing = this.observabilityStreams.get(executionId);
    if (existing) return existing;
    const created: ObservabilityStreamState = {
      file: path.join(this.options.observabilityDir, streamFileName(executionId)),
      events: 0,
      bytes: 0,
      maxBytes: OBSERVABILITY_MAX_BYTES,
      chain: Promise.resolve(),
    };
    this.observabilityStreams.set(executionId, created);
    return created;
  }

  private openObservabilityStream(request: ExpertExecutionRequest): void {
    const state = this.observabilityState(request.executionId);
    if (!state || request.executionId === undefined) return;
    // Each attempt re-opens the same file, so the counter travels with the events it writes.
    state.attempt = request.attempt;
    if (!state.content) {
      const observability = this.options.config.security.observability;
      const resolved = resolveContentLevel({
        levels: CONTENT_LEVELS,
        global: observability.contentStream,
        byRole: observability.contentByRole,
        role: String(request.role),
        ...(process.env.EXPERT_COUNCIL_CONTENT === undefined ? {} : { envValue: process.env.EXPERT_COUNCIL_CONTENT }),
      });
      if (resolved.warning) this.noteContentWarning(resolved.warning);
      if (resolved.level !== "none") {
        // The historical 256 KB ceiling exists to bound names-and-counters noise; content mode
        // is bounded by the operator's own dial, and a stream that stopped after two `read`
        // results would be the more surprising failure.
        // Whatever the operator set, exactly: a smaller number is a deliberate limit on
        // exposure, and quietly widening it would make the dial a suggestion.
        state.maxBytes = observability.contentFileBytes;
        state.content = new ContentRecorder({
          level: resolved.level,
          eventBytes: observability.contentEventBytes,
          emit: (kind, fields) => this.emitObservability(request.executionId, request.role, request.model, kind, fields),
        });
        this.contentDials.set(request.executionId, resolved.level);
      }
    }
    this.appendObservability(state, {
      t: new Date().toISOString(),
      executionId: request.executionId,
      role: request.role,
      ...(request.model ? { model: request.model } : {}),
      ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
      kind: "started",
    });
    // The delegation-level identity is what matters here: retries and escalations reuse this
    // execution id and this same stream file, so the launcher keeps one window per
    // delegation instead of flashing a fresh one for every attempt.
    this.observerWindows?.ensureOpen({
      executionId: request.executionId,
      role: String(request.role),
      ...(typeof request.timeoutMs === "number" ? { timeoutMs: request.timeoutMs } : {}),
      // The window shows what the operator configured, not the follower's own defaults.
      windowLines: this.options.config.security.observability.contentWindowLines,
      windowChars: this.options.config.security.observability.contentWindowChars,
    });
  }

  private emitObservability(
    executionId: string | undefined,
    role: string,
    model: string | undefined,
    kind: ExpertEventKind,
    fields: Partial<ExpertObservabilityEvent> = {},
  ): void {
    const state = this.observabilityState(executionId);
    if (!state || executionId === undefined) return;
    // A ceiling may drop observation, never how the work ended: swallowing the terminator
    // would leave a follower open until its own timeout and contradict the guarantee that the
    // stream always says how a delegation finished (#17). Terminals are four tiny records, so
    // exempting them cannot meaningfully widen a file an operator capped.
    if (
      !(TERMINAL_EVENT_KINDS as readonly string[]).includes(kind) &&
      (state.events >= OBSERVABILITY_MAX_EVENTS || state.bytes >= state.maxBytes)
    ) {
      if (!state.truncated) {
        state.truncated = true;
        this.appendObservability(state, {
          t: new Date().toISOString(),
          executionId,
          role,
          ...(state.attempt === undefined ? {} : { attempt: state.attempt }),
          kind: "stream_truncated",
          text: `${OBSERVABILITY_MAX_EVENTS} events / ${state.maxBytes} bytes reached; further events dropped except the outcome markers.`,
        });
      }
      return;
    }
    this.appendObservability(state, {
      t: new Date().toISOString(),
      executionId,
      role,
      ...(model ? { model } : {}),
      ...(state.attempt === undefined ? {} : { attempt: state.attempt }),
      kind,
      // A content record points back at itself: an operator told a block was shortened
      // needs the line to read the rest, not an apology.
      ...(state.content && (kind === "assistant_text" || kind === "tool_output")
        ? { line: state.events + 1 }
        : {}),
      ...fields,
    });
  }

  /** Best-effort by design: an observability write must never break an expert run. */
  private appendObservability(state: ObservabilityStreamState, event: ExpertObservabilityEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    state.events += 1;
    state.bytes += Buffer.byteLength(line);
    state.chain = state.chain
      .then(async () => {
        await mkdir(path.dirname(state.file), { recursive: true });
        await appendFile(state.file, line, { encoding: "utf8" });
      })
      .catch(() => undefined);
  }

  private async closeObservabilityStream(executionId: string | undefined): Promise<void> {
    if (executionId === undefined) return;
    const state = this.observabilityStreams.get(executionId);
    if (!state) return;
    await state.chain;
    this.observabilityStreams.delete(executionId);
  }

  /**
   * Tell observers that the delegation has ended, so a window can close on a fact rather
   * than on a guess. Writes only when this process actually streamed the execution: a
   * delegation that failed before any attempt ran has nothing for an observer to conclude,
   * and it must not gain a stray one-line file.
   */
  async finalizeDelegation(executionId: string, role: ExpertRole): Promise<void> {
    const state = this.observabilityState(executionId);
    if (!state) return;
    try {
      await stat(state.file);
    } catch {
      return;
    }
    this.appendObservability(state, {
      t: new Date().toISOString(),
      executionId,
      role,
      kind: "delegation_final",
    });
    await this.closeObservabilityStream(executionId);
    // The window that was opened for this delegation may now be released: the follower sees
    // the marker, stops tailing, and waits for a keypress on its own.
    this.observerWindows?.release(executionId);
  }

  /**
   * Fold the runtime's own guardrail observations into a finished result. The attempt
   * summary is the expert's word; these numbers are what was actually seen, and the
   * escalation and learning paths must not have to trust the former for the latter.
   */
  private withGuardrailEvidence(executionId: string | undefined, result: ExpertResult): ExpertResult {
    if (executionId === undefined) return result;
    const guardrails = this.lastGuardrails.get(executionId);
    this.lastGuardrails.delete(executionId);
    if (!guardrails) return result;
    return {
      ...result,
      executionMetadata: {
        ...result.executionMetadata,
        toolCalls: guardrails.toolCalls,
        toolErrors: guardrails.toolErrors,
        ...(guardrails.attention.length ? { attention: guardrails.attention } : {}),
      },
    };
  }

  /**
   * Record one non-blocking struggle warning. Each code fires at most once per execution
   * (budget fractions are keyed by their own threshold) and the list is capped. Nothing
   * here stops the expert: a false positive costs one wasted look, while an auto-abort
   * would destroy good work, so the mechanism deliberately stops short of it.
   */
  private raiseAttention(
    entry: ActiveExpertSession,
    request: ExpertExecutionRequest,
    code: ExpertAttention["code"],
    detail: string,
    extra: Partial<ExpertAttention> = {},
    options: { nudge?: boolean } = {},
  ): ExpertAttention | undefined {
    const keyOf = (item: ExpertAttention) =>
      item.code === "budget_fraction" ? `budget_fraction:${item.budgetFractionUsed ?? 0}` : item.code;
    const key = code === "budget_fraction" ? `budget_fraction:${extra.budgetFractionUsed ?? 0}` : code;
    if (entry.attention.some((item) => keyOf(item) === key)) return undefined;
    const attention: ExpertAttention = {
      code,
      at: new Date().toISOString(),
      detail: detail.slice(0, 500),
      toolCalls: entry.toolCalls,
      toolErrors: entry.toolErrors,
      ...extra,
    };
    entry.attention = [...entry.attention.slice(-7), attention];
    this.emitObservability(request.executionId, request.role, request.model, "attention", {
      text: attention.detail,
      ...(attention.toolCalls === undefined ? {} : { toolCalls: attention.toolCalls }),
      ...(attention.toolErrors === undefined ? {} : { toolErrors: attention.toolErrors }),
      ...(attention.budgetFractionUsed === undefined ? {} : { budgetFractionUsed: attention.budgetFractionUsed }),
      ...(attention.nudgedExpert ? { nudgedExpert: true } : {}),
    });
    if (options.nudge) this.nudgeExpert(entry, request, attention);
    return attention;
  }

  /** A bounded steer, at most twice per execution, and only if the session can take one. */
  private nudgeExpert(entry: ActiveExpertSession, request: ExpertExecutionRequest, attention: ExpertAttention): void {
    if (!this.options.config.security.guardrails.nudgeExpert) return;
    if (entry.nudgesSent >= 2 || typeof entry.session?.steer !== "function") return;
    entry.nudgesSent += 1;
    attention.nudgedExpert = true;
    const minutes = typeof request.timeoutMs === "number" ? Math.round(request.timeoutMs / 60_000) : undefined;
    const budget = attention.budgetFractionUsed
      ? ` You have used about ${Math.round(attention.budgetFractionUsed * 100)}%${minutes ? ` of a ${minutes}-minute` : ""} budget.`
      : "";
    void entry.session
      .steer(
        `Council guardrail: ${attention.detail}.${budget} Do not repeat an identical failing call. If the goal is still reachable with your assigned tools, say in one sentence what you will do differently and continue. If it is not reachable, call report_and_stop now with the exact blocker and at least one concrete finding. If the direction itself is ambiguous, call request_decision.`,
      )
      ?.catch(() => undefined);
  }

  private evaluateToolGuardrails(entry: ActiveExpertSession, request: ExpertExecutionRequest): void {
    const guardrails = this.options.config.security.guardrails;
    if (!guardrails.warnHost) return;
    if (entry.consecutiveToolErrors >= guardrails.consecutiveToolFailures) {
      this.raiseAttention(
        entry,
        request,
        "consecutive_tool_failures",
        `${entry.consecutiveToolErrors} consecutive tool calls failed (${entry.toolErrors} of ${entry.toolCalls} observed).`,
        { consecutiveToolErrors: entry.consecutiveToolErrors },
        { nudge: true },
      );
    }
    if (entry.toolCalls >= guardrails.minCallsForRatio && entry.toolErrors / entry.toolCalls >= guardrails.failureRatio) {
      const ratio = Math.round((entry.toolErrors / entry.toolCalls) * 100);
      this.raiseAttention(
        entry,
        request,
        "failure_ratio_high",
        `${entry.toolErrors} of ${entry.toolCalls} observed tool calls failed (${ratio}%).`,
        {},
        { nudge: true },
      );
    }
  }

  /** Arm one timer per configured budget fraction; every timer is cleared on teardown. */
  private armBudgetWarnings(entry: ActiveExpertSession, request: ExpertExecutionRequest): void {
    const guardrails = this.options.config.security.guardrails;
    const budget = request.timeoutMs;
    if (!guardrails.warnHost || typeof budget !== "number" || budget <= 0) return;
    const fractions = [...new Set(guardrails.budgetFractions)].sort((a, b) => a - b);
    const highest = fractions[fractions.length - 1];
    for (const fraction of fractions) {
      const delay = Math.max(0, Math.round(budget * fraction) - (Date.now() - entry.startedAt));
      entry.budgetTimers.push(
        setTimeout(() => {
          this.raiseAttention(
            entry,
            request,
            "budget_fraction",
            `${Math.round(fraction * 100)}% of the execution budget used with no result yet.`,
            { budgetFractionUsed: fraction, toolCalls: entry.toolCalls, toolErrors: entry.toolErrors },
            { nudge: fraction === highest },
          );
        }, delay),
      );
    }
  }

  private clearBudgetWarnings(entry: ActiveExpertSession | undefined): void {
    for (const timer of entry?.budgetTimers ?? []) clearTimeout(timer);
  }

  /** Tool arguments reach the stream only when the operator turned redaction off. */
  private toolArgumentSummary(args: unknown): string | undefined {
    if (this.options.config.security.observability.redactToolArgs) return undefined;
    if (!args || typeof args !== "object") return undefined;
    const record = args as Record<string, unknown>;
    for (const key of ["command", "script", "path", "file", "filePath", "dir", "pattern", "query", "url"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return boundedText(value, 160);
    }
    return undefined;
  }

  /** Remove event streams left behind by earlier sessions; never fatal. */
  private async pruneObservabilityStreams(): Promise<void> {
    const dir = this.options.observabilityDir;
    if (!dir) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // no stream directory has been created yet
    }
    const cutoff = Date.now() - OBSERVABILITY_RETENTION_MS;
    for (const name of names.filter((item) => item.endsWith(".jsonl"))) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) await unlink(file);
      } catch {
        // A raced deletion or an unreadable entry is not worth failing startup over.
      }
    }
    // A content dial can write megabytes per delegation, so TTL alone is not a bound. Oldest
    // first is also safe by construction: a live stream has the newest modification time, so
    // eviction cannot pull the file an operator's window is currently following.
    const budget = this.options.config.security.observability.contentTotalBytes;
    const listed: Array<{ file: string; size: number; at: number }> = [];
    for (const name of names.filter((item) => item.endsWith(".jsonl"))) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        listed.push({ file, size: info.size, at: info.mtimeMs });
      } catch {
        // Gone already; nothing to do.
      }
    }
    let total = listed.reduce((sum, item) => sum + item.size, 0);
    for (const item of listed.sort((left, right) => left.at - right.at)) {
      if (total <= budget) break;
      try {
        await unlink(item.file);
        total -= item.size;
      } catch {
        // Same as above: a raced deletion is not a startup failure.
      }
    }
  }

  async listAvailableModels(): Promise<AvailableModel[]> {
    const raw = await this.models.getAvailable();
    return normalizePiModels(raw, true).map((model) => ({ ...model }));
  }

  async listProviderBilling(): Promise<Record<string, RuntimeBillingDiscovery>> {
    const models = await this.listAvailableModels();
    const providers = [...new Set(models.map((model) => model.provider))];
    return Object.fromEntries(providers.map((provider) => {
      let runtimeSubscription = false;
      try {
        runtimeSubscription = this.models.isUsingSubscription?.(provider) === true;
      } catch {
        // Optional Pi compatibility signal; provider-catalog evidence may still be available.
      }
      const hasPublishedMeteredPrice = models
        .filter((model) => model.provider === provider)
        .some((model) => Object.values(model.apiCost ?? {}).some((price) => typeof price === "number" && price > 0));
      return [provider, inferPiProviderBilling(provider, runtimeSubscription, hasPublishedMeteredPrice)];
    }));
  }

  private skillIsTrusted(skill: Record<string, unknown>): boolean {
    const sourceInfo = skill.sourceInfo && typeof skill.sourceInfo === "object"
      ? skill.sourceInfo as Record<string, unknown>
      : undefined;
    return sourceInfo?.scope === "user" ||
      (typeof skill.name === "string" && this.options.config.security.trustedSkills.includes(skill.name));
  }

  private async createSafeResourceLoader(cwd: string, requestedSkills?: string[]) {
    if (!this.sdk.DefaultResourceLoader || !this.sdk.SettingsManager) return undefined;
    const agentDir = this.sdk.getAgentDir?.();
    const permitAllowlistedProjectSkills = this.options.config.security.trustedSkills.length > 0;
    const settingsManager = this.sdk.SettingsManager.create(cwd, agentDir, {
      projectTrusted: permitAllowlistedProjectSkills,
    });
    const loader = new this.sdk.DefaultResourceLoader({
      cwd,
      ...(agentDir ? { agentDir } : {}),
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (current: { skills: Array<Record<string, unknown>>; diagnostics: unknown[] }) => ({
        skills: current.skills.filter((skill) =>
          typeof skill.name === "string" &&
          this.skillIsTrusted(skill) &&
          (!requestedSkills || requestedSkills.includes(skill.name))),
        diagnostics: current.diagnostics,
      }),
    });
    await loader.reload({
      resolveProjectTrust: async () => permitAllowlistedProjectSkills,
    });
    if (loader.getExtensions().extensions.length > 0) {
      throw new Error("Pi resource isolation failed: expert sessions must not load extensions.");
    }
    return loader;
  }

  async listSkills(): Promise<SkillInfo[]> {
    if (!this.sdk.DefaultResourceLoader) return [];
    try {
      const loader = await this.createSafeResourceLoader(this.options.cwd);
      if (!loader) return [];
      const discovered = loader.getSkills();
      this.skillDiscoveryWarning = discovered.diagnostics?.length
        ? `Pi Skill discovery reported ${discovered.diagnostics.length} diagnostic(s).`
        : undefined;
      return discovered.skills.flatMap((skill) =>
        typeof skill.name === "string"
          ? [{
              name: skill.name,
              ...(typeof skill.description === "string" ? { description: skill.description } : {}),
              installed: true,
              enabled: skill.disableModelInvocation !== true,
              trusted: this.skillIsTrusted(skill),
              source: typeof skill.filePath === "string" ? skill.filePath : "pi",
            }]
          : [],
      );
    } catch (error) {
      this.skillDiscoveryWarning = `Pi Skill discovery failed: ${error instanceof Error ? error.message : String(error)}`;
      return [];
    }
  }

  async getCapabilities(cwd: string = this.options.cwd): Promise<RuntimeCapabilities> {
    const workspace = await this.boundary.mutationCapability(cwd);
    const provisioningMode = this.options.config.security.workspaceProvisioning.mode;
    return {
      hostType: `pi:${this.packageName}`,
      modelDiscovery: true,
      hardToolRestriction: true,
      skillOverride: Boolean(this.sdk.DefaultResourceLoader),
      subagentBackend: true,
      mutation: workspace.mutation,
      workspaceIsolation: workspace.workspaceIsolation,
      ...(workspace.sourceWorkspaceDirty !== undefined ? { sourceWorkspaceDirty: workspace.sourceWorkspaceDirty } : {}),
      workspaceProvisioning: { mode: provisioningMode },
      supportedTools: process.platform === "win32"
        ? ["read", "grep", "find", "ls", "edit", "write", "powershell"]
        : ["read", "grep", "find", "ls", "edit", "write", "bash"],
      realtimeInteraction: true,
      dynamicToolPermissions: true,
      eventStream: {
        enabled: this.options.config.security.observability.expertWindow === "interactive" && !!this.options.observabilityDir,
        ...(this.options.observabilityDir ? { dir: this.options.observabilityDir } : {}),
        redactToolArgs: this.options.config.security.observability.redactToolArgs,
      },
      limitations: [
        "Reasoning levels are clamped to values exposed by the selected Pi session.",
        ...(this.skillDiscoveryWarning ? [this.skillDiscoveryWarning] : []),
        ...this.observerWindowWarnings,
        ...this.contentWarnings,
        ...[...new Set(this.contentDials.values())].map(
          (level) => `observability content dial "${level}" is recording: project content reaches disk as plaintext until pruned`,
        ),
        ...workspace.limitations,
        provisioningMode === "none"
          ? "Mutation worktrees are not provisioned (security.workspaceProvisioning.mode=none); experts must not install dependencies."
          : `Mutation worktrees are provisioned from the repository lockfile (security.workspaceProvisioning.mode=${provisioningMode}); read-only workspaces are never provisioned.`,
        ...(workspace.workspaceIsolation === "git-worktree"
          ? [`Mutation worktrees are retained for review until expert_cleanup is called or the ${this.options.config.security.worktreeRetentionMs}ms retention window expires.`]
          : []),
      ],
    };
  }

  async executeExpertInner(request: ExpertExecutionRequest): Promise<ExpertResult> {
    const started = Date.now();
    const executionKey = request.executionId ?? `exec-${Date.now()}`;
    let workspace: PreparedWorkspace | undefined;
    let session: PiSessionLike | undefined;
    let entry: ActiveExpertSession | undefined;
    try {
      // Pre-register the entry so a Main-Agent abort during workspace
      // preparation or provisioning (which can take minutes) is observed
      // instead of answered "not-found".
      entry = {
        session: undefined as unknown as PiSessionLike,
        startedAt: started,
        workspace: undefined as unknown as PreparedWorkspace,
        role: request.role,
        model: request.model,
        abortRequested: false,
        stopRequested: false,
        timedOut: false,
        toolCalls: 0,
        toolErrors: 0,
        consecutiveToolErrors: 0,
        attention: [],
        nudgesSent: 0,
        budgetTimers: [],
        timeoutMs: request.timeoutMs,
      };
      this.activeSessions.set(executionKey, entry);
      const available = await this.listAvailableModels();
      const [provider, ...idParts] = request.model.split("/");
      const id = idParts.join("/");
      if (!available.some((model) => model.provider === provider && model.id === id)) {
        throw new Error(`Selected model ${request.model} is not currently available.`);
      }
      const nativeModel = this.models.getModel(provider!, id);
      if (!nativeModel) throw new Error(`Pi model registry no longer contains ${request.model}.`);

      const effectiveReadOnly = request.readOnly || getRole(request.role).readOnly;
      workspace = await this.boundary.prepare(request.workspace, effectiveReadOnly, executionKey);
      const capabilities = await this.getCapabilities();
      const mutationTools = new Set(["edit", "write", "bash", "powershell"]);
      const seedTools = request.tools.filter(
        (tool) => capabilities.supportedTools.includes(tool) && (!effectiveReadOnly || !mutationTools.has(tool)),
      );
      // Apply persistent per-role grants from config as an additional seed. The
      // read-only boundary still forbids mutating/shell tools for a read-only role.
      for (const granted of this.options.config.security.toolGrants[request.role] ?? []) {
        if (
          capabilities.supportedTools.includes(granted) &&
          (!effectiveReadOnly || !mutationTools.has(granted)) &&
          !seedTools.includes(granted)
        ) seedTools.push(granted);
      }
      const interactionToolNames = ["report_and_stop", "request_decision", "request_tool"];
      // Pi's createAgentSession `tools` option is a registration allowlist: a tool
      // that is not registered can never be activated later, so dynamic grants
      // require registering the superset up front and narrowing the ACTIVE set with
      // setActiveToolsByName (verified to restrict the model's visible tools).
      // A read-only execution registers only read tools, so mutating/shell tools
      // stay unreachable at the registration layer too. If the installed Pi lacks
      // the narrowing API, later executions fall back to seed-only registration
      // (no dynamic grants) instead of silently over-privileging experts.
      const canRegisterSuperset = !effectiveReadOnly && this.canNarrowTools !== false;
      const registeredNames = effectiveReadOnly
        ? capabilities.supportedTools.filter((tool) => !mutationTools.has(tool))
        : canRegisterSuperset
          ? capabilities.supportedTools
          : seedTools;
      const tools = [...new Set([...registeredNames, ...interactionToolNames])];
      const initialActive = [...new Set([...seedTools, ...interactionToolNames])];
      const resourceLoader = await this.createSafeResourceLoader(workspace.cwd, request.skills);
      if (!resourceLoader) {
        throw new Error("Pi resource isolation is unavailable; refusing to create an expert session.");
      }

      // report_and_stop gives the expert a deterministic way to end a task it
      // cannot complete, with a structured report, instead of burning the
      // budget on silent exploration.
      let settleStop: ((report: ExpertStopReport) => void) | undefined;
      const stopReported = new Promise<ExpertStopReport>((resolve) => {
        settleStop = resolve;
      });
      entry.forceStop = (report: ExpertStopReport) => settleStop?.(report);
      const stopTool = {
        name: "report_and_stop",
        description:
          "Report that the assigned task cannot be completed with the assigned tools and workspace, and stop immediately. " +
          "Use it when a required tool is missing, the environment lacks a dependency (no installed dependencies, absent files, no network path), " +
          "permissions are denied, or you determine that continued work cannot reach the goal. " +
          "Do NOT use it for mere difficulty: try a reasonable alternative approach first. " +
          "After the tool confirms, end your turn with a one-paragraph summary; do not continue the task.",
        parameters: Type.Object({
          reason: Type.String({
            description: "The exact blocker and why it is not resolvable with the assigned tools and workspace.",
          }),
          findings: Type.Optional(Type.Array(Type.String(), {
            description: "Useful discoveries made so far (paths, symbols, root causes).",
          })),
          risks: Type.Optional(Type.Array(Type.String(), {
            description: "Risks the Main Agent should know before re-dispatching.",
          })),
          recommendedNextAction: Type.String({
            description: "The single most useful next step for the Main Agent (e.g. provide X, run Y, or dispatch Z instead).",
          }),
        }),
        execute: async (_toolCallId: string, params: { reason?: unknown; findings?: unknown; risks?: unknown; recommendedNextAction?: unknown }) => {
          const text = (value: unknown, limit: number): string => String(value ?? "").slice(0, limit);
          const lines = (value: unknown): string[] | undefined =>
            Array.isArray(value)
              ? value.map((item) => String(item).slice(0, 500)).filter((item) => item.length > 0).slice(0, 20)
              : undefined;
          const realLines = (value: unknown): string[] | undefined => {
            const kept = (lines(value) ?? []).filter((item) => !isPlaceholderText(item));
            return kept.length ? kept : undefined;
          };
          const reason = text(params.reason, 4_000);
          const findings = realLines(params.findings);
          const risks = realLines(params.risks);
          // A stop report is terminal evidence, and it is the only case where an expert
          // is believed without running anything. An expert that stops while claiming
          // "no blocker" and submits filler instead of findings must be bounced once and
          // made to produce the real content, never quietly credited with a delivery.
          if (!isPlaceholderText(reason) && !findings && !risks && !entry!.stopRejections) {
            entry!.stopRejections = 1;
            return {
              content: [{
                type: "text",
                text: "Stop report rejected: it carries no actual findings or risks. If you really are blocked, submit report_and_stop again with the exact blocker in reason and at least one concrete finding (paths, symbols, commands, or the missing capability). If the work is in fact done, do not stop - return your normal JSON result with status success and the content inside it.",
              }],
              details: {},
            };
          }
          entry!.stopRequested = true;
          settleStop?.({
            reason: reason || "Expert reported the task cannot be completed.",
            ...(findings ? { findings } : {}),
            ...(risks ? { risks } : {}),
            ...(realLines([text(params.recommendedNextAction, 1_000)])?.[0]
              ? { recommendedNextAction: realLines([text(params.recommendedNextAction, 1_000)])![0] }
              : {}),
          });
          return {
            content: [{
              type: "text",
              text: "Stop report recorded. End your turn now with a one-paragraph summary of what you did and learned. Do not continue the task.",
            }],
            details: {},
          };
        },
      };
      // request_decision lets the expert pause on a major direction choice or a
      // hard problem, present recommended options (+ optional free-text) to the
      // Main Agent, and continue in the SAME session after an answer. It reuses
      // the report_and_stop resolve template but is non-terminal.
      const decisionTool = {
        name: "request_decision",
        description:
          "Ask the Main Agent to decide between approaches before you continue. Use it only for a major, hard-to-reverse, or genuinely ambiguous direction " +
          "that the task did not resolve, or a hard blocker you cannot sensibly pick through. Do NOT use it for routine choices. " +
          "Provide up to four recommended options; the Main Agent may also give free-text guidance. After the tool returns, continue the task with the decision applied.",
        parameters: Type.Object({
          question: Type.String({ description: "The decision you need, in one or two sentences." }),
          options: Type.Array(Type.Object({
            label: Type.String({ description: "Short option name (1-5 words)." }),
            description: Type.Optional(Type.String({ description: "Impact/tradeoff of choosing this option." })),
          }), { minItems: 2, maxItems: 4, description: "Recommended options, best first." }),
          allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-text 'Others' answer. Defaults to true." })),
          context: Type.Optional(Type.String({ description: "Concise context that makes the tradeoff legible to the Main Agent." })),
        }),
        execute: async (_toolCallId: string, params: { question?: unknown; options?: unknown; allowOther?: unknown; context?: unknown }) => {
          const options = Array.isArray(params.options)
            ? params.options.slice(0, 4).map((item) => {
              const o = (item ?? {}) as Record<string, unknown>;
              const label = String(o.label ?? "").slice(0, 120).trim();
              const description = typeof o.description === "string" ? o.description.slice(0, 500) : undefined;
              return { label, ...(description ? { description } : {}) };
            }).filter((o) => o.label.length > 0)
            : [];
          const req: InteractionRequest = {
            kind: "decision",
            question: String(params.question ?? "").slice(0, 2_000),
            options,
            allowOther: params.allowOther !== false,
            ...(typeof params.context === "string" ? { context: params.context.slice(0, 4_000) } : {}),
          };
          const { response, hostAbsent } = await this.beginInteraction(executionKey, req);
          const answer = response.otherText ?? response.choice ?? "Proceed with the most conservative reasonable option.";
          const header = hostAbsent
            ? "No Main-Agent answer arrived (budget or wait limit reached)."
            : "Main Agent decision:";
          return {
            content: [{ type: "text", text: `${header} ${answer}\n\nApply this decision and continue the assigned task now. If the decision changed scope, adjust your plan and note any new risks.` }],
            details: {},
          };
        },
      };
      // request_tool lets the expert ask for a tool its role does not grant by
      // default. Preset role tools are a starting seed, not a ceiling; the Main
      // Agent may grant more (once or persistent). A read-only execution can
      // never be escalated to a mutating/shell tool — that would break the
      // isolation guarantee, since read-only experts run in the MAIN workspace.
      const mutationToolSet = new Set(["edit", "write", "bash", "powershell"]);
      const grantable = new Set<string>([...capabilities.supportedTools]);
      const requestTool = {
        name: "request_tool",
        description:
          "Ask the Main Agent to grant you a tool your role does not currently have, then continue if approved. " +
          "Use it when a genuinely needed capability is missing (for example a read-only scout needing to run a build or a shell command). " +
          "You may only request tools the runtime supports; mutating/shell tools cannot be granted to a read-only execution.",
        parameters: Type.Object({
          tool: Type.String({ description: "The tool name you need, e.g. bash, powershell, edit, write, read, grep, find, or ls." }),
          reason: Type.String({ description: "Why this specific tool is required to complete the bounded task." }),
        }),
        execute: async (_toolCallId: string, params: { tool?: unknown; reason?: unknown }) => {
          const tool = String(params.tool ?? "").trim().slice(0, 60);
          const reason = String(params.reason ?? "").slice(0, 2_000);
          if (!tool || !grantable.has(tool)) {
            return { content: [{ type: "text", text: `"${tool}" is not a grantable tool on this runtime. Available: ${[...grantable].join(", ")}. Continue without it or call report_and_stop.` }], details: {} };
          }
          if (effectiveReadOnly && mutationToolSet.has(tool)) {
            return { content: [{ type: "text", text: `Cannot grant the mutating/shell tool "${tool}" to a read-only execution (isolation boundary). Re-dispatch as an implementation-worker if mutation is truly required, or call report_and_stop.` }], details: {} };
          }
          if (entry!.activeToolNames?.includes(tool)) {
            return { content: [{ type: "text", text: `You already have "${tool}" available. Use it.` }], details: {} };
          }
          const { response, hostAbsent } = await this.beginInteraction(executionKey, { kind: "tool_approval", tool, reason });
          if (response.scope === "reject") {
            const note = hostAbsent ? " (no answer from the Main Agent)" : "";
            return { content: [{ type: "text", text: `The Main Agent rejected granting "${tool}"${note}. Continue without it, or call report_and_stop with the blocker.` }], details: {} };
          }
          const granted = this.activateTool(entry!, tool);
          if (!granted) {
            return { content: [{ type: "text", text: `Approval granted but the runtime could not activate "${tool}" (dynamic tools unsupported). Call report_and_stop.` }], details: {} };
          }
          if (response.scope === "once") entry!.onceTools?.add(tool);
          return { content: [{ type: "text", text: `The Main Agent granted "${tool}" (${response.scope}). Use it now to continue the task.` }], details: {} };
        },
      };
      const created = await this.sdk.createAgentSession({
        cwd: workspace.cwd,
        model: nativeModel,
        modelRuntime: this.models,
        tools,
        customTools: [stopTool, decisionTool, requestTool],
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(this.sdk.SessionManager ? { sessionManager: this.sdk.SessionManager.inMemory(workspace.cwd) } : {}),
      });
      session = validatePiSession(created.session, `${this.packageName} createAgentSession result`);
      // Fill the pre-registered entry in place: abortExecution may hold this
      // exact object reference and setting a fresh one could drop its flag.
      Object.assign(entry, { session, workspace });
      // Dynamic tool permissions: register the seed as the active set so a granted
      // tool can be added at runtime, and observe tool completions to auto-revoke
      // "once" grants after a single use. Best-effort: a session without these
      // hooks degrades to session-scoped grants (never a crash).
      const canNarrow = typeof session.setActiveToolsByName === "function";
      if (this.canNarrowTools === undefined) this.canNarrowTools = canNarrow;
      entry.activeToolNames = canNarrow ? initialActive : tools;
      if (canNarrow) session.setActiveToolsByName!(entry.activeToolNames);
      entry.onceTools = new Set<string>();
      entry.unsubscribe = session.subscribe?.((event) => {
        const e = event as {
          type?: string;
          toolName?: string;
          args?: unknown;
          isError?: boolean;
          toolCallId?: string;
          /** Pi's streaming tool output and its final result, kept only for the content dials. */
          partialResult?: unknown;
          result?: unknown;
          message?: { role?: string; content?: unknown };
        };
        if (e?.type === "tool_execution_end" && e.toolName) {
          // Struggle detection counts what the runtime itself observed. That is the only
          // honest source: the expert's own account of how many calls failed cannot be
          // verified, and it used to be the whole of our `toolErrors` telemetry, which
          // was really a 0/1 flag for "was this attempt classed as a tool error".
          const interactionTool = e.toolName === "report_and_stop" || e.toolName === "request_decision" || e.toolName === "request_tool";
          if (!interactionTool) {
            entry!.toolCalls += 1;
            if (e.isError === true) {
              entry!.toolErrors += 1;
              entry!.consecutiveToolErrors += 1;
            } else {
              entry!.consecutiveToolErrors = 0;
            }
            this.evaluateToolGuardrails(entry!, request);
          }
          if (entry!.onceTools?.has(e.toolName)) {
            entry!.onceTools!.delete(e.toolName);
            this.deactivateTool(entry!, e.toolName);
          }
        }
        // The interactive expert window: mirror activity into a bounded event file a
        // second terminal can follow. Read-only with respect to the run - it cannot
        // change tool behavior, and every write failure is swallowed by the chain.
        const obsState = this.observabilityState(request.executionId);
        if (obsState) {
          // The dial decides what is read out of the event, not whether the event is seen:
          // counters and guardrails above stay on their own path, so turning content
          // recording on cannot change how a run is judged.
          const content = obsState.content;
          const argsText =
            content && recordsToolArgs(content.level) ? safeJson(e.args) : undefined;
          if (e?.type === "tool_execution_start" && e.toolName) {
            const summary = this.toolArgumentSummary(e.args);
            this.emitObservability(request.executionId, request.role, request.model, "tool_started", {
              tool: e.toolName,
              ...(summary ? { argsSummary: summary } : {}),
            });
            // Pi forwards arguments on the start event only, so the top dial catches them here
            // and writes them with the closing record the operator actually reads.
            content?.noteArgs(e.toolCallId ?? e.toolName, e.toolName, argsText ?? "");
          } else if (e?.type === "tool_execution_end" && e.toolName) {
            this.emitObservability(request.executionId, request.role, request.model, "tool_finished", {
              tool: e.toolName,
              ok: e.isError !== true,
            });
            content?.onToolResult(
              e.toolCallId ?? e.toolName,
              e.toolName,
              e.isError !== true,
              toolResultText(e.result),
            );
          } else if (e?.type === "tool_execution_update" && e.toolName) {
            content?.onToolPartial(
              e.toolCallId ?? e.toolName,
              e.toolName,
              toolResultText(e.partialResult) ?? "",
            );
          } else if ((e?.type === "message_update" || e?.type === "message_end") && e.message?.role === "assistant") {
            if (content) {
              // A content dial streams the narration as it grows, so the end-of-message
              // duplicate is skipped on purpose: reprinting the whole paragraph after its
              // deltas would be the re-send the recorder's cursor exists to prevent. `final`
              // only tells the recorder to flush a fragment too small to have been worth a
              // record on its own - the last sentence must never be the one that is lost.
              content.onAssistantText(
                textFromContent(e.message.content),
                e?.type === "message_end",
              );
            } else if (e?.type === "message_end") {
              const narration = boundedText(textFromContent(e.message.content));
              if (narration)
                this.emitObservability(request.executionId, request.role, request.model, "assistant_text", { text: narration });
            }
          }
        }
      }) ?? undefined;
      // The abort may have arrived while preparing/provisioning the workspace.
      if (entry.abortRequested) {
        return await this.buildAbortedResult(entry, request, started);
      }
      if (request.reasoningLevel && session.getAvailableThinkingLevels?.().includes(request.reasoningLevel)) {
        session.setThinkingLevel?.(request.reasoningLevel);
      }
      const prompt = executionPrompt(request, await rolePrompt(request.role, this.options.roleDirectory), workspace.provisioning);
      const timeoutMs = request.timeoutMs;
      let timer: NodeJS.Timeout | undefined;
      const execution = (async () => {
        await session!.prompt(prompt);
        await session!.waitForIdle?.();
      })();
      // Budget warnings are armed against the deadline the Main Agent chose, so a
      // long quiet run is visible before it expires instead of only after.
      this.armBudgetWarnings(entry, request);
      // After a forced abort settle the prompt promise may never resolve;
      // its rejection must not surface as an unhandled rejection.
      void execution.catch(() => undefined);
      let forceSettle: (() => void) | undefined;
      const abortSettled = new Promise<void>((resolve) => {
        forceSettle = resolve;
      });
      entry!.forceSettle = forceSettle;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          entry!.timedOut = true;
          const aborting = session?.abort?.();
          void aborting?.catch(() => undefined);
          reject(new ExecutionTimeoutError(`Expert execution timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      });
      let stopDelivered: ExpertStopReport | undefined;
      const stopOutcome = stopReported.then((report) => {
        stopDelivered = report;
      });
      try {
        await Promise.race([execution, timeout, abortSettled, stopOutcome]);
      } catch (error) {
        if (error instanceof ExecutionTimeoutError) {
          const aborting = session.abort?.();
          void aborting?.catch(() => undefined);
        }
        if (stopDelivered) {
          const aborting = session.abort?.();
          void aborting?.catch(() => undefined);
        }
        // A Main-Agent abort is deliberate: return the preserved-progress
        // result instead of a failure so routing never retries or escalates it.
        if (entry.abortRequested && !entry.timedOut) {
          return await this.buildAbortedResult(entry, request, started);
        }
        // A genuine timeout keeps the session's evidence instead of degrading
        // into a bare thrown error: changed files and the last assistant text
        // are attached to a structured failed result (never retried as a crash).
        if (error instanceof ExecutionTimeoutError && entry.timedOut && !entry.abortRequested) {
          return await this.buildTimedOutResult(entry, request, started, timeoutMs);
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (entry.abortRequested) {
        return await this.buildAbortedResult(entry, request, started);
      }
      // The expert itself stopped via report_and_stop: deliver its structured
      // report as a partial result. `missing_context` semantics terminate the
      // delegation loop (no retry/escalation) while the worktree stays intact.
      if (stopDelivered) {
        return await this.buildStoppedResult(entry, request, started, stopDelivered);
      }
      const rawText = finalAssistantText(session);
      const sessionError = finalSessionError(session);
      if (sessionError) {
        const usage = sessionUsage(session);
        const evidence = await this.collectFailureEvidence(session, workspace);
        return {
          status: "failed",
          role: request.role,
          model: request.model,
          summary: safeText(`[Failure] ${sessionError}\n\n${evidence.lastText ?? ""}`.trim(), 4_000) ?? "Expert session failed.",
          ...(evidence.filesChanged?.length ? { filesChanged: evidence.filesChanged } : {}),
          ...risksWithDiffNote(evidence.filesChangedError, workspace.limitations),
          executionMetadata: {
            attempts: request.attempt,
            workspace: workspace.root,
            isolated: workspace.isolated,
            provisioning: workspace.provisioning,
        failureType: inferFailureType(sessionError),
        ...(evidence.filesChangedError ? { filesChangedError: evidence.filesChangedError } : {}),
            durationMs: Date.now() - started,
            ...(usage ? { usage } : {}),
          },
        };
      }
      // Verification gate: only a provisioned mutation worktree has the
      // dependencies needed to typecheck and test the repository. Read-only
      // roles and unprovisioned worktrees are never gated.
      let verification: VerificationEntry[] | undefined;
      if (
        workspace.strategy === "git-worktree" &&
        !effectiveReadOnly &&
        workspace.provisioning.status === "ready"
      ) {
        verification = await runVerification(workspace, this.options.config.security.workspaceProvisioning);
      }
      const diff = await this.expertChangedFiles(workspace);
      let result = applyVerificationGate(
        normalizeResult(extractJson(rawText), request, rawText, diff.files, workspace, sessionUsage(session), verification),
      );
      // A success that cannot list its own changes is only half a success. Without this the
      // host reads an empty `filesChanged` on a mutation run and integrates nothing
      // (defect #28) - the same damage #11 caused through the verification gate.
      const diffRisks = risksWithDiffNote(diff.error, workspace.limitations);
      if (diffRisks.risks) result = { ...result, risks: [...diffRisks.risks, ...(result.risks ?? [])].slice(0, 20) };
      result.executionMetadata = {
        ...result.executionMetadata,
        ...(diff.error ? { filesChangedError: diff.error } : {}),
        durationMs: Date.now() - started,
        ...(entry.interactionRounds ? { interactionRounds: entry.interactionRounds } : {}),
      };
      return result;
    } catch (error) {
      const evidence = await this.collectFailureEvidence(session, workspace);
      const baseSummary = safeText(error instanceof Error ? error.message : String(error), 4_000) ?? "Expert execution failed.";
      const summary = evidence.lastText
        ? safeText(`${baseSummary}\n\n${evidence.lastText}`.trim(), 4_000) ?? baseSummary
        : baseSummary;
      return {
        status: "failed",
        role: request.role,
        model: request.model,
        summary,
        ...(evidence.filesChanged?.length ? { filesChanged: evidence.filesChanged } : {}),
        ...risksWithDiffNote(evidence.filesChangedError, workspace?.limitations),
        executionMetadata: {
          attempts: request.attempt,
          failureType: inferFailureType(error),
          ...(evidence.filesChangedError ? { filesChangedError: evidence.filesChangedError } : {}),
          durationMs: Date.now() - started,
          ...(workspace ? { workspace: workspace.root, isolated: workspace.isolated, provisioning: workspace.provisioning } : {}),
        },
      };
    } finally {
      entry?.unsubscribe?.();
      this.clearBudgetWarnings(entry);
      if (entry) {
        // The entry is removed from activeSessions here, so the guardrail observations
        // are handed off to the wrapper, which merges them into whichever result the
        // inner path produced (success, partial, timeout, abort, or thrown error).
        this.lastGuardrails.set(executionKey, {
          toolCalls: entry.toolCalls,
          toolErrors: entry.toolErrors,
          attention: entry.attention.map((item) => ({ ...item })),
        });
      }
      this.activeSessions.delete(executionKey);
      session?.dispose();
    }
  }

  /**
   * Deliberately stop a running expert session. The session is aborted (not
   * killed), its attempt result becomes `aborted` with preserved progress, and
   * any mutation worktree stays intact until expert_cleanup.
   */
  async abortExecution(request: AbortExecutionRequest): Promise<AbortExecutionResult> {
    const entry = this.activeSessions.get(request.executionId);
    if (!entry) return { executionId: request.executionId, status: "not-found" };
    entry.abortRequested = true;
    entry.reason = request.reason;
    // A pre-registered entry has no session yet (still preparing/provisioning);
    // the flag alone makes executeExpert return an aborted result after setup.
    const aborting = entry.session?.abort?.();
    void aborting?.catch(() => undefined);
    // A Pi session may never settle its prompt promise after abort(); force
    // the execution race to settle so executeExpert emits the aborted result
    // and its finally cleanup (activeSessions.delete + dispose) always runs.
    entry.forceSettle?.();
    const progress = await this.inspectEntry(request.executionId, entry).catch(() => undefined);
    return { executionId: request.executionId, status: "abort-requested", progress };
  }

  async inspectExecution(executionId: string): Promise<ExecutionProgress | undefined> {
    const entry = this.activeSessions.get(executionId);
    if (!entry) return undefined;
    return await this.inspectEntry(executionId, entry);
  }

  /**
   * Raise a non-terminal interaction (decision point or tool approval) and block
   * the expert's turn until the Main Agent answers through `respondToInteraction`
   * or a conservative bound is reached. This mirrors the in-process
   * `report_and_stop` template but does NOT end the execution: the awaiting tool
   * returns the answer to the same live session so the expert continues.
   *
   * Guards: a per-execution round cap (beyond it the expert is told to decide
   * autonomously) and a wait timeout (the expert continues on the most
   * conservative path). Both cap the blast radius of a headless host that never
   * polls, so a blocked tool can never wedge the execution.
   */
  async beginInteraction(executionKey: string, request: InteractionRequest): Promise<{
    response: InteractionResponse;
    hostAbsent: boolean;
    exhausted: boolean;
  }> {
    const entry = this.activeSessions.get(executionKey);
    const maxRounds = this.options.maxInteractionRounds ?? 3;
    const timeoutMs = this.options.interactionTimeoutMs ?? 900_000;
    const autonomous: InteractionResponse = request.kind === "decision"
      ? { kind: "decision", otherText: "No answer available — choose the most conservative reasonable option yourself and note the assumption in your risks." }
      : { kind: "tool_approval", scope: "reject" };
    if (!entry || (entry.interactionRounds ?? 0) >= maxRounds) {
      this.emitObservability(executionKey, entry?.role ?? "unknown", entry?.model, "interaction_answered", {
        text: boundedText("no interaction budget left; the expert decides alone"),
      });
      return { response: { ...autonomous, otherText: autonomous.otherText ?? "Interaction budget exhausted; decide autonomously and note the assumption." }, hostAbsent: true, exhausted: true };
    }
    // Exactly one interaction may be open per execution. The host answers the single
    // pendingInteraction slot, so a concurrent second request (two tool calls issued
    // in one assistant turn) must not overwrite the first: that would leave the
    // orphaned tool call hanging until the wait timeout while nothing shows it as
    // answerable. Refuse it immediately with an explicit instruction, and do not
    // charge the refusal against the round budget - the expert did get a real answer
    // path for the interaction that is open.
    if (entry.pendingInteraction) {
      this.emitObservability(executionKey, entry.role, entry.model, "interaction_answered", {
        tool: request.kind === "tool_approval" ? request.tool : undefined,
        text: boundedText("refused: another interaction is already open for this execution"),
      });
      return {
        response: request.kind === "decision"
          ? { kind: "decision", otherText: "An interaction is already awaiting the Main Agent for this execution, so this one was not asked. Choose the most conservative reasonable option yourself, note the assumption in your risks, and do not ask again while one is open." }
          : { kind: "tool_approval", scope: "reject" },
        hostAbsent: true,
        exhausted: false,
      };
    }
    entry.interactionRounds = (entry.interactionRounds ?? 0) + 1;
    const round = entry.interactionRounds;
    const openedAt = new Date().toISOString();
    entry.pendingInteraction = { request, openedAt, round };
    this.emitObservability(executionKey, entry.role, entry.model, "interaction_opened", {
      tool: request.kind === "tool_approval" ? request.tool : undefined,
      text: boundedText(
        request.kind === "decision"
          ? `round ${round}: ${request.question ?? "decision"}${request.options?.length ? ` [${request.options.map((option) => option.label).join(" | ")}]` : ""}`
          : `round ${round}: needs approval for ${request.tool ?? "a tool"}`,
      ),
    });
    const answer = await new Promise<InteractionResponse>((resolve) => {
      const finish = (response: InteractionResponse) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        entry.pendingInteraction = undefined;
        entry.resolveInteraction = undefined;
        this.emitObservability(executionKey, entry.role, entry.model, "interaction_answered", {
          tool: response.kind === "tool_approval" ? request.tool : undefined,
          text: boundedText(String(response.kind === "decision"
            ? response.choice ?? response.otherText ?? "answered"
            : response.scope ?? "answered")),
        });
        resolve(response);
      };
      let settled = false;
      entry.resolveInteraction = finish;
      const timer = setTimeout(() => finish(autonomous), timeoutMs);
      void timer;
    });
    const hostAbsent = !this.lastHostResponded.get(executionKey);
    this.lastHostResponded.delete(executionKey);
    return { response: answer, hostAbsent, exhausted: false };
  }

  async respondToInteraction(executionId: string, response: InteractionResponse): Promise<RespondToInteractionResult> {
    const entry = this.activeSessions.get(executionId);
    if (!entry) return { executionId, status: "not-found" };
    const pending = entry.pendingInteraction;
    if (!pending) return { executionId, status: "no-pending" };
    if (response.kind !== pending.request.kind) {
      return { executionId, status: "kind-mismatch", kind: pending.request.kind, message: `Pending interaction is a '${pending.request.kind}'; the response declared '${response.kind}'.` };
    }
    if (response.kind === "tool_approval" && !response.scope) {
      return { executionId, status: "kind-mismatch", kind: pending.request.kind, message: "tool_approval responses must set scope to once, persistent, or reject." };
    }
    if (response.kind === "decision" && !response.choice && !response.otherText) {
      return { executionId, status: "kind-mismatch", kind: pending.request.kind, message: "decision responses must set choice or otherText." };
    }
    this.lastHostResponded.set(executionId, true);
    entry.resolveInteraction?.(response);
    return { executionId, status: "resolved", kind: response.kind };
  }

  /** Activate a tool on a live session for dynamic permission grants; false if unsupported or unknown. */
  private activateTool(entry: ActiveExpertSession, tool: string): boolean {
    if (!entry.session?.setActiveToolsByName || !entry.activeToolNames) return false;
    if (entry.activeToolNames.includes(tool)) return true;
    entry.activeToolNames = [...entry.activeToolNames, tool];
    entry.session.setActiveToolsByName(entry.activeToolNames);
    return true;
  }

  /** Deactivate a previously once-granted tool after its single use. */
  private deactivateTool(entry: ActiveExpertSession, tool: string): void {
    if (!entry.session?.setActiveToolsByName || !entry.activeToolNames) return;
    if (!entry.activeToolNames.includes(tool)) return;
    entry.activeToolNames = entry.activeToolNames.filter((name) => name !== tool);
    entry.session.setActiveToolsByName(entry.activeToolNames);
  }

  private async inspectEntry(executionId: string, entry: ActiveExpertSession): Promise<ExecutionProgress> {
    // A pre-registered entry has no session until workspace preparation and
    // provisioning finish; report an empty progress snapshot for that phase.
    if (!entry.session) {
      return {
        executionId,
        status: "running",
        role: entry.role,
        model: entry.model,
        startedAt: new Date(entry.startedAt).toISOString(),
        elapsedMs: Date.now() - entry.startedAt,
        messageCount: 0,
        filesChangedSoFar: [],
      };
    }
    const messages = entry.session.messages ?? entry.session.state?.messages ?? [];
    const text = finalAssistantText(entry.session);
    const filesChangedSoFar = (await this.expertChangedFiles(entry.workspace)).files;
    return {
      executionId,
      status: "running",
      role: entry.role,
      model: entry.model,
      startedAt: new Date(entry.startedAt).toISOString(),
      elapsedMs: Date.now() - entry.startedAt,
      messageCount: messages.length,
      ...(text ? { lastAssistantText: safeText(text, 2_000) } : {}),
      workspace: entry.workspace.root,
      isolated: entry.workspace.isolated,
      ...(entry.pendingInteraction ? { pendingInteraction: entry.pendingInteraction } : {}),
      toolCalls: entry.toolCalls,
      toolErrors: entry.toolErrors,
      ...(typeof entry.timeoutMs === "number" && entry.timeoutMs > 0
        ? { budgetFractionUsed: Math.min(1, (Date.now() - entry.startedAt) / entry.timeoutMs) }
        : {}),
      ...(entry.attention.length ? { attention: entry.attention.map((item) => ({ ...item })) } : {}),
      ...(filesChangedSoFar.length ? { filesChangedSoFar: filesChangedSoFar.slice(0, 200) } : {}),
    };
  }

  /**
   * Files this expert can honestly claim as its own work - and whether that question could
   * be answered at all. A read-only execution runs in the main workspace and cannot mutate
   * anything, so any git-dirty file there belongs to the Main Agent; reporting it as the
   * expert's change fabricates authorship. An empty list and a failed diff are also
   * different facts: collapsing them lets a mutation workspace whose `git diff` broke (the
   * `$GIT_DIR` too big class, defect #11) report "the expert changed nothing", which is how
   * correct work gets thrown away (defect #28).
   */
  private async expertChangedFiles(workspace: PreparedWorkspace): Promise<{ files: string[]; error?: string }> {
    if (workspace.strategy === "read-only") return { files: [] };
    try {
      return await this.boundary.changedFiles(workspace);
    } catch (error) {
      return {
        files: [],
        error: String(error instanceof Error ? error.message : error).slice(0, 200),
      };
    }
  }

  /**
   * Preserve failure evidence from a dead session: changed files from the
   * prepared workspace (undefined for read-only/no-worktree runs or when the
   * diff fails) and the last assistant text. Best-effort at every step.
   */
  private async collectFailureEvidence(
    session?: PiSessionLike,
    workspace?: PreparedWorkspace,
  ): Promise<{ filesChanged?: string[]; filesChangedError?: string; lastText?: string }> {
    let filesChanged: string[] | undefined;
    let filesChangedError: string | undefined;
    if (workspace) {
      const diff = await this.expertChangedFiles(workspace);
      filesChanged = diff.files.slice(0, 1_000);
      filesChangedError = diff.error;
    }
    const lastText = session ? finalAssistantText(session) : "";
    return {
      ...(filesChanged?.length ? { filesChanged } : {}),
      ...(filesChangedError ? { filesChangedError } : {}),
      ...(lastText ? { lastText } : {}),
    };
  }

  /** Build the evidence-preserving failed result for a timed-out expert execution. */
  private async buildTimedOutResult(
    entry: ActiveExpertSession,
    request: ExpertExecutionRequest,
    started: number,
    timeoutMs: number,
  ): Promise<ExpertResult> {
    const evidence = await this.collectFailureEvidence(entry.session, entry.workspace);
    const usage = sessionUsage(entry.session);
    const summary = safeText(
      `[Failure] Expert execution timed out after ${timeoutMs}ms.${evidence.lastText ? `\n\n${evidence.lastText}` : ""}`.trim(),
      4_000,
    ) ?? `[Failure] Expert execution timed out after ${timeoutMs}ms.`;
    return {
      status: "failed",
      role: request.role,
      model: request.model,
      summary,
      ...(evidence.filesChanged?.length ? { filesChanged: evidence.filesChanged } : {}),
      ...risksWithDiffNote(evidence.filesChangedError),
      executionMetadata: {
        attempts: request.attempt,
        failureType: "timeout",
        ...(evidence.filesChangedError ? { filesChangedError: evidence.filesChangedError } : {}),
        workspace: entry.workspace.root,
        isolated: entry.workspace.isolated,
        provisioning: entry.workspace.provisioning,
        durationMs: Date.now() - started,
        ...(entry.interactionRounds ? { interactionRounds: entry.interactionRounds } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  }

  /** Build the preserved-progress result for a Main-Agent abort. */
  private async buildAbortedResult(
    entry: ActiveExpertSession,
    request: ExpertExecutionRequest,
    started: number,
  ): Promise<ExpertResult> {
    const rawText = finalAssistantText(entry.session);
    const changed = await this.expertChangedFiles(entry.workspace);
    const changedFiles = changed.files;
    const reason = entry.reason ? ` Abort reason: ${entry.reason}` : "";
    const summary = rawText
      ? safeText(`${rawText}\n\n[Execution aborted by the Main Agent.${reason}]`, 4_000)
      : `Expert execution aborted by the Main Agent.${reason}`;
    const usage = sessionUsage(entry.session);
    return {
      status: "aborted",
      role: request.role,
      model: request.model,
      summary: summary ?? "Expert execution aborted by the Main Agent.",
      ...(changedFiles.length ? { filesChanged: changedFiles.slice(0, 1_000) } : {}),
      ...risksWithDiffNote(changed.error),
      executionMetadata: {
        attempts: request.attempt,
        workspace: entry.workspace.root,
        isolated: entry.workspace.isolated,
        provisioning: entry.workspace.provisioning,
        failureType: "aborted",
        ...(changed.error ? { filesChangedError: changed.error } : {}),
        durationMs: Date.now() - started,
        ...(entry.interactionRounds ? { interactionRounds: entry.interactionRounds } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  }

  /** Build the preserved-progress result for an expert-initiated report_and_stop. */
  private async buildStoppedResult(
    entry: ActiveExpertSession,
    request: ExpertExecutionRequest,
    started: number,
    report: ExpertStopReport,
  ): Promise<ExpertResult> {
    const changed = await this.expertChangedFiles(entry.workspace);
    const changedFiles = changed.files;
    const usage = sessionUsage(entry.session);
    const summary = safeText(
      `[Task stopped by expert] ${report.reason}\n\n${finalAssistantText(entry.session) ?? ""}`.trim(),
      4_000,
    ) ?? `[Task stopped by expert] ${report.reason}`;
    return {
      status: "partial",
      role: request.role,
      model: request.model,
      summary,
      ...(changedFiles.length ? { filesChanged: changedFiles.slice(0, 1_000) } : {}),
      ...(report.findings?.length ? { findings: report.findings } : {}),
      ...risksWithDiffNote(changed.error, report.risks),
      ...(report.recommendedNextAction ? { recommendedNextAction: report.recommendedNextAction } : {}),
      executionMetadata: {
        attempts: request.attempt,
        workspace: entry.workspace.root,
        isolated: entry.workspace.isolated,
        provisioning: entry.workspace.provisioning,
        failureType: "missing_context",
        ...(changed.error ? { filesChangedError: changed.error } : {}),
        stoppedByExpert: true,
        durationMs: Date.now() - started,
        ...(entry.interactionRounds ? { interactionRounds: entry.interactionRounds } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  }

  async cleanupExecution(executionId: string) {
    this.observerWindows?.release(executionId);
    return this.boundary.cleanupExecution(executionId);
  }

  /**
   * Run one bounded verification command on behalf of the Main Agent: inside a
   * retained worktree (resolved by executionId) or a containment-validated
   * workspace path. No string shell: the first argv item is executed directly
   * through the same execFile-based bounded runner the provisioning path uses,
   * with the scrubbed provisioning environment and a clamped timeout.
   */
  async verifyCommand(request: VerifyCommandRequest): Promise<VerifyCommandResult> {
    const started = Date.now();
    const rejected = (message: string): VerifyCommandResult => ({ exitCode: null, durationMs: Date.now() - started, message });
    const command = request.command;
    if (!Array.isArray(command) || command.length < 1 || command.length > 12) {
      return rejected("verifyCommand requires a command array of 1 to 12 items.");
    }
    if (command.some((item) => typeof item !== "string" || item.length < 1 || item.length > 500 || item.includes("\0"))) {
      return rejected("Each verifyCommand item must be a non-empty string of at most 500 characters without NUL.");
    }
    let directory: string | undefined;
    if (request.executionId !== undefined) {
      directory = await this.boundary.retainedWorktree(request.executionId);
    }
    if (!directory && request.workspace !== undefined) {
      try {
        directory = await this.boundary.resolveReadOnlyWorkspace(request.workspace);
      } catch (error) {
        return rejected(`Workspace rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!directory) {
      return rejected(
        request.executionId !== undefined
          ? `No retained worktree was found for execution ${request.executionId} and no workspace was supplied.`
          : "verifyCommand requires an executionId with a retained worktree or a workspace inside the allowed roots.",
      );
    }
    const timeoutMs = Math.min(Math.max(Math.round(request.timeoutMs ?? 120_000), 1_000), 600_000);
    const outcome = await runBoundedCommand([...command], {
      cwd: directory,
      timeoutMs,
      env: scrubProvisioningEnv(process.env),
    });
    return {
      exitCode: outcome.timedOut ? null : outcome.exitCode,
      outputTail: tailCommandOutput(`${outcome.stdout}\n${outcome.stderr}`, 2_000),
      durationMs: Date.now() - started,
      ...(outcome.timedOut ? { message: `Command was killed after ${timeoutMs}ms.` } : {}),
      ...(!outcome.timedOut && outcome.error ? { message: outcome.error.slice(0, 500) } : {}),
    };
  }
}
