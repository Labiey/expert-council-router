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
export type MarginalCostClass = "very-low" | "low" | "normal" | "high" | "scarce";
export type UsagePreference = "consume-first" | "balanced" | "quality-sensitive" | "escalation-only";
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

export interface RuntimeCapabilities {
  hostType: string;
  modelDiscovery: boolean;
  hardToolRestriction: boolean;
  skillOverride: boolean;
  subagentBackend: boolean;
  mutation: boolean;
  workspaceIsolation: "git-worktree" | "bounded-workspace" | "none";
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
  timeoutMs?: number;
  attempt: number;
  priorFailure?: { type: FailureType; summary: string };
}

export interface TestResult {
  command?: string;
  status: "passed" | "failed" | "not-run";
  summary?: string;
}

export interface ExpertResult {
  status: "success" | "partial" | "failed";
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
  };
}

export interface ExpertRuntime {
  listAvailableModels(): Promise<AvailableModel[]>;
  executeExpert(request: ExpertExecutionRequest): Promise<ExpertResult>;
  listSkills(): Promise<SkillInfo[]>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  cleanupExecution?(executionId: string): Promise<Omit<ExpertCleanupResult, "executionId">>;
}

export interface ExpertCleanupResult {
  executionId: string;
  status: "cleaned" | "not-found" | "not-required" | "failed" | "unsupported";
  workspace?: string;
  message?: string;
}

export interface BillingPolicyEntry {
  billingType: BillingType;
  marginalCostClass?: MarginalCostClass;
  usagePreference?: UsagePreference;
  disabled?: boolean;
}

export interface ModelProfile extends CapabilityProfile {
  disabled?: boolean;
  billingProfile?: string;
  preferredReasoningByRole?: Partial<Record<ExpertRole, string | null>>;
  incompatibleRoles?: ExpertRole[];
}

export interface ResolvedModelProfile extends Partial<Record<CapabilityDimension, number>> {
  disabled?: boolean;
  billingProfile?: string;
  preferredReasoningByRole?: Partial<Record<ExpertRole, string>>;
  incompatibleRoles?: ExpertRole[];
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
  costPolicy?: "economy" | "balanced" | "quality";
  minimumContextWindow?: number;
  allowEscalationOnly?: boolean;
  runtimeCapabilities?: RuntimeCapabilities;
  modelOverrides?: Record<string, ModelProfile>;
}

export interface BuildCouncilRequest {
  task: string;
  constraints?: RoutingConstraints;
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
  inventoryFingerprint?: string;
}

export interface DelegationRequest {
  task: string;
  taskDescription?: string;
  role: ExpertRole;
  councilId?: string;
  workspace?: string;
  timeoutMs?: number;
  constraints?: RoutingConstraints;
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
  roles: RoleDefinition[];
  runtimeCapabilities: RuntimeCapabilities;
  warnings: string[];
}

export interface CouncilStatus {
  plans: Array<{ id: string; taskClass: TaskClass; expertCount: number; createdAt: string }>;
  executions: ExecutionStateSnapshot[];
  telemetry: TelemetryAggregate[];
}

export interface ExecutionStateSnapshot {
  id: string;
  role: ExpertRole;
  status: "running" | "success" | "partial" | "failed";
  model?: string;
  attempts: number;
  taskCategory?: TaskClass;
  startedAt: string;
  finishedAt?: string;
}

export interface CouncilStateSnapshot {
  version: 1;
  plans: CouncilPlan[];
  executions: ExecutionStateSnapshot[];
  results: Array<{ executionId: string; result: ExpertResult }>;
}

export interface CouncilStatePersistence {
  save(snapshot: CouncilStateSnapshot): Promise<void>;
}

export interface CouncilStateOptions {
  initialState?: CouncilStateSnapshot;
  persistence?: CouncilStatePersistence;
}

export interface ExpertCouncil {
  inspectResources(): Promise<ResourceInventory>;
  buildCouncil(request: BuildCouncilRequest): Promise<CouncilPlan>;
  startDelegation(request: DelegationRequest): DelegationHandle;
  delegate(request: DelegationRequest): Promise<ExpertResult>;
  getResult(executionId: string): Promise<ExpertResultLookup>;
  cleanup(executionId: string): Promise<ExpertCleanupResult>;
  recordFeedback(request: ExpertFeedbackRequest): Promise<ExpertFeedbackResult>;
  escalate(request: EscalationRequest): Promise<EscalationDecision>;
  getStatus(): Promise<CouncilStatus>;
  recordOutcome(outcome: ExpertOutcome): Promise<void>;
}
