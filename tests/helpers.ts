import type {
  AbortExecutionRequest,
  AbortExecutionResult,
  AvailableModel,
  ExpertCleanupResult,
  ExpertExecutionRequest,
  ExpertResult,
  ExpertRuntime,
  ExecutionProgress,
  InteractionResponse,
  RespondToInteractionResult,
  RuntimeCapabilities,
  SkillInfo,
} from "../packages/core/src/index.js";

export const capabilities: RuntimeCapabilities = {
  hostType: "mock",
  modelDiscovery: true,
  hardToolRestriction: true,
  skillOverride: true,
  subagentBackend: true,
  realtimeInteraction: true,
  dynamicToolPermissions: true,
  mutation: true,
  workspaceIsolation: "git-worktree",
  supportedTools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
  limitations: [],
};

export function model(provider: string, id: string, overrides: Partial<AvailableModel> = {}): AvailableModel {
  return {
    provider,
    id,
    available: true,
    reasoning: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    ...overrides,
  };
}

export class MockRuntime implements ExpertRuntime {
  readonly requests: ExpertExecutionRequest[] = [];
  readonly capabilityRequests: Array<string | undefined> = [];
  readonly abortCalls: Array<{ executionId: string; reason?: string }> = [];
  readonly interactionCalls: Array<{ executionId: string; response: InteractionResponse }> = [];
  readonly cleanupCalls: string[] = [];
  /** Canned cleanup outcome so tests can exercise the service's status mapping. */
  cleanupOutcome: Omit<ExpertCleanupResult, "executionId"> = { status: "cleaned", removedCount: 1 };

  async cleanupExecution(executionId: string): Promise<Omit<ExpertCleanupResult, "executionId">> {
    this.cleanupCalls.push(executionId);
    return this.cleanupOutcome;
  }
  /** Configurable canned result returned by respondToInteraction; defaults to resolved. */
  respondToResult: RespondToInteractionResult = { executionId: "", status: "resolved", kind: "decision" };

  async abortExecution(request: AbortExecutionRequest): Promise<AbortExecutionResult> {
    this.abortCalls.push({ executionId: request.executionId, ...(request.reason ? { reason: request.reason } : {}) });
    return { executionId: request.executionId, status: "not-found" };
  }

  constructor(
    readonly models: AvailableModel[],
    private readonly results: Array<
      ExpertResult |
      Promise<ExpertResult> |
      ((request: ExpertExecutionRequest) => ExpertResult | Promise<ExpertResult>)
    > = [],
    readonly runtimeCapabilities: RuntimeCapabilities = capabilities,
    readonly skills: SkillInfo[] = [],
  ) {}

  async listAvailableModels() {
    return this.models;
  }

  async executeExpert(request: ExpertExecutionRequest): Promise<ExpertResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (typeof result === "function") return await result(request);
    return await (result ?? {
      status: "success",
      role: request.role,
      model: request.model,
      summary: "ok",
    });
  }

  async listSkills() {
    return this.skills;
  }

  async getCapabilities(cwd?: string) {
    this.capabilityRequests.push(cwd);
    return this.runtimeCapabilities;
  }

  // Explicitly typed as the interface's optional-hook signature so a test can
  // assign a richer progress snapshot to this property without widening it away.
  async inspectExecution(executionId: string): Promise<ExecutionProgress | undefined> {
    return undefined;
  }

  async respondToInteraction(executionId: string, response: InteractionResponse): Promise<RespondToInteractionResult> {
    this.interactionCalls.push({ executionId, response });
    return { ...this.respondToResult, executionId };
  }
}
