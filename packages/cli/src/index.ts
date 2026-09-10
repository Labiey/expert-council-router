import type { CostPolicy, ExpertCouncil, ExpertRole } from "@expert-council/core";
import { createExpertCouncil } from "@expert-council/pi-runtime";

export interface CliIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

const ROLES = new Set<ExpertRole>([
  "planner",
  "scout",
  "architecture-oracle",
  "implementation-worker",
  "debugger",
  "reviewer",
  "verifier",
]);
const COST_POLICIES = new Set<CostPolicy>(["economy", "balanced", "speed", "quality"]);

function bounded(value: string, label: string, maximum: number): string {
  if (!value || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be non-empty, at most ${maximum} characters, and contain no NUL bytes`);
  }
  return value;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function integerOption(args: string[], name: string, minimum: number, maximum: number): number | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--")) {
      if (!["--json", "--help"].includes(args[index]!)) index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}

function help(): string {
  return `Expert Council CLI\n\nUsage:\n  expert-council models [--json]\n  expert-council inspect [--json]\n  expert-council compositions [--session-key KEY] [--json]\n  expert-council build <task> [--max-experts N] [--cost-policy POLICY] [--composition NAME] [--json]\n  expert-council delegate <role> <task> [--workspace PATH] [--timeout-ms N] [--reasoning-level LEVEL] [--model PROVIDER/ID] [--json]\n  expert-council feedback <execution-id> --verification passed|failed [--json]\n  expert-council cleanup <execution-id> [--json]
  expert-council abort <execution-id> [--reason TEXT] [--json]\n  expert-council status [--view full|summary|running] [--json]\n  expert-council reset <scope> [--json]        scope: '*', a provider, or provider/id\n  expert-council verify (--exec ID | --workspace PATH) --command JSON_ARRAY [--timeout-ms N] [--json]\n\nGlobal options:\n  --config PATH       JSON configuration file\n  --cwd PATH          project workspace\n  --telemetry PATH    local JSONL outcome store\n  --state PATH        durable council state file\n  --cost-policy NAME  economy, balanced, speed, or legacy quality\n  --composition NAME  saved council composition from council-compositions.json\n  --model KEY         pin one provider/id model for a delegation\n`;
}

function human(command: string, value: unknown): string {
  if (command === "models" && Array.isArray(value)) {
    return `${value.map((model) => {
      const item = model as { provider: string; id: string; contextWindow?: number };
      return `${item.provider}/${item.id}${item.contextWindow ? ` (${item.contextWindow} ctx)` : ""}`;
    }).join("\n")}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function runCli(
  args: string[],
  io: CliIo = process,
  council?: ExpertCouncil,
): Promise<number> {
  const command = args[0];
  if (!command || command === "help" || args.includes("--help")) {
    io.stdout.write(help());
    return 0;
  }
  try {
    const service = council ?? (await createExpertCouncil({
      cwd: option(args, "--cwd"),
      configPath: option(args, "--config"),
      telemetryPath: option(args, "--telemetry"),
      statePath: option(args, "--state"),
    }));
    const values = positional(args.slice(1));
    let result: unknown;
    switch (command) {
      case "models":
        result = (await service.inspectResources({ sessionKey: option(args, "--session-key") ?? undefined })).models;
        break;
      case "inspect":
        result = await service.inspectResources({ sessionKey: option(args, "--session-key") ?? undefined });
        break;
      case "compositions": {
        const inventory = await service.inspectResources({ sessionKey: option(args, "--session-key") ?? undefined });
        result = inventory.compositions ?? {
          compositions: [],
          note: "Council compositions are not wired in this build.",
        };
        break;
      }
      case "build": {
        const task = bounded(values.join(" ").trim(), "build task", 100_000);
        const maxExperts = integerOption(args, "--max-experts", 1, 8);
        const costPolicyText = option(args, "--cost-policy");
        if (costPolicyText && !COST_POLICIES.has(costPolicyText as CostPolicy)) {
          throw new Error(`--cost-policy must be one of: ${[...COST_POLICIES].join(", ")}`);
        }
        const costPolicy = costPolicyText as CostPolicy | undefined;
        const compositionText = option(args, "--composition");
        result = await service.buildCouncil({
          task,
          sessionKey: option(args, "--session-key") ?? undefined,
          ...(compositionText ? { composition: bounded(compositionText, "composition", 80) } : {}),
          ...(maxExperts !== undefined || costPolicy ? {
            constraints: {
              ...(maxExperts !== undefined ? { maxExperts } : {}),
              ...(costPolicy ? { costPolicy } : {}),
            },
          } : {}),
        });
        break;
      }
      case "delegate": {
        const role = values[0] as ExpertRole | undefined;
        if (!role || !ROLES.has(role)) throw new Error(`delegate requires a valid semantic role: ${[...ROLES].join(", ")}`);
        const task = bounded(values.slice(1).join(" ").trim(), "delegate task", 100_000);
        const timeoutMs = integerOption(args, "--timeout-ms", 1_000, 3_600_000);
        if (timeoutMs === undefined) {
          throw new Error("delegate requires --timeout-ms <ms> (1000–3600000): set an explicit budget from task difficulty");
        }
        const reasoningLevel = bounded(option(args, "--reasoning-level") ?? "", "reasoning level", 40);
        if (!reasoningLevel) {
          throw new Error("delegate requires --reasoning-level <level> (e.g. low/medium/high): choose it from the task and model");
        }
        const modelText = option(args, "--model");
        if (modelText && !/^[^/]+\/[^/]+$/.test(modelText)) {
          throw new Error("--model must be a provider/id model key");
        }
        result = await service.delegate({
          role,
          task,
          sessionKey: option(args, "--session-key") ?? undefined,
          ...(option(args, "--workspace") ? { workspace: bounded(option(args, "--workspace")!, "workspace", 32_768) } : {}),
          ...(modelText ? { model: bounded(modelText, "model", 200) } : {}),
          reasoningLevel,
          timeoutMs,
        });
        break;
      }
      case "status": {
        const view = option(args, "--view") ?? "full";
        if (view !== "full" && view !== "summary" && view !== "running") {
          throw new Error("status --view must be full, summary, or running");
        }
        result = await service.getStatus({ view: view as "full" | "summary" | "running" });
        break;
      }
      case "reset": {
        const scope = values[0];
        if (!scope) throw new Error("reset requires a scope: '*', a provider, or provider/id");
        result = await service.resetAvailability({ scope: bounded(scope, "scope", 200) });
        break;
      }
      case "verify": {
        const execId = option(args, "--exec");
        const ws = option(args, "--workspace");
        const commandJson = option(args, "--command");
        if (!commandJson) throw new Error("verify requires --command JSON_ARRAY");
        let parsed: unknown;
        try {
          parsed = JSON.parse(commandJson);
        } catch {
          throw new Error("verify --command must be a JSON array of strings");
        }
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 12 || parsed.some((item) => typeof item !== "string")) {
          throw new Error("verify --command must be a JSON array of 1-12 strings");
        }
        const verifyTimeout = integerOption(args, "--timeout-ms", 1_000, 600_000);
        result = await service.verifyCommand({
          ...(execId ? { executionId: bounded(execId, "exec", 200) } : {}),
          ...(ws ? { workspace: ws } : {}),
          command: parsed as string[],
          ...(verifyTimeout ? { timeoutMs: verifyTimeout } : {}),
        });
        break;
      }
      case "feedback": {
        const executionId = values[0];
        if (!executionId || !/^[a-zA-Z0-9_-]{1,200}$/.test(executionId)) throw new Error("feedback requires a valid execution ID");
        const verification = option(args, "--verification");
        if (verification !== "passed" && verification !== "failed") {
          throw new Error("feedback requires --verification passed|failed");
        }
        result = await service.recordFeedback({ executionId, verificationPassed: verification === "passed" });
        break;
      }
      case "cleanup": {
        const executionId = values[0];
        if (!executionId || !/^[a-zA-Z0-9_-]{1,200}$/.test(executionId)) throw new Error("cleanup requires a valid execution ID");
        result = await service.cleanup(executionId);
        break;
      }
      case "abort": {
        const executionId = values[0];
        if (!executionId || !/^[a-zA-Z0-9_-]{1,200}$/.test(executionId)) throw new Error("abort requires a valid execution ID");
        const reason = option(args, "--reason");
        result = await service.abortExecution({
          executionId,
          ...(reason ? { reason: bounded(reason, "reason", 1_000) } : {}),
        });
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    io.stdout.write(args.includes("--json") ? `${JSON.stringify(result)}\n` : human(command, result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${args.includes("--json") ? JSON.stringify({ error: message }) : `Error: ${message}`}\n`);
    return 1;
  }
}
