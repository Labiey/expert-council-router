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
  /** Explicit verification argv; when omitted the runtime runs typecheck then tests. */
  verifyCommand?: string[];
  /** Restrict the child environment to a fixed allowlist. */
  scrubEnv: boolean;
  /** Deadline for worktree removal (`git worktree remove`). */
  removalTimeoutMs: number;
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
  supportedTools: string[];
  limitations: string[];
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
    /** Outcome of runtime worktree provisioning for this attempt. */
    provisioning?: {
      status: "ready" | "skipped" | "failed";
      packageManager?: string;
      command?: string;
      durationMs?: number;
      detail?: string;
    };
    /** Runtime verification gate entries (typecheck/test), populated only for provisioned mutation worktrees. */
    verification?: Array<{ command?: string; status: "passed" | "failed" | "not-run"; summary?: string }>;
  };
}

export interface ExpertRuntime {
  listAvailableModels(): Promise<AvailableModel[]>;
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
  cleanupExecution?(executionId: string): Promise<Omit<ExpertCleanupResult, "executionId">>;
}

export interface RuntimeBillingDiscovery {
  policy: BillingPolicyEntry;
  source: "pi-runtime" | "pi-provider-catalog" | "pi-model-catalog" | "unverified";
  reason: string;
}

/** Bounded progress snapshot for a running expert execution. */
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

/** Runtime-observed evidence that a model listed by the host can no longer be called. */
/**
 * Why a model is currently marked non-callable. `unavailable` means the model
 * itself is gone or the subscription lacks it; `quota-exhausted` means access
 * is valid but the plan or API balance ran out and may recover after a top-up
 * or quota reset, so it expires on a shorter marker lifetime.
 */
export type AvailabilityMarkerKind = "unavailable" | "quota-exhausted" | "rate-limited";

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
  state: "available" | "quota-exhausted" | "unavailable" | "rate-limited";
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
  operatorConfig?: { path?: string; provisioningMode: string };
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

export interface ExecutionStateSnapshot {
  id: string;
  role: ExpertRole;
  status: "running" | "success" | "partial" | "failed" | "aborted";
  model?: string;
  attempts: number;
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
  /** Deliberately stop a running expert execution while preserving its progress; never retried or escalated. */
  abortExecution(request: AbortExecutionRequest): Promise<AbortExecutionResult>;
  waitForResults(request: ExpertWaitRequest): Promise<ExpertWaitResult>;
  cleanup(executionId: string): Promise<ExpertCleanupResult>;
  recordFeedback(request: ExpertFeedbackRequest): Promise<ExpertFeedbackResult>;
  escalate(request: EscalationRequest): Promise<EscalationDecision>;
  getStatus(): Promise<CouncilStatus>;
  recordOutcome(outcome: ExpertOutcome): Promise<void>;
}
