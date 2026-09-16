import { open, readdir } from "node:fs/promises";
import path from "node:path";
import type { CostPolicy, ExpertCouncil, ExpertRole } from "@expert-council/core";
import { createExpertCouncil, defaultCouncilDataRoot } from "@expert-council/pi-runtime";

export interface CliIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

/**
 * Optional in-process seams for `runCli`. `formatEvent` exists so a caller (or a
 * test) can substitute the renderer; production always resolves the shared
 * `formatExpertEvent` from `@expert-council/core`. The CLI never carries its own
 * copy of the formatting rules.
 */
export interface CliDeps {
  formatEvent?: (event: ExpertEventFrame) => string;
}

/**
 * Tolerant reader-side mirror of one JSONL frame of the runtime's observability
 * stream (`ExpertObservabilityEvent` in `@expert-council/core`). It is a *reader*,
 * not a formatter: fields are copied only after a type check, unknown extras are
 * dropped, and an unrecognised `kind` is passed through so a newer runtime's event
 * still renders (core's renderer has a `default:` branch for exactly that).
 */
export interface ExpertEventFrame {
  t: string;
  executionId: string;
  role: string;
  /** `kind` is intentionally widened: a future event kind must not break the tail. */
  kind: string;
  model?: string;
  /** Attempt number, when the runtime recorded one (a delegation can span several). */
  attempt?: number;
  tool?: string;
  ok?: boolean;
  text?: string;
  argsSummary?: string;
  status?: string;
  failureType?: string;
  durationMs?: number;
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

const BOOLEAN_FLAGS = ["--json", "--help", "--follow"];

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--")) {
      if (!BOOLEAN_FLAGS.includes(args[index]!)) index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}

function help(): string {
  return `Expert Council CLI\n\nUsage:\n  expert-council models [--json]\n  expert-council inspect [--json]\n  expert-council compositions [--session-key KEY] [--json]\n  expert-council build <task> [--max-experts N] [--cost-policy POLICY] [--composition NAME] [--json]\n  expert-council delegate <role> <task> [--workspace PATH] [--timeout-ms N] [--reasoning-level LEVEL] [--model PROVIDER/ID] [--json]\n  expert-council feedback <execution-id> --verification passed|failed [--json]\n  expert-council cleanup <execution-id> [--json]
  expert-council abort <execution-id> [--reason TEXT] [--json]\n  expert-council status [--view full|summary|running] [--json]\n  expert-council reset <scope> [--json]        scope: '*', a provider, or provider/id\n  expert-council verify (--exec ID | --workspace PATH) --command JSON_ARRAY [--timeout-ms N] [--json]\n  expert-council respond <execution-id> --kind decision [--choice TEXT | --other TEXT] [--json]\n  expert-council respond <execution-id> --kind tool_approval --scope once|persistent|reject [--json]
  expert-council watch --exec ID [--dir PATH] [--json] [--follow] [--interval-ms N] [--timeout-ms N]

watch (run it from a second terminal) tails the live expert event stream that the
runtime writes to <dataDir>/observability/<execution-id>.jsonl while
security.observability.expertWindow is "interactive":
  --exec ID         execution id to follow (required; only its own stream file is read)
  --dir PATH        stream directory override; defaults to <dataDir>/observability, where
                    <dataDir> honours EXPERT_COUNCIL_DATA_DIR
  --json            print the raw JSON frames instead of the shared human rendering
  --follow          keep tailing; exits at a terminal event (completed, failed, stopped,
                    stream_truncated), at --timeout-ms, or if the stream file disappears
  --interval-ms N   poll interval, 50-60000 (default 1000)
  --timeout-ms N    maximum total follow time, 1000-3600000 (default 300000)
Without --follow it prints what already exists and exits. Never feed a path from
model output or task text into --exec or --dir; both are operator arguments.\n\nGlobal options:\n  --config PATH       JSON configuration file\n  --cwd PATH          project workspace\n  --telemetry PATH    local JSONL outcome store\n  --state PATH        durable council state file\n  --cost-policy NAME  economy, balanced, speed, or legacy quality\n  --composition NAME  saved council composition from council-compositions.json\n  --model KEY         pin one provider/id model for a delegation\n`;
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

/** Kinds that close a stream; `watch --follow` must stop at the first one it sees. */
const WATCH_TERMINAL_KINDS = new Set(["completed", "failed", "stopped", "stream_truncated"]);
/** Written by a runtime that knows the delegation, not merely one attempt, has ended. */
const WATCH_FINAL_KIND = "delegation_final";
/**
 * A stream that cannot write a final marker is judged closed only after it has stopped
 * growing for this long. Stopping at the first per-attempt terminal event cut observers off
 * mid-delegation - which is precisely what a retried or escalated run looks like - and a
 * runtime that died without writing anything is bounded by --timeout-ms instead.
 */
const WATCH_QUIET_MS = 750;
const WATCH_STREAM_SUFFIX = ".jsonl";
/** Why an operator sees nothing: the prerequisite is a configuration the runtime honoured at start. */
const WATCH_PREREQUISITE_HINT = 'The runtime writes this stream only for a run started while security.observability.expertWindow is "interactive" (the default "off" writes nothing).';
const WATCH_MAX_CHUNK_BYTES = 1_048_576;
const WATCH_MAX_LINE_BYTES = 4_194_304;
const WATCH_LISTED_IDS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Resolve the shared renderer owned by `@expert-council/core`. Formatting lives in
 * exactly one place on purpose, so the CLI must not grow its own copy; when the
 * installed core build does not export it we fail with an actionable message (or the
 * caller uses `--json`, which needs no renderer at all).
 */
export async function resolveExpertEventFormatter(): Promise<(event: ExpertEventFrame) => string> {
  const core: unknown = await import("@expert-council/core");
  const shared = (core as { formatExpertEvent?: unknown }).formatExpertEvent;
  if (typeof shared !== "function") {
    throw new Error(
      "watch cannot render events: @expert-council/core in this build does not export "
      + "formatExpertEvent (the single owner of expert event formatting). Rebuild the workspace so the "
      + "installed core provides it, or run watch with --json to read the raw stream.",
    );
  }
  return shared as (event: ExpertEventFrame) => string;
}

/**
 * Where the operator's streams live. `--dir` is an explicit operator argument, the
 * default is the runtime's own data root (EXPERT_COUNCIL_DATA_DIR-aware); neither is
 * ever derived from task text or model output.
 */
function watchStreamDir(args: string[]): string {
  if (args.includes("--dir")) {
    const value = option(args, "--dir");
    if (value === undefined) throw new Error("watch --dir requires a path");
    return path.resolve(bounded(value, "--dir", 32_768));
  }
  return path.join(defaultCouncilDataRoot(), "observability");
}

function safeStreamId(entry: string): string | undefined {
  if (!entry.endsWith(WATCH_STREAM_SUFFIX)) return undefined;
  const id = entry.slice(0, -WATCH_STREAM_SUFFIX.length);
  return /^[a-zA-Z0-9_-]{1,200}$/.test(id) ? id : undefined;
}

/** Execution ids that actually have a stream in this directory (for actionable errors). */
async function listStreamExecutions(dir: string): Promise<{ ids: string[]; extra: number }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { ids: [], extra: 0 };
  }
  const ids = entries
    .map((entry) => safeStreamId(entry))
    .filter((id): id is string => id !== undefined)
    .sort();
  return { ids: ids.slice(0, WATCH_LISTED_IDS), extra: Math.max(0, ids.length - WATCH_LISTED_IDS) };
}

function describeStreams(dir: string, listed: { ids: string[]; extra: number }): string {
  if (listed.ids.length === 0) return `no .jsonl streams found in ${dir}`;
  return `available execution id(s) in ${dir}: ${listed.ids.join(", ")}${listed.extra > 0 ? ` (+${listed.extra} more)` : ""}`;
}

/**
 * Read one bounded slice from a byte offset. Returns `missing` instead of throwing on
 * ENOENT so the caller can distinguish "never existed" from "vanished mid-follow", and
 * rewinds to 0 when the file shrank (a replaced stream).
 */
async function readStreamChunk(file: string, offset: number): Promise<{
  missing: boolean;
  rewound: boolean;
  data: Buffer;
  nextOffset: number;
}> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(file, "r");
      const size = (await handle.stat()).size;
      const start = size < offset ? 0 : offset;
      const length = Math.min(size - start, WATCH_MAX_CHUNK_BYTES);
      if (length === 0) {
        return { missing: false, rewound: start === 0 && offset > 0, data: Buffer.alloc(0), nextOffset: size };
      }
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return {
        missing: false,
        rewound: start === 0 && offset > 0,
        data: buffer.subarray(0, bytesRead),
        nextOffset: start + bytesRead,
      };
    } finally {
      await handle?.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { missing: true, rewound: false, data: Buffer.alloc(0), nextOffset: 0 };
    }
    throw error;
  }
}

async function streamExists(file: string): Promise<boolean> {
  const probe = await readStreamChunk(file, 0);
  return !probe.missing;
}

function parseExpertEvent(line: string): ExpertEventFrame | undefined {
  if (line.length === 0 || line.length > WATCH_MAX_LINE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const frame = value as Record<string, unknown>;
  if (typeof frame.t !== "string" || typeof frame.role !== "string" || typeof frame.kind !== "string") {
    return undefined;
  }
  const text = (key: string): string | undefined => (typeof frame[key] === "string" ? frame[key] as string : undefined);
  return {
    t: frame.t,
    executionId: text("executionId") ?? "",
    role: frame.role,
    kind: frame.kind,
    ...(text("model") !== undefined ? { model: text("model") } : {}),
    ...(text("tool") !== undefined ? { tool: text("tool") } : {}),
    ...(typeof frame.ok === "boolean" ? { ok: frame.ok } : {}),
    ...(text("text") !== undefined ? { text: text("text") } : {}),
    ...(text("argsSummary") !== undefined ? { argsSummary: text("argsSummary") } : {}),
    ...(text("status") !== undefined ? { status: text("status") } : {}),
    ...(text("failureType") !== undefined ? { failureType: text("failureType") } : {}),
    ...(typeof frame.durationMs === "number" ? { durationMs: frame.durationMs } : {}),
    ...(typeof frame.attempt === "number" ? { attempt: frame.attempt } : {}),
  };
}

async function runWatch(args: string[], io: CliIo, injectedFormat?: (event: ExpertEventFrame) => string): Promise<number> {
  const dir = watchStreamDir(args);
  const executionId = option(args, "--exec");
  if (executionId === undefined) {
    throw new Error(`watch requires --exec <execution-id>; ${describeStreams(dir, await listStreamExecutions(dir))}`);
  }
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(executionId)) {
    throw new Error(`watch --exec must be 1-200 characters of A-Z, a-z, 0-9, '_' or '-' (got a rejected value); ${describeStreams(dir, await listStreamExecutions(dir))}`);
  }
  const follow = args.includes("--follow");
  const json = args.includes("--json");
  const intervalMs = integerOption(args, "--interval-ms", 50, 60_000) ?? 1_000;
  const timeoutMs = integerOption(args, "--timeout-ms", 1_000, 3_600_000) ?? 300_000;
  const file = path.join(dir, `${executionId}${WATCH_STREAM_SUFFIX}`);
  if (!(await streamExists(file))) {
    const listed = describeStreams(dir, await listStreamExecutions(dir));
    throw new Error(`watch found no event stream for ${executionId} at ${file}. ${WATCH_PREREQUISITE_HINT} ${listed}`);
  }
  const format = json ? undefined : (injectedFormat ?? await resolveExpertEventFormatter());

  let offset = 0;
  // Node's Buffer is generic over its ArrayBuffer type since @types/node 22, and
  // subarray() widens to Buffer<ArrayBufferLike>; holding the wider type here is what
  // lets the partial-line carry-over compile.
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let terminal: string | undefined;
  let finalSeen = false;
  let lastGrowthAt = Date.now();
  let legacyClose = false;
  let vanished = false;
  let malformed = 0;
  let printed = 0;
  const deadline = Date.now() + (follow ? timeoutMs : 0);
  // Bounded by construction: one pass without --follow, and with --follow at most
  // ceil(timeout/interval) polls plus the deadline check on each pass.
  const maxPasses = follow ? Math.ceil(timeoutMs / intervalMs) + 2 : 1;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const chunk = await readStreamChunk(file, offset);
    if (chunk.missing) {
      vanished = true;
      break;
    }
    if (chunk.rewound) pending = Buffer.alloc(0);
    offset = chunk.nextOffset;
    const merged = pending.length > 0 && chunk.data.length > 0
      ? Buffer.concat([pending, chunk.data])
      : (pending.length > 0 ? pending : chunk.data);
    const lastNewline = merged.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      if (merged.length > WATCH_MAX_LINE_BYTES) {
        throw new Error(`watch found no newline within ${WATCH_MAX_LINE_BYTES} bytes in ${file}; the stream is malformed`);
      }
      pending = merged;
    } else {
      pending = merged.subarray(lastNewline + 1);
      for (const rawLine of merged.subarray(0, lastNewline + 1).toString("utf8").split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.trim() === "") continue;
        const event = parseExpertEvent(line);
        if (event !== undefined && event.kind === WATCH_FINAL_KIND) finalSeen = true;
        else if (event !== undefined && WATCH_TERMINAL_KINDS.has(event.kind)) terminal ??= event.kind;
        if (json) {
          io.stdout.write(`${line}\n`);
          printed += 1;
        } else if (event !== undefined) {
          io.stdout.write(`${format!(event)}\n`);
          printed += 1;
        } else {
          malformed += 1;
        }
      }
    }
    if (finalSeen) break;
    if (!follow) break;
    // A per-attempt terminal is not the end of the story: the council may escalate to
    // another model, which keeps appending to this same stream. Only a file that has
    // stopped growing counts as finished when no final marker was written.
    if (chunk.data.length > 0) lastGrowthAt = Date.now();
    else if (terminal !== undefined && Date.now() - lastGrowthAt >= WATCH_QUIET_MS) {
      legacyClose = true;
      break;
    }
    if (Date.now() >= deadline) {
      io.stderr.write(`[watch] ${executionId}: stopped after --timeout-ms ${timeoutMs} (${printed} event line(s) shown)\n`);
      break;
    }
    await sleep(intervalMs);
  }
  if (vanished) {
    io.stderr.write(`watch: ${file} disappeared before the stream reached a terminal event. ${WATCH_PREREQUISITE_HINT}\n`);
    return 1;
  }
  if (terminal !== undefined) {
    io.stderr.write(`[watch] ${executionId}: stream closed (${terminal}${legacyClose ? `, no final marker and no growth for ${WATCH_QUIET_MS}ms` : ""})\n`);
  }
  if (!follow && pending.length > 0) {
    io.stderr.write(`[watch] ${executionId}: held back ${pending.length} trailing byte(s) with no newline yet (still being written)\n`);
  }
  if (malformed > 0) {
    io.stderr.write(`[watch] ${executionId}: ignored ${malformed} unparseable line(s)\n`);
  }
  return 0;
}

export async function runCli(
  args: string[],
  io: CliIo = process,
  council?: ExpertCouncil,
  deps: CliDeps = {},
): Promise<number> {
  const command = args[0];
  if (!command || command === "help" || args.includes("--help")) {
    io.stdout.write(help());
    return 0;
  }
  try {
    // `watch` is a second-terminal reader of an on-disk stream: it must work without
    // a council, a model inventory, or a provisioned workspace, so it is dispatched
    // before createExpertCouncil.
    if (command === "watch") return await runWatch(args, io, deps.formatEvent);
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
      case "respond": {
        const executionId = values[0];
        if (!executionId || !/^[a-zA-Z0-9_-]{1,200}$/.test(executionId)) throw new Error("respond requires a valid execution ID");
        const kind = option(args, "--kind");
        if (kind !== "decision" && kind !== "tool_approval") {
          throw new Error("respond requires --kind decision|tool_approval");
        }
        const choice = option(args, "--choice");
        const other = option(args, "--other");
        const scope = option(args, "--scope");
        if (kind === "decision" && !choice && !other) {
          throw new Error("respond --kind decision requires --choice or --other");
        }
        if (kind === "tool_approval" && !["once", "persistent", "reject"].includes(scope ?? "")) {
          throw new Error("respond --kind tool_approval requires --scope once|persistent|reject");
        }
        result = await service.respondToInteraction({
          executionId,
          response: {
            kind,
            ...(choice ? { choice: bounded(choice, "choice", 500) } : {}),
            ...(other ? { otherText: bounded(other, "other", 4_000) } : {}),
            ...(scope ? { scope: scope as "once" | "persistent" | "reject" } : {}),
          },
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
