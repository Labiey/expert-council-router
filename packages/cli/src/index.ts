import type { ExpertCouncil, ExpertRole } from "@expert-council/core";
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

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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
  return `Expert Council CLI\n\nUsage:\n  expert-council models [--json]\n  expert-council inspect [--json]\n  expert-council build <task> [--max-experts N] [--json]\n  expert-council delegate <role> <task> [--workspace PATH] [--timeout-ms N] [--json]\n  expert-council cleanup <execution-id> [--json]\n  expert-council status [--json]\n\nGlobal options:\n  --config PATH       JSON configuration file\n  --cwd PATH          project workspace\n  --telemetry PATH    local JSONL outcome store\n  --state PATH        durable council state file\n`;
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
        const task = values.join(" ").trim();
        if (!task) throw new Error("build requires a task description");
        const maxExpertsText = option(args, "--max-experts");
        const maxExperts = maxExpertsText ? Number.parseInt(maxExpertsText, 10) : undefined;
        result = await service.buildCouncil({
          task,
          ...(maxExperts !== undefined ? { constraints: { maxExperts } } : {}),
        });
        break;
      }
      case "delegate": {
        const role = values[0] as ExpertRole | undefined;
        if (!role || !ROLES.has(role)) throw new Error(`delegate requires a valid semantic role: ${[...ROLES].join(", ")}`);
        const task = values.slice(1).join(" ").trim();
        if (!task) throw new Error("delegate requires a bounded task description");
        const timeoutText = option(args, "--timeout-ms");
        result = await service.delegate({
          role,
          task,
          ...(option(args, "--workspace") ? { workspace: option(args, "--workspace") } : {}),
          ...(timeoutText ? { timeoutMs: Number.parseInt(timeoutText, 10) } : {}),
        });
        break;
      }
      case "status":
        result = await service.getStatus();
        break;
      case "cleanup": {
        const executionId = values[0];
        if (!executionId) throw new Error("cleanup requires an execution ID");
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
