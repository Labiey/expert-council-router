export const CAPABILITY_DIMENSIONS = [
  "reasoning",
  "planning",
  "architecture",
  "coding",
  "debugging",
  "review",
  "longContext",
  "toolReliability",
  "bashReliability",
  "autonomousExecution",
  "speed",
] as const;

export type CapabilityDimension = (typeof CAPABILITY_DIMENSIONS)[number];
export type CapabilityProfile = Partial<Record<CapabilityDimension, number | null>>;
export type BillingType = "subscription" | "metered" | "quota" | "free" | "unknown";
export type CostPolicy = "economy" | "balanced" | "speed" | "quality";
export type ExpertRole =
  | "planner"
  | "scout"
  | "architecture-oracle"
  | "implementation-worker"
  | "debugger"
  | "reviewer"
  | "verifier";
export type TaskClass = "tiny" | "normal" | "complex-feature" | "complex-debugging" | "architecture";
export type FailureType =
  | "tool_call_error"
  | "reasoning_failure"
  | "test_failure"
  | "timeout"
  | "provider_error"
  | "missing_context"
  | "permission_error"
  | /** The Main Agent deliberately ended the execution; never retried or escalated. */
    "aborted"
  | "unknown";

export interface ApiCost {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface AvailableModel {
  provider: string;
  id: string;
  displayName?: string;
  family?: string;
  available: boolean;
  reasoning?: boolean;
  supportedReasoningLevels?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  apiCost?: ApiCost;
  billingProfile?: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SkillInfo {
  name: string;
  description?: string;
  installed: boolean;
  enabled: boolean;
  trusted?: boolean;
  source?: string;
}

export interface WorkspaceProvisioningConfig {
  mode: "auto" | "none" | "custom";
  /** Per-command deadline for provisioning and verification children. */
  timeoutMs: number;
  /** Maximum simultaneous provisioning child processes; defaults to 1. */
  maxConcurrent: number;
  /** Explicit argv used verbatim when mode is "custom". */
  command?: string[];
  /**
   * How to materialize a worktree's dependencies. "auto" runs the detected
   * ecosystem driver; "as-code" additionally prefers a detected Nix/devcontainer
   * backend; "in-place" skips installs and relies on read-only execution against
   * the host workspace; "drivers" is an alias for per-ecosystem standard installs.
   * The default "auto" never shares a recompiled build/target directory across
   * concurrent worktrees (cargo locks it); each worktree materializes its own
   * project-local dir from the ecosystem's already-global download cache.
   */
  strategy?: "auto" | "drivers" | "as-code" | "in-place";
  /**
   * Whether provisioning/verification children inherit host environment. "isolated"
   * (default) uses the scrubbed allowlist; "host-env" additionally passes through
   * toolchain and cache-location variables (PATH, HOME, *CACHE*, *TARGET_DIR*, JAVA_HOME,
   * GOPATH, CARGO_HOME, NUGET_PACKAGES, ...) so global caches resolve to one place.
   */
  runtimeEnv?: "isolated" | "host-env";
  /** Explicit verification argv; when omitted the runtime runs typecheck then tests. */
  verifyCommand?: string[];
  /** Restrict the child environment to a fixed allowlist. */
  scrubEnv: boolean;
  /** Deadline for worktree removal (`git worktree remove`). */
  removalTimeoutMs: number;
}

/** Expert progress visibility settings (security.observability). */
export interface ObservabilityConfig {
  /**
   * "off" = minimal running view; "events" = bounded live progress.
   * "interactive" is accepted for forward compatibility but is not a distinct
   * mode yet (no RPC projection): it behaves exactly as "events", and
   * `expert_inspect` reports a warning so a host is never left guessing.
   */
  expertWindow: "off" | "events" | "interactive";
  /**
   * Whether the bounded live progress block is surfaced in running views.
   * The pendingInteraction channel is always on: it is a correctness channel,
   * not an observability one.
   */
  streamToHost: boolean;
  /**
   * Only meaningful with `expertWindow: "interactive"`, which writes a live event
   * stream to the data directory for another terminal to follow. When true (the
   * default) tool invocations are recorded by name only; when false a bounded
   * argument summary is written too, which can contain file paths and shell
   * commands. The event file is local-only, like telemetry.
   */
  redactToolArgs: boolean;
}

/** One observed moment in an expert's live event stream. */
export type ExpertEventKind =
  | "started"
  | "tool_started"
  | "tool_finished"
  | "assistant_text"
  /**
   * A tool result, recorded only from the `assistant+tool-tail` content dial up.
   * `streaming: true` marks a partial block that is still growing; the closing event for
   * the same call carries the complete payload with `streaming` absent.
   */
  | "tool_output"
  | "attention"
  | "interaction_opened"
  | "interaction_answered"
  | "stopped"
  | "completed"
  | "failed"
  | "stream_truncated"
  /**
   * Written once, when the delegation itself is over. A per-attempt terminal event cannot
   * say that: a retried or escalated delegation emits one per attempt, so a watcher that
   * stopped on the first would close its window exactly when the interesting part begins.
   */
  | "delegation_final";

/**
 * Kinds that report how an attempt or a delegation ended. A stream ceiling may drop content
 * and activity, never these: an observer that goes quiet mid-run is a mystery, while one that
 * reports the outcome after dropping everything else has done its job. `watch` in the CLI
 * keeps its own tolerant copy because a reader must survive kinds this list has never heard of.
 */
export const TERMINAL_EVENT_KINDS: readonly ExpertEventKind[] = ["stopped", "completed", "failed", "delegation_final"];

/**
 * A single line of the cross-process observability stream written when
 * `security.observability.expertWindow` is `"interactive"`. Bounded by construction:
 * never a chain of thought (`textFromContent` keeps only `type: "text"` parts, so
 * `thinking`/`reasoning` cannot enter). By default there is no tool output and no tool
 * argument text; the `security.observability.contentStream` dials widen that deliberately,
 * in ascending order of what reaches disk - see `CONTENT_LEVELS`.
 */
export interface ExpertObservabilityEvent {
  /** Wall-clock ISO timestamp of when the runtime observed the event. */
  t: string;
  executionId: string;
  role: string;
  model?: string;
  /** Which attempt of this delegation produced the event (1-based; absent on delegation-level events). */
  attempt?: number;
  kind: ExpertEventKind;
  tool?: string;
  ok?: boolean;
  /** Bounded expert-authored text, or an interaction/terminal detail. */
  text?: string;
  /** Guardrail counters, carried so an operator's terminal shows what the host notice shows. */
  toolCalls?: number;
  toolErrors?: number;
  budgetFractionUsed?: number;
  nudgedExpert?: boolean;
  /** Bounded argument summary; present only when redactToolArgs is false. */
  argsSummary?: string;
  /**
   * Full arguments, recorded only at the top dial (`transcript+args`) - the one dial that
   * can put a secret on disk, since arguments are shell commands and paths.
   */
  argsText?: string;
  /** True while a tool block is still streaming; absent on its complete final record. */
  streaming?: boolean;
  /** Bytes dropped between the stored head and tail, so truncation stays visible. */
  omittedBytes?: number;
  /** 1-based line of this record in the stream file: where to read the rest. */
  line?: number;
  status?: string;
  failureType?: string;
  durationMs?: number;
}

export interface RuntimeCapabilities {
  hostType: string;
  modelDiscovery: boolean;
  hardToolRestriction: boolean;
  skillOverride: boolean;
  subagentBackend: boolean;
  mutation: boolean;
  workspaceIsolation: "git-worktree" | "bounded-workspace" | "none";
  sourceWorkspaceDirty?: boolean;
  /** Active worktree provisioning mode, surfaced so hosts can warn before delegation. */
  workspaceProvisioning?: { mode: string };
  /**
   * Live cross-process event stream availability, i.e. what `expertWindow:
   * "interactive"` + `expert-council watch` can observe. Absent when the runtime
   * cannot write one, so a host never promises a window it cannot open.
   */
  eventStream?: { enabled: boolean; dir?: string; redactToolArgs?: boolean };
  supportedTools: string[];
  limitations: string[];
  /** Runtime can raise/await a decision or tool-approval interaction mid-turn. */
  realtimeInteraction?: boolean;
  /** Runtime can change an expert's active tools after approval. */
  dynamicToolPermissions?: boolean;
}

export interface ExpertExecutionRequest {
  executionId?: string;
  role: ExpertRole;
  task: string;
  model: string;
  tools: string[];
  skills: string[];
  reasoningLevel?: string;
  readOnly: boolean;
  workspace?: string;
  /** Explicit expert execution deadline in milliseconds (1_000–3_600_000). */
  timeoutMs: number;
  attempt: number;
  priorFailure?: { type: FailureType; summary: string };
}

export interface TestResult {
  command?: string;
  status: "passed" | "failed" | "not-run";
  summary?: string;
  /** Exit code of the test command when it ran (integer 0–255). */
  exitCode?: number;
  /** Total tests executed, when the runner reports it (integer 0–1_000_000). */
  testsRun?: number;
  /** Failing tests, when the runner reports it (integer 0–1_000_000). */
  failedCount?: number;
  /** Errored tests, when the runner reports it (integer 0–1_000_000). */
  errorCount?: number;
  /** Skipped tests, when the runner reports it (integer 0–1_000_000). */
  skippedCount?: number;
  /** Wall-clock duration of the test command in milliseconds (finite, ≥ 0). */
  durationMs?: number;
  /** Last lines of the real test output, bounded to 2000 characters. */
  outputTail?: string;
}

export interface ExpertResult {
  status: "success" | "partial" | "failed" | "aborted";
  role: ExpertRole;
  model: string;
  summary: string;
  filesChanged?: string[];
  tests?: TestResult[];
  findings?: string[];
  risks?: string[];
  recommendedNextAction?: string;
  executionMetadata?: {
    executionId?: string;
    attempts?: number;
    failureType?: FailureType;
    usage?: unknown;
    durationMs?: number;
    workspace?: string;
    isolated?: boolean;
    escalationCount?: number;
    /** Models whose runtime failure marked them unavailable in the persisted model assessment during this execution. */
    unavailableModels?: string[];
    /** True when the expert itself stopped via report_and_stop (task impossible with the assigned tools/workspace). */
    stoppedByExpert?: boolean;
    /** Decision and tool-approval interactions raised by the expert during this execution. */
    interactionRounds?: number;
    /** Tool calls attempted and observed to fail, counted by the runtime, not self-reported. */
    toolCalls?: number;
    toolErrors?: number;
    /** Stall/budget warnings raised during the run, oldest first, bounded. */
    attention?: ExpertAttention[];
    /** Per-attempt record of this delegation, so the host never has to dig through state files. */
    attemptHistory?: AttemptRecord[];
    /**
     * Availability-marker writes that failed during this delegation. Persistence is
     * best-effort, but a marker that never reached disk means the next delegation will
     * repeat a failure this one already learned about - which is the host's business, not
     * something to swallow (defect #25 hid behind exactly such a catch).
     */
    persistenceErrors?: Array<{ model: string; detail: string }>;
    /**
     * Set when the workspace diff could not be read, so an absent `filesChanged` means
     * "unknown" rather than silently meaning "the expert changed nothing" (defect #28).
     */
    filesChangedError?: string;
    /** Outcome of runtime worktree provisioning for this attempt. */
    provisioning?: {
      status: "ready" | "skipped" | "failed";
      packageManager?: string;
      command?: string;
      durationMs?: number;
      detail?: string;
    };
    /** Runtime verification gate entries (typecheck/test), populated only for provisioned mutation worktrees. */
    verification?: Array<{
      command?: string;
      status: "passed" | "failed" | "not-run";
      summary?: string;
      /** Exit code of the verification command when it ran (integer 0–255). */
      exitCode?: number;
      /** Last lines of the real verification output, bounded to 2000 characters. */
      outputTail?: string;
    }>;
  };
}

export interface ExpertRuntime {
  listAvailableModels(): Promise<AvailableModel[]>;
  /** Run a bounded verification command inside a retained worktree or validated workspace. */
  verifyCommand?(request: VerifyCommandRequest): Promise<VerifyCommandResult>;
  listProviderBilling?(): Promise<Record<string, RuntimeBillingDiscovery>>;
  executeExpert(request: ExpertExecutionRequest): Promise<ExpertResult>;
  listSkills(): Promise<SkillInfo[]>;
  /**
   * Runtime capability report. When `cwd` is supplied, mutation capability is
   * evaluated for that workspace instead of the startup directory, so a
   * writable delegation into a Git repository subfolder is not rejected
   * because the conversation's startup folder is not a repository.
   */
  getCapabilities(cwd?: string): Promise<RuntimeCapabilities>;
  /** Deliberately stop a running expert session and preserve its progress; never retried or escalated. */
  abortExecution?(request: AbortExecutionRequest): Promise<AbortExecutionResult>;
  /** Bounded progress snapshot of a running expert execution. */
  inspectExecution?(executionId: string): Promise<ExecutionProgress | undefined>;
  /** Resolve a running expert's pending interaction (decision or tool approval) so its turn continues. */
  respondToInteraction?(executionId: string, response: InteractionResponse): Promise<RespondToInteractionResult>;
  cleanupExecution?(executionId: string): Promise<Omit<ExpertCleanupResult, "executionId">>;
  /**
   * Mark a delegation finished for observers, after its last attempt has been delivered.
   * Optional: a runtime that cannot supply it degrades to the watcher's quiet-period rule
   * rather than leaving a window open forever.
   */
  finalizeDelegation?(executionId: string, role: ExpertRole): Promise<void> | void;
}

export interface RuntimeBillingDiscovery {
  policy: BillingPolicyEntry;
  source: "pi-runtime" | "pi-provider-catalog" | "pi-model-catalog" | "unverified";
  reason: string;
}

/** Why the council thinks an expert is struggling rather than merely busy. */
export type AttentionCode =
  | "consecutive_tool_failures"
  | "failure_ratio_high"
  | "budget_fraction";

/**
 * A non-blocking warning about one running execution. Attention is deliberately not
 * an interaction: it never waits for an answer, and it does not abort the expert -
 * a false positive costs one wasted run, an auto-abort would destroy good work.
 */
export interface ExpertAttention {
  code: AttentionCode;
  at: string;
  /** One bounded line, safe to show to a human or feed back to the expert. */
  detail: string;
  toolCalls?: number;
  toolErrors?: number;
  consecutiveToolErrors?: number;
  budgetFractionUsed?: number;
  /** Whether the expert itself was steered with a bounded nudge. */
  nudgedExpert?: boolean;
}

/** One attempt of a delegation, as observed by the council. */
export interface AttemptRecord {
  attempt: number;
  model: string;
  status: string;
  failureType?: FailureType;
  durationMs?: number;
  /** Bounded first line of the attempt's own summary; never a transcript. */
  summary?: string;
}

export interface ExecutionProgress {
  executionId: string;
  status: "running";
  role: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
  messageCount: number;
  /** Latest assistant output, bounded; the material for verification, handoff, or intervention. */
  lastAssistantText?: string;
  workspace?: string;
  isolated?: boolean;
  filesChangedSoFar?: string[];
  /** A live interaction the blocked expert is waiting on the Main Agent to resolve. */
  pendingInteraction?: PendingInteraction;
  /** Tool calls attempted / observed to fail so far, counted by the runtime. */
  toolCalls?: number;
  toolErrors?: number;
  /** Fraction of the execution budget already used (0-1), when a budget exists. */
  budgetFractionUsed?: number;
  /** Stall/budget warnings raised so far. */
  attention?: ExpertAttention[];
}

/** One selectable answer for a decision point. */
export interface DecisionOption {
  label: string;
  /** Short impact/tradeoff explanation shown to the Main Agent. */
  description?: string;
}

export type InteractionKind = "decision" | "tool_approval";

/**
 * A non-terminal interaction raised by a running expert for the Main Agent to
 * resolve. `decision` is "this is doable but the direction is yours to pick";
 * `tool_approval` is "I need a tool my role does not grant by default". Both
 * pause the expert's turn in place without ending the execution (unlike the
 * terminal `report_and_stop`).
 */
export interface InteractionRequest {
  kind: InteractionKind;
  /** For decisions: the question posed to the Main Agent. */
  question?: string;
  /** For decisions: up to four recommended options; the host may also answer with free text. */
  options?: DecisionOption[];
  /** For decisions: whether an "Others" free-text answer is allowed (default true). */
  allowOther?: boolean;
  /** Optional bounded context explaining why the expert is asking. */
  context?: string;
  /** For tool approvals: the tool the expert wants to use. */
  tool?: string;
  /** Bounded reason / argument summary for the approval request. */
  reason?: string;
}

/** How the host answered a tool-approval request. */
export type ToolGrantScope = "once" | "persistent" | "reject";

export interface InteractionResponse {
  kind: InteractionKind;
  /** For decisions: the chosen option label (must be one of the offered options). */
  choice?: string;
  /** For decisions: free-text answer when `allowOther` and the host chose "Others". */
  otherText?: string;
  /** For tool approvals: grant once, grant for the rest of the session, or reject. */
  scope?: ToolGrantScope;
}

/** A live, unresolved interaction attached to a running execution snapshot. */
export interface PendingInteraction {
  request: InteractionRequest;
  /** ISO time the expert raised the interaction. */
  openedAt: string;
  /** 1-based interaction number within this execution, for round-cap display. */
  round: number;
}

export interface RespondToInteractionRequest {
  executionId: string;
  response: InteractionResponse;
}

export interface RespondToInteractionResult {
  executionId: string;
  status: "resolved" | "no-pending" | "not-found" | "kind-mismatch";
  kind?: InteractionKind;
  message?: string;
}

export interface AbortExecutionRequest {
  executionId: string;
  /** Recorded with the abort so the Main Agent can document why work stopped. */
  reason?: string;
}

export interface AbortExecutionResult {
  executionId: string;
  status: "abort-requested" | "not-found" | "already-finished";
  reason?: string;
  /** Final progress snapshot captured at abort time: the handoff brief. */
  progress?: ExecutionProgress;
}

export interface ExpertCleanupResult {
  executionId: string;
  status: "cleaned" | "not-found" | "not-required" | "failed" | "unsupported";
  /** Newest matching worktree, retained for compatibility with V1 callers. */
  workspace?: string;
  /** Every retry/escalation worktree removed for this execution. */
  workspaces?: string[];
  removedCount?: number;
  message?: string;
}

/** Clear runtime availability markers by scope: "*", a bare provider, or an exact "provider/id" key. */
export interface ResetAvailabilityRequest {
  scope: string;
}

export interface ResetAvailabilityResult {
  /** Sorted unique model keys removed from the availability markers and status map. */
  cleared: string[];
}

/** Bounded verification command run by the runtime on behalf of the Main Agent. */
export interface VerifyCommandRequest {
  /** Retained worktree of this execution is used as the command directory when present. */
  executionId?: string;
  /** Explicit workspace path; must pass the same containment validation as read-only delegation. */
  workspace?: string;
  /** Command argv; 1–12 items, each a non-empty string of at most 500 characters without NUL. */
  command: string[];
  /** Command deadline in milliseconds, clamped to [1_000, 600_000]; default 120_000. */
  timeoutMs?: number;
}

export interface VerifyCommandResult {
  /** Process exit code, or null when the command was killed by the timeout or the request was rejected. */
  exitCode: number | null;
  /** Last lines of the combined output, bounded to 2000 characters. */
  outputTail?: string;
  durationMs: number;
  /** Rejection reason or timeout note; absent on a clean run. */
  message?: string;
}

export interface BillingPolicyEntry {
  billingType: BillingType;
  /**
   * Relative token-consumption weight used for cost scoring and cap
   * accounting. Default 1.0.
   */
  costMultiplier?: number;
  disabled?: boolean;
}

export interface ModelProfile extends CapabilityProfile {
  disabled?: boolean;
  billingProfile?: string;
  preferredReasoningByRole?: Partial<Record<ExpertRole, string | null>>;
  incompatibleRoles?: ExpertRole[];
  /** Explicit operator/host decision to route to a model even while a runtime availability marker is active. */
  overrideUnavailableMarker?: boolean;
}

export interface ResolvedModelProfile extends Partial<Record<CapabilityDimension, number>> {
  disabled?: boolean;
  billingProfile?: string;
  preferredReasoningByRole?: Partial<Record<ExpertRole, string>>;
  incompatibleRoles?: ExpertRole[];
  overrideUnavailableMarker?: boolean;
}

/**
 * Why a model is currently marked non-callable. `unavailable` means the model
 * itself is gone or the subscription lacks it; `quota-exhausted` means access
 * is valid but the plan or API balance ran out and may recover after a top-up
 * or quota reset, so it expires on a shorter marker lifetime. `rate-limited` is
 * transient throttling, and `transport-unstable` is an upstream connection fault -
 * both supplier evidence, which is charged to routing eligibility only and never to
 * the model's reliability record (defects #15 and #31).
 */
export type AvailabilityMarkerKind =
  | "unavailable"
  | "quota-exhausted"
  | "rate-limited"
  | "transport-unstable";

/** Runtime-observed evidence that a model listed by the host can no longer be called. */
export interface ModelAvailabilityObservation {
  callable: false;
  kind?: AvailabilityMarkerKind;
  observedAt: string;
  /** Explicit UTC expiry; when present it overrides the default marker TTL. */
  expiresAt?: string;
  reason: string;
  source: "runtime-failure";
}

/** Current per-model runtime status snapshot, persisted in the shared assessment. */
export interface ModelStatusObservation {
  state: "available" | "quota-exhausted" | "unavailable" | "rate-limited" | "transport-unstable";
  observedAt: string;
  reason?: string;
}

export interface RoleDefinition {
  role: ExpertRole;
  description: string;
  readOnly: boolean;
  tools: string[];
  skills: string[];
  weights: Partial<Record<CapabilityDimension | "costEfficiency", number>>;
  minimumToolReliability?: number;
  minimumContextWindow?: number;
  requiresMutation?: boolean;
}

export interface RoutingConstraints {
  maxExperts?: number;
  costPolicy?: CostPolicy;
  minimumContextWindow?: number;
  allowEscalationOnly?: boolean;
  runtimeCapabilities?: RuntimeCapabilities;
  modelOverrides?: Record<string, ModelProfile>;
  billingOverrides?: Record<string, BillingPolicyEntry>;
  /** Active runtime availability markers; marked models fail the routing hard constraints. */
  modelAvailability?: Record<string, ModelAvailabilityObservation>;
  /** Provider-level routing exclusions (token-cap breach or concurrency limit), provider -> human reason. */
  providerExclusions?: Record<string, string>;
}

export interface ModelAssessmentSnapshot {
  asOf: string;
  sources: string[];
  models: Record<string, CapabilityProfile>;
  /** Main Agent assessment of the actual access method; omit providers that cannot be verified. */
  billing?: Record<string, BillingPolicyEntry>;
  summary?: string;
  /** Runtime-learned callability markers recorded after the audit; conservative local evidence with a bounded lifetime. */
  modelAvailability?: Record<string, ModelAvailabilityObservation>;
  /** Current per-model runtime status (available, quota-exhausted, or unavailable), updated on every observed outcome. */
  modelStatus?: Record<string, ModelStatusObservation>;
}

export interface ModelAssessmentStatus {
  status: "current" | "required";
  reason: "current" | "missing" | "stale" | "future-dated" | "inventory-changed";
  inventoryFingerprint: string;
  requiredModels: string[];
  researchModels: string[];
  missingModels: string[];
  unavailableAssessedModels: string[];
  maxAgeDays: number;
  assessedAt?: string;
  refreshAfter?: string;
  futureSkewMinutes?: number;
  allowedFutureSkewMinutes?: number;
  instructions?: string[];
}

export interface BuildCouncilRequest {
  task: string;
  constraints?: RoutingConstraints;
  /** Optional Main Agent capability audit. The latest supplied snapshot is reused durably. */
  modelAssessment?: ModelAssessmentSnapshot;
  /** Session key selecting which persisted route-policy session entry applies; defaults to "default". */
  sessionKey?: string;
  /** Explicit saved composition name; wins over the session binding. */
  composition?: string;
}

export interface RankedCandidate {
  model: string;
  provider: string;
  family?: string;
  score: number;
  reasons: string[];
  rejected?: string[];
  reasoningLevel?: string;
}

export interface CouncilMember {
  role: ExpertRole;
  model: string;
  provider: string;
  family?: string;
  score: number;
  reason: string[];
  alternatives: RankedCandidate[];
  tools: string[];
  skills: string[];
  readOnly: boolean;
  reasoningLevel?: string;
}

export interface CouncilPlan {
  id: string;
  taskClass: TaskClass;
  task: string;
  experts: CouncilMember[];
  createdAt: string;
  warnings: string[];
  costPolicy?: CostPolicy;
  inventoryFingerprint?: string;
  /** Name of the saved composition that constrained this build, when one resolved. */
  composition?: string;
  /** Saved-composition choices offered when neither a composition nor a costPolicy was supplied. */
  compositionMenu?: CompositionMenuEntry[];
}

export interface DelegationRequest {
  task: string;
  taskDescription?: string;
  role: ExpertRole;
  councilId?: string;
  workspace?: string;
  /** Explicit expert execution deadline in milliseconds (1_000–3_600_000). */
  timeoutMs: number;
  constraints?: RoutingConstraints;
  /**
   * Required reasoning level for the expert session (e.g. low/medium/high).
   * A composition entry that pins a level for the selected model overrides it.
   */
  reasoningLevel?: string;
  /** Session key selecting which persisted route-policy session entry applies; defaults to "default". */
  sessionKey?: string;
  /**
   * Optional `provider/id` pin. The model must exist in the discovered
   * inventory, be inside the role's composition pool when one resolves, and
   * pass route-policy plus cap/concurrency exclusions. Used to dispatch
   * several same-role experts concurrently, one per model.
   */
  model?: string;
}

export interface DelegationHandle {
  executionId: string;
  result: Promise<ExpertResult>;
}

export interface ExpertResultLookup {
  executionId: string;
  status: "running" | "completed" | "not-found";
  result?: ExpertResult;
}

export type ExpertWaitMode = "any" | "all";

export interface ExpertWaitRequest {
  executionIds: string[];
  mode?: ExpertWaitMode;
  timeoutMs: number;
}

export interface ExpertWaitResult {
  status: "completed" | "timed-out" | "not-found";
  mode: ExpertWaitMode;
  completed: string[];
  running: string[];
  notFound: string[];
  waitedMs: number;
}

export interface EscalationRequest {
  role: ExpertRole;
  task: string;
  currentModel: string;
  previousFailures: Array<{ model: string; type: FailureType; summary: string }>;
  constraints?: RoutingConstraints;
}

export interface EscalationDecision {
  action: "retry" | "escalate" | "stop";
  model?: string;
  reason: string;
  correctedInstruction?: string;
}

export interface ExpertOutcome {
  executionId?: string;
  timestamp: string;
  model: string;
  provider: string;
  role: ExpertRole;
  taskCategory: TaskClass;
  success: boolean;
  firstPass: boolean;
  toolErrors: number;
  retryCount: number;
  timedOut: boolean;
  /** True when the Main Agent deliberately aborted the execution. */
  aborted?: boolean;
  verificationPassed?: boolean;
  escalationCount: number;
  attempts: number;
  /** Decision/tool-approval interactions raised during the execution, for routing telemetry. */
  interactionRounds?: number;
  /**
   * Observed failing tool calls, counted by the runtime. Historically this carried
   * 0 or 1 (whether the whole attempt was classified as a tool-call error), which
   * silently starved the tool-error term of `observedAdjustment`.
   */
  toolErrorsObserved?: number;
  /** Terminal failure type, recorded so infrastructure faults can be excluded from model learning. */
  failureType?: FailureType;
  /** Observed tool calls, i.e. the denominator for `toolErrors`. */
  toolCalls?: number;
  /** Which stall warnings fired during this execution, deduped and without detail text. */
  attentionCodes?: string[];
  hostType: string;
  approximateUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    estimatedCost?: number;
  };
}

export interface ExpertFeedbackRequest {
  executionId: string;
  verificationPassed: boolean;
}

export interface ExpertFeedbackResult {
  executionId: string;
  status: "recorded" | "running" | "not-found";
  verificationPassed?: boolean;
  message?: string;
}

export interface TelemetryAggregate {
  model: string;
  provider: string;
  role: ExpertRole;
  samples: number;
  successRate: number;
  firstPassSuccessRate: number;
  toolErrorRate: number;
  retryRate: number;
  verificationPassRate?: number;
  averageAttempts: number;
}

export interface TelemetryStore {
  record(outcome: ExpertOutcome): Promise<void>;
  list(): Promise<ExpertOutcome[]>;
  aggregate(): Promise<TelemetryAggregate[]>;
}

export interface ResourceInventory {
  models: AvailableModel[];
  skills: SkillInfo[];
  billing: Record<string, BillingPolicyEntry>;
  billingSources?: Record<string, Omit<RuntimeBillingDiscovery, "policy"> & { source: RuntimeBillingDiscovery["source"] | "model-assessment" | "user-config" }>;
  roles: RoleDefinition[];
  runtimeCapabilities: RuntimeCapabilities;
  modelAssessment?: ModelAssessmentSnapshot;
  modelAssessmentStatus?: ModelAssessmentStatus;
  routePolicy: ResourceRoutePolicyView;
  /** Saved council compositions and the session binding; omitted when the feature is unwired. */
  compositions?: ResourceCompositionsView;
  /** Operator configuration file location and the effective provisioning mode; helps hosts edit the file on request. */
  operatorConfig?: {
    path?: string;
    provisioningMode: string;
    /** Effective progress-visibility settings, so a host can see what the toggle actually does. */
    observability?: { expertWindow: string; streamToHost: boolean; redactToolArgs: boolean };
    /** Effective struggle-detection thresholds, so a host can tell whether warnings/nudges are live. */
    guardrails?: { warnHost: boolean; nudgeExpert: boolean; consecutiveToolFailures: number; maxTotalWallMs?: number };
  };
  /** Per-provider caps, weighted usage, and in-flight counts; omitted when caps are unwired. */
  providerLimits?: ProviderLimitsView[];
  warnings: string[];
}

/**
 * Session-scoped model route policy. Entries are `provider/id` for exact
 * models or a bare `provider` for every model of that provider. With an
 * allow list, only listed models are eligible (minus deny); with only a
 * deny list, every model except the denied ones is eligible.
 */
export interface RoutePolicy {
  allow?: string[];
  deny?: string[];
}

/** One persisted route-policy entry: system-level or per-session. */
export interface RoutePolicyEntry {
  allow?: string[];
  deny?: string[];
  updatedAt?: string;
  note?: string;
  /** Informational workspace hint so humans can prune stale session entries. */
  workspace?: string;
}

/** Optional per-provider daily/weekly token caps and concurrency limit. */
export interface ProviderLimitsEntry {
  /** Maximum simultaneous running executions for the provider; 0 means unlimited. */
  maxConcurrency?: number;
  /** Weighted tokens allowed per UTC calendar day. */
  dailyTokenCap?: number;
  /** Weighted tokens allowed per ISO week (Monday start, UTC). */
  weeklyTokenCap?: number;
}

/** Effective per-provider limits with defaults applied. */
export interface ProviderLimits {
  maxConcurrency: number;
  dailyTokenCap: number;
  weeklyTokenCap: number;
}

/** Minimal document shape accepted by readProviderLimits; route-policy.json is a superset. */
export interface ProviderLimitsDocument {
  providers?: Record<string, ProviderLimitsEntry>;
}

/** Host-facing per-provider limit and usage snapshot. */
export interface ProviderLimitsView {
  provider: string;
  maxConcurrency: number;
  dailyTokenCap: number;
  weeklyTokenCap: number;
  /** Weighted tokens consumed during the current UTC day. */
  usedToday: number;
  /** Weighted tokens consumed during the current ISO week. */
  usedWeek: number;
  remainingDaily: number;
  remainingWeekly: number;
  /** Running executions currently assigned to this provider. */
  inFlight: number;
}

/** Persisted route-policy document (route-policy.json). */
export interface RoutePolicyDocument {
  version: 1;
  system?: RoutePolicyEntry;
  sessions?: Record<string, RoutePolicyEntry>;
  /** Per-provider token caps and concurrency limits; user configuration, never pruned. */
  providers?: Record<string, ProviderLimitsEntry>;
}

/** One UTC day or ISO-week usage bucket for a provider. */
export interface UsageLedgerBucket {
  key: string;
  tokens: number;
}

/** Weighted token usage for a provider at day and week granularity. */
export interface UsageLedgerProvider {
  day: UsageLedgerBucket;
  week: UsageLedgerBucket;
}

/** Persisted weighted token usage ledger (usage-ledger.json). */
export interface UsageLedger {
  providers: Record<string, UsageLedgerProvider>;
  updatedAt: string;
}

/** Host-facing route-policy view returned by inspectResources. */
export interface ResourceRoutePolicyView {
  sessionKey: string;
  effective: RoutePolicy;
  system?: RoutePolicyEntry;
  session?: RoutePolicyEntry;
  sourcePath?: string;
}

/** One pool entry: a model key plus an optional per-entry reasoning level. */
export interface CompositionPoolEntry {
  model: string;
  /** Reasoning level applied when this model is dispatched for the role; omit to require the host's explicit level. */
  reasoningLevel?: string;
}

/** One saved council composition: a named roster mapping roles to model pools. */
export interface Composition {
  name: string;
  /** Only roles with at least one entry are present; a missing/empty role auto-routes. */
  roles: Partial<Record<ExpertRole, CompositionPoolEntry[]>>;
}

/** Persisted session -> composition binding entry. */
export interface CompositionSessionBinding {
  name: string;
  /** ISO timestamp of the last bind; absent for hand-written entries, which are never pruned. */
  updatedAt?: string;
}

/** Persisted user-defined council compositions (council-compositions.json). */
export interface CompositionDocument {
  version: 1;
  /** Saved rosters in menu-priority order. */
  compositions: Composition[];
  /** Session key (host conversation id) -> saved composition name. */
  sessions?: Record<string, CompositionSessionBinding>;
}

/** Per-role candidate pools resolved from a composition; an empty array means auto-route. */
export type CompositionPools = Record<ExpertRole, string[]>;
/** Per-role model -> reasoning-level mapping from a composition; entries without a level are absent. */
export type CompositionReasoningLevels = Partial<Record<ExpertRole, Record<string, string>>>;

/** One entry of the first-build composition menu: a saved composition or the auto option. */
export interface CompositionMenuEntry {
  name: string;
  /** Role -> model count for a saved composition; omitted for the auto option. */
  rolesSummary?: Record<string, number>;
  /** Present only on the auto option. */
  description?: string;
}

/** Host-facing compositions view returned by inspectResources. */
export interface ResourceCompositionsView {
  compositionsPath?: string;
  compositions: Array<{ name: string; rolesSummary: Record<string, number> }>;
  /** Name of the composition currently bound to the inspected session, if any. */
  sessionBinding?: string;
}

export interface CouncilStatus {
  plans: Array<{ id: string; taskClass: TaskClass; expertCount: number; createdAt: string }>;
  executions: ExecutionStateSnapshot[];
  telemetry: TelemetryAggregate[];
  modelAssessment?: ModelAssessmentSnapshot;
}

/** Requested shape of a getStatus call; "full" preserves the legacy payload. */
export type CouncilStatusView = "full" | "summary" | "running";

/** Result type mapped from the requested status view; "full" (default) is the legacy payload. */
export type CouncilStatusViewResult<V extends CouncilStatusView> =
  V extends "summary" ? CouncilStatusSummary
    : V extends "running" ? { running: RunningExecutionView[] }
      : CouncilStatus;

/** One running execution in the bounded status views. */
export interface RunningExecutionView {
  id: string;
  role: ExpertRole;
  status: "running";
  model?: string;
  /** Milliseconds elapsed since the execution started. */
  elapsedMs: number;
  /** Remaining budget before the current attempt's timeoutMs, when known. */
  remainingMs?: number;
  /** A live interaction the expert is blocked on, when one is open. */
  pendingInteraction?: PendingInteraction;
  /**
   * Non-blocking struggle warnings. Surfaced regardless of the observability toggle:
   * "this expert appears stuck" is a correctness-adjacent signal the host needs in
   * order to decide whether to intervene, not a cosmetic progress stream.
   */
  attention?: ExpertAttention[];
  /** Bounded live progress, surfaced only when security.observability.expertWindow is not "off". */
  progress?: {
    messageCount: number;
    lastActivity?: string;
    toolCalls?: number;
    toolErrors?: number;
    budgetFractionUsed?: number;
  };
}

/** One finished execution in the summary status view. */
export interface CompletedExecutionView {
  id: string;
  role: ExpertRole;
  status: ExecutionStateSnapshot["status"];
  model?: string;
  finishedAt?: string;
}

/** Live provider concurrency slot usage in the summary status view. */
export interface ProviderSlotView {
  provider: string;
  inFlight: number;
  maxConcurrency: number;
  remaining: number;
}

/** Bounded getStatus summary: running work, recent completions, provider slots. */
export interface CouncilStatusSummary {
  running: RunningExecutionView[];
  recentCompleted: CompletedExecutionView[];
  providerSlots: ProviderSlotView[];
}

export interface ExecutionStateSnapshot {
  id: string;
  role: ExpertRole;
  status: "running" | "success" | "partial" | "failed" | "aborted";
  model?: string;
  attempts: number;
  /** Per-attempt execution budget in effect for the latest attempt (1_000–3_600_000). */
  timeoutMs?: number;
  /** Set when the Main Agent requested an abort; the delegation loop skips the next attempt. */
  abortRequested?: boolean;
  abortReason?: string;
  attemptHistory?: ExecutionAttemptSnapshot[];
  taskCategory?: TaskClass;
  startedAt: string;
  finishedAt?: string;
}

export interface ExecutionAttemptSnapshot {
  attempt: number;
  model: string;
  status: "running" | "success" | "partial" | "failed" | "aborted";
  startedAt: string;
  finishedAt?: string;
  failureType?: FailureType;
  /** Bounded diagnostic summary. Successful expert feedback remains in expert_result. */
  summary?: string;
}

export interface CouncilStateSnapshot {
  version: 1;
  plans: CouncilPlan[];
  executions: ExecutionStateSnapshot[];
  results: Array<{ executionId: string; result: ExpertResult }>;
  modelAssessment?: ModelAssessmentSnapshot;
}

export interface CouncilStatePersistence {
  save(snapshot: CouncilStateSnapshot, options?: { replaceModelAssessment?: boolean }): Promise<void>;
  /**
   * Durable read-modify-write against the latest shared model assessment. Unlike
   * `save`, this re-reads the stored snapshot before mutating so concurrent
   * Pi/Codex service instances never overwrite each other's newer assessment.
   */
  updateModelAssessment?(update: (
    current: ModelAssessmentSnapshot | undefined,
  ) => ModelAssessmentSnapshot | undefined): Promise<void>;
  /**
   * Read the latest shared model assessment from durable storage so a service
   * instance observes availability markers written by another running instance
   * without waiting for a host restart.
   */
  readModelAssessment?(): Promise<ModelAssessmentSnapshot | undefined>;
}

export interface CouncilStateOptions {
  initialState?: CouncilStateSnapshot;
  persistence?: CouncilStatePersistence;
  /** Load the persisted route-policy document; implementers should reload when the file changes. */
  readRoutePolicy?: () => Promise<RoutePolicyDocument | undefined>;
  /** Display path of route-policy.json surfaced to hosts through inspectResources. */
  routePolicyPath?: string;
  /** Load the persisted council-compositions document; absent disables the compositions feature. */
  readCompositions?: () => Promise<CompositionDocument | undefined>;
  /** Display path of council-compositions.json surfaced to hosts through inspectResources. */
  compositionsPath?: string;
  /** Display path of the operator council-config.json surfaced to hosts through inspectResources. */
  operatorConfigPath?: string;
  /**
   * Persist session -> composition bindings. Absent disables binding; builds and
   * delegations still honor the document's existing sessions map.
   */
  compositionsStore?: {
    bind(sessionKey: string, name: string, now: Date): Promise<void>;
    unbind(sessionKey: string, now: Date): Promise<void>;
  };
  /** Load per-provider token caps; absent disables cap enforcement. */
  readProviderLimits?: () => Promise<ProviderLimitsDocument | undefined>;
  /**
   * Persisted weighted token usage ledger. When absent, cap accounting and
   * concurrency limits are disabled and Core performs no I/O.
   */
  usageLedger?: {
    load(): Promise<UsageLedger>;
    record(provider: string, tokens: number, now: Date): Promise<UsageLedger>;
  };
}

export interface ExpertCouncil {
  inspectResources(options?: { sessionKey?: string }): Promise<ResourceInventory>;
  buildCouncil(request: BuildCouncilRequest): Promise<CouncilPlan>;
  startDelegation(request: DelegationRequest): DelegationHandle;
  delegate(request: DelegationRequest): Promise<ExpertResult>;
  getResult(executionId: string): Promise<ExpertResultLookup>;
  /** Bounded progress snapshot of a running expert execution; the material for verification or handoff. */
  inspectExecution(executionId: string): Promise<ExecutionProgress | undefined>;
  /**
   * Resolve a running expert's pending interaction (decision point or tool
   * approval) so its blocked turn continues in the same session. Headless hosts
   * discover the open interaction by polling `getStatus({view:"running"})` or
   * `inspectExecution` and answer through this method.
   */
  respondToInteraction(request: RespondToInteractionRequest): Promise<RespondToInteractionResult>;
  /** Deliberately stop a running expert execution while preserving its progress; never retried or escalated. */
  abortExecution(request: AbortExecutionRequest): Promise<AbortExecutionResult>;
  /**
   * Host-session teardown path: abort every running execution AND persist the
   * terminal aborted results before returning, so the state file never keeps a
   * running record for an expert whose host died. Returns the number of
   * executions stopped. Optional: hosts without teardown hooks never call it.
   */
  shutdownAll?(reason: string): Promise<number>;
  waitForResults(request: ExpertWaitRequest): Promise<ExpertWaitResult>;
  cleanup(executionId: string): Promise<ExpertCleanupResult>;
  recordFeedback(request: ExpertFeedbackRequest): Promise<ExpertFeedbackResult>;
  escalate(request: EscalationRequest): Promise<EscalationDecision>;
  getStatus<V extends CouncilStatusView = "full">(options?: { view?: V }): Promise<CouncilStatusViewResult<V>>;
  recordOutcome(outcome: ExpertOutcome): Promise<void>;
  /** Clear runtime availability markers by scope: "*", a bare provider, or an exact "provider/id" key. */
  resetAvailability(request: ResetAvailabilityRequest): Promise<ResetAvailabilityResult>;
  /** Bounded verification command passthrough to the runtime; always resolves. */
  verifyCommand(request: VerifyCommandRequest): Promise<VerifyCommandResult>;
}
