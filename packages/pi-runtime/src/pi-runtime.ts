import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  inferFailureType,
  normalizePiModels,
  getRole,
  type AvailableModel,
  type CouncilConfig,
  type ExpertExecutionRequest,
  type ExpertResult,
  type ExpertRuntime,
  type FailureType,
  type RuntimeBillingDiscovery,
  type RuntimeCapabilities,
  type SkillInfo,
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
import { WorkspaceBoundary, type PreparedWorkspace } from "./workspace.js";

export interface PiExpertRuntimeOptions {
  cwd: string;
  config: CouncilConfig;
  roleDirectory?: string;
  sdk?: PiSdkLike;
  modelRuntime?: PiModelRuntimeLike;
  packageName?: string;
}

class ExecutionTimeoutError extends Error {}

export function inferPiProviderBilling(
  provider: string,
  runtimeSubscription = false,
  hasPublishedMeteredPrice = false,
): RuntimeBillingDiscovery {
  if (runtimeSubscription) {
    return {
      policy: { billingType: "subscription", marginalCostClass: "very-low", usagePreference: "consume-first" },
      source: "pi-runtime",
      reason: "Pi reports that the authenticated provider uses subscription access.",
    };
  }
  if (/(?:^|-)token-plan(?:-|$)/i.test(provider)) {
    return {
      policy: { billingType: "subscription", marginalCostClass: "very-low", usagePreference: "consume-first" },
      source: "pi-provider-catalog",
      reason: `Pi provider ${provider} is a named Token Plan access catalog.`,
    };
  }
  if (hasPublishedMeteredPrice) {
    return {
      policy: { billingType: "metered", marginalCostClass: "normal", usagePreference: "quality-sensitive" },
      source: "pi-model-catalog",
      reason: `Pi exposes non-zero per-token catalog prices for provider ${provider} and does not report subscription access.`,
    };
  }
  return {
    policy: { billingType: "unknown", marginalCostClass: "normal", usagePreference: "balanced" },
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

function extractJson(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(
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
): ExpertResult {
  const status = parsed?.status === "success" || parsed?.status === "partial" || parsed?.status === "failed" ? parsed.status : "partial";
  const tests = Array.isArray(parsed?.tests)
    ? parsed.tests.slice(0, 20).flatMap((test) => {
        if (!test || typeof test !== "object") return [];
        const item = test as Record<string, unknown>;
        if (item.status !== "passed" && item.status !== "failed" && item.status !== "not-run") return [];
        const testStatus = item.status as "passed" | "failed" | "not-run";
        return [{
          ...(safeText(item.command, 1_000) ? { command: safeText(item.command, 1_000) } : {}),
          status: testStatus,
          ...(safeText(item.summary, 2_000) ? { summary: safeText(item.summary, 2_000) } : {}),
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
  const summaryFailureType = inferFailureType(
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
      ...(inferredFailureType ? { failureType: inferredFailureType } : {}),
      ...(usage ? { usage } : {}),
    },
  };
}

async function rolePrompt(role: string, roleDirectory?: string): Promise<string> {
  if (roleDirectory) return readFile(path.resolve(roleDirectory, `${role}.md`), "utf8");
  return readFile(new URL(`./roles/${role}.md`, import.meta.url), "utf8");
}

function executionPrompt(request: ExpertExecutionRequest, roleInstructions: string): string {
  return `${roleInstructions}\n\n## Bounded assignment\n${request.task}\n\n## Execution constraints\n- Do not delegate to another agent.\n- Use only the provided tools and workspace.\n- Never modify an existing file before inspecting the relevant content.\n- Prefer targeted edits over rewriting whole files.\n- Verify paths rather than guessing.\n- Diagnose a failed tool call before retrying with a changed approach.\n- Use finite, non-interactive test commands and set an explicit command timeout based on expected difficulty whenever the shell tool supports it.\n- Do not reveal or request chain-of-thought.\n${request.priorFailure ? `- Previous failure: ${request.priorFailure.type}: ${request.priorFailure.summary}\n` : ""}\nReturn only one compact JSON object with: status, summary, failureType, filesChanged, tests, findings, risks, recommendedNextAction. Omit failureType on success; otherwise use one of tool_call_error, reasoning_failure, test_failure, timeout, provider_error, missing_context, permission_error, or unknown. Test entries use status passed, failed, or not-run.`;
}

export class PiExpertRuntime implements ExpertRuntime {
  private readonly boundary: WorkspaceBoundary;
  private skillDiscoveryWarning?: string;

  private constructor(
    private readonly sdk: PiSdkLike,
    private readonly models: PiModelRuntimeLike,
    private readonly options: PiExpertRuntimeOptions,
    private readonly packageName: string,
  ) {
    this.boundary = new WorkspaceBoundary(options.cwd, options.config.security);
  }

  static async create(options: PiExpertRuntimeOptions): Promise<PiExpertRuntime> {
    const loaded = options.sdk ? { sdk: options.sdk, packageName: options.packageName ?? "injected-pi-sdk" } : await loadPiSdk();
    const sdk = validatePiSdk(loaded.sdk, loaded.packageName);
    const modelRuntime = validatePiModelRuntime(
      options.modelRuntime ?? (await sdk.ModelRuntime.create({ allowModelNetwork: false })),
      `${loaded.packageName} ModelRuntime`,
    );
    return new PiExpertRuntime(sdk, modelRuntime, options, loaded.packageName);
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

  async getCapabilities(): Promise<RuntimeCapabilities> {
    const workspace = await this.boundary.mutationCapability();
    return {
      hostType: `pi:${this.packageName}`,
      modelDiscovery: true,
      hardToolRestriction: true,
      skillOverride: Boolean(this.sdk.DefaultResourceLoader),
      subagentBackend: true,
      mutation: workspace.mutation,
      workspaceIsolation: workspace.workspaceIsolation,
      ...(workspace.sourceWorkspaceDirty !== undefined ? { sourceWorkspaceDirty: workspace.sourceWorkspaceDirty } : {}),
      supportedTools: process.platform === "win32"
        ? ["read", "grep", "find", "ls", "edit", "write", "powershell"]
        : ["read", "grep", "find", "ls", "edit", "write", "bash"],
      limitations: [
        "Reasoning levels are clamped to values exposed by the selected Pi session.",
        ...(this.skillDiscoveryWarning ? [this.skillDiscoveryWarning] : []),
        ...workspace.limitations,
        ...(workspace.workspaceIsolation === "git-worktree"
          ? [`Mutation worktrees are retained for review until expert_cleanup is called or the ${this.options.config.security.worktreeRetentionMs}ms retention window expires.`]
          : []),
      ],
    };
  }

  async executeExpert(request: ExpertExecutionRequest): Promise<ExpertResult> {
    const started = Date.now();
    let workspace: PreparedWorkspace | undefined;
    let session: PiSessionLike | undefined;
    try {
      const available = await this.listAvailableModels();
      const [provider, ...idParts] = request.model.split("/");
      const id = idParts.join("/");
      if (!available.some((model) => model.provider === provider && model.id === id)) {
        throw new Error(`Selected model ${request.model} is not currently available.`);
      }
      const nativeModel = this.models.getModel(provider!, id);
      if (!nativeModel) throw new Error(`Pi model registry no longer contains ${request.model}.`);

      const effectiveReadOnly = request.readOnly || getRole(request.role).readOnly;
      workspace = await this.boundary.prepare(request.workspace, effectiveReadOnly, request.executionId ?? `exec-${Date.now()}`);
      const capabilities = await this.getCapabilities();
      const mutationTools = new Set(["edit", "write", "bash", "powershell"]);
      const tools = request.tools.filter(
        (tool) => capabilities.supportedTools.includes(tool) && (!effectiveReadOnly || !mutationTools.has(tool)),
      );
      const resourceLoader = await this.createSafeResourceLoader(workspace.cwd, request.skills);
      if (!resourceLoader) {
        throw new Error("Pi resource isolation is unavailable; refusing to create an expert session.");
      }

      const created = await this.sdk.createAgentSession({
        cwd: workspace.cwd,
        model: nativeModel,
        modelRuntime: this.models,
        tools,
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(this.sdk.SessionManager ? { sessionManager: this.sdk.SessionManager.inMemory(workspace.cwd) } : {}),
      });
      session = validatePiSession(created.session, `${this.packageName} createAgentSession result`);
      if (request.reasoningLevel && session.getAvailableThinkingLevels?.().includes(request.reasoningLevel)) {
        session.setThinkingLevel?.(request.reasoningLevel);
      }
      const prompt = executionPrompt(request, await rolePrompt(request.role, this.options.roleDirectory));
      const timeoutMs = request.timeoutMs ?? 10 * 60_000;
      let timer: NodeJS.Timeout | undefined;
      const execution = (async () => {
        await session!.prompt(prompt);
        await session!.waitForIdle?.();
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const aborting = session?.abort?.();
          void aborting?.catch(() => undefined);
          reject(new ExecutionTimeoutError(`Expert execution timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      });
      try {
        await Promise.race([execution, timeout]);
      } catch (error) {
        if (error instanceof ExecutionTimeoutError) {
          const aborting = session.abort?.();
          void aborting?.catch(() => undefined);
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const rawText = finalAssistantText(session);
      const changedFiles = await this.boundary.changedFiles(workspace);
      const result = normalizeResult(extractJson(rawText), request, rawText, changedFiles, workspace, sessionUsage(session));
      result.executionMetadata = { ...result.executionMetadata, durationMs: Date.now() - started };
      return result;
    } catch (error) {
      return {
        status: "failed",
        role: request.role,
        model: request.model,
        summary: safeText(error instanceof Error ? error.message : String(error), 4_000) ?? "Expert execution failed.",
        executionMetadata: {
          attempts: request.attempt,
          failureType: inferFailureType(error),
          durationMs: Date.now() - started,
          ...(workspace ? { workspace: workspace.root, isolated: workspace.isolated } : {}),
        },
      };
    } finally {
      session?.dispose();
    }
  }

  async cleanupExecution(executionId: string) {
    return this.boundary.cleanupExecution(executionId);
  }
}
