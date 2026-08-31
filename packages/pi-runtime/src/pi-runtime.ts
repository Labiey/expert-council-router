import { readFile } from "node:fs/promises";
import {
  normalizePiModels,
  getRole,
  type AvailableModel,
  type CouncilConfig,
  type ExpertExecutionRequest,
  type ExpertResult,
  type ExpertRuntime,
  type FailureType,
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
  sdk?: PiSdkLike;
  modelRuntime?: PiModelRuntimeLike;
  packageName?: string;
}

class ExecutionTimeoutError extends Error {}

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

function failureFromError(error: unknown): FailureType {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (error instanceof ExecutionTimeoutError || message.includes("timeout")) return "timeout";
  if (message.includes("permission") || message.includes("workspace") || message.includes("worktree")) return "permission_error";
  if (
    message.includes("provider") ||
    message.includes("api key") ||
    message.includes("rate limit") ||
    message.includes("model registry") ||
    message.includes("not currently available") ||
    message.includes("model unavailable")
  ) return "provider_error";
  if (message.includes("tool")) return "tool_call_error";
  return "unknown";
}

function normalizeResult(
  parsed: Record<string, unknown> | undefined,
  request: ExpertExecutionRequest,
  rawText: string,
  changedFiles: string[],
  workspace: PreparedWorkspace,
): ExpertResult {
  const status = parsed?.status === "success" || parsed?.status === "partial" || parsed?.status === "failed" ? parsed.status : "partial";
  const tests = Array.isArray(parsed?.tests)
    ? parsed.tests.flatMap((test) => {
        if (!test || typeof test !== "object") return [];
        const item = test as Record<string, unknown>;
        if (item.status !== "passed" && item.status !== "failed" && item.status !== "not-run") return [];
        const testStatus = item.status as "passed" | "failed" | "not-run";
        return [{
          ...(typeof item.command === "string" ? { command: item.command } : {}),
          status: testStatus,
          ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
        }];
      })
    : undefined;
  const stringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : undefined;

  return {
    status,
    role: request.role,
    model: request.model,
    summary:
      typeof parsed?.summary === "string"
        ? parsed.summary.slice(0, 4_000)
        : rawText.slice(0, 4_000) || "Expert completed without a textual summary.",
    ...(changedFiles.length ? { filesChanged: changedFiles } : {}),
    ...(tests?.length ? { tests } : {}),
    ...(stringArray(parsed?.findings)?.length ? { findings: stringArray(parsed?.findings) } : {}),
    ...(stringArray(parsed?.risks)?.length ? { risks: stringArray(parsed?.risks) } : {}),
    ...(typeof parsed?.recommendedNextAction === "string"
      ? { recommendedNextAction: parsed.recommendedNextAction.slice(0, 1_000) }
      : {}),
    executionMetadata: {
      attempts: request.attempt,
      workspace: workspace.root,
      isolated: workspace.isolated,
    },
  };
}

async function rolePrompt(role: string): Promise<string> {
  if (process.env.EXPERT_COUNCIL_ROLE_DIR) {
    return readFile(`${process.env.EXPERT_COUNCIL_ROLE_DIR}/${role}.md`, "utf8");
  }
  return readFile(new URL(`./roles/${role}.md`, import.meta.url), "utf8");
}

function executionPrompt(request: ExpertExecutionRequest, roleInstructions: string): string {
  return `${roleInstructions}\n\n## Bounded assignment\n${request.task}\n\n## Execution constraints\n- Do not delegate to another agent.\n- Use only the provided tools and workspace.\n- Never modify an existing file before inspecting the relevant content.\n- Prefer targeted edits over rewriting whole files.\n- Verify paths rather than guessing.\n- Diagnose a failed tool call before retrying with a changed approach.\n- Use finite, non-interactive test commands.\n- Do not reveal or request chain-of-thought.\n${request.priorFailure ? `- Previous failure: ${request.priorFailure.type}: ${request.priorFailure.summary}\n` : ""}\nReturn only one compact JSON object with: status, summary, filesChanged, tests, findings, risks, recommendedNextAction. Test entries use status passed, failed, or not-run.`;
}

export class PiExpertRuntime implements ExpertRuntime {
  private readonly boundary: WorkspaceBoundary;

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

  async listSkills(): Promise<SkillInfo[]> {
    if (!this.sdk.DefaultResourceLoader) return [];
    try {
      const loader = new this.sdk.DefaultResourceLoader({
        cwd: this.options.cwd,
        ...(this.sdk.getAgentDir ? { agentDir: this.sdk.getAgentDir() } : {}),
      });
      await loader.reload();
      return loader.getSkills().skills.flatMap((skill) =>
        typeof skill.name === "string"
          ? [{
              name: skill.name,
              ...(typeof skill.description === "string" ? { description: skill.description } : {}),
              installed: true,
              enabled: skill.disableModelInvocation !== true,
              source: typeof skill.filePath === "string" ? skill.filePath : "pi",
            }]
          : [],
      );
    } catch {
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
      supportedTools: process.platform === "win32"
        ? ["read", "grep", "find", "ls", "edit", "write", "powershell"]
        : ["read", "grep", "find", "ls", "edit", "write", "bash"],
      limitations: [
        "Reasoning levels are clamped to values exposed by the selected Pi session.",
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
      const mutationTools = new Set(["edit", "write"]);
      const tools = request.tools.filter(
        (tool) => capabilities.supportedTools.includes(tool) && (!effectiveReadOnly || !mutationTools.has(tool)),
      );
      let resourceLoader: unknown;
      if (this.sdk.DefaultResourceLoader && request.skills.length) {
        resourceLoader = new this.sdk.DefaultResourceLoader({
          cwd: workspace.cwd,
          ...(this.sdk.getAgentDir ? { agentDir: this.sdk.getAgentDir() } : {}),
          skillsOverride: (current: { skills: Array<Record<string, unknown>>; diagnostics: unknown[] }) => ({
            skills: current.skills.filter((skill) => typeof skill.name === "string" && request.skills.includes(skill.name)),
            diagnostics: current.diagnostics,
          }),
        });
        await (resourceLoader as { reload(): Promise<void> }).reload();
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
      const prompt = executionPrompt(request, await rolePrompt(request.role));
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
      const result = normalizeResult(extractJson(rawText), request, rawText, changedFiles, workspace);
      result.executionMetadata = { ...result.executionMetadata, durationMs: Date.now() - started };
      return result;
    } catch (error) {
      return {
        status: "failed",
        role: request.role,
        model: request.model,
        summary: error instanceof Error ? error.message : String(error),
        executionMetadata: {
          attempts: request.attempt,
          failureType: failureFromError(error),
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
