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
  return `Expert Council CLI\n\nUsage:\n  expert-council models [--json]\n  expert-council inspect [--json]\n  expert-council build <task> [--max-experts N] [--cost-policy POLICY] [--json]\n  expert-council delegate <role> <task> [--workspace PATH] [--timeout-ms N] [--json]\n  expert-council feedback <execution-id> --verification passed|failed [--json]\n  expert-council cleanup <execution-id> [--json]\n  expert-council status [--json]\n\nGlobal options:\n  --config PATH       JSON configuration file\n  --cwd PATH          project workspace\n  --telemetry PATH    local JSONL outcome store\n  --state PATH        durable council state file\n  --cost-policy NAME  economy, balanced, speed, or legacy quality\n`;
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
        result = (await service.inspectResources()).models;
        break;
      case "inspect":
        result = await service.inspectResources();
        break;
      case "build": {
        const task = bounded(values.join(" ").trim(), "build task", 100_000);
        const maxExperts = integerOption(args, "--max-experts", 1, 8);
        const costPolicyText = option(args, "--cost-policy");
        if (costPolicyText && !COST_POLICIES.has(costPolicyText as CostPolicy)) {
          throw new Error(`--cost-policy must be one of: ${[...COST_POLICIES].join(", ")}`);
        }
        const costPolicy = costPolicyText as CostPolicy | undefined;
        result = await service.buildCouncil({
          task,
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
        result = await service.delegate({
          role,
          task,
          ...(option(args, "--workspace") ? { workspace: bounded(option(args, "--workspace")!, "workspace", 32_768) } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        break;
      }
      case "status":
        result = await service.getStatus();
        break;
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
