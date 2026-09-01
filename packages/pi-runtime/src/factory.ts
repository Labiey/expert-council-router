import path from "node:path";
import { ExpertCouncilService, type ExpertCouncil } from "@expert-council/core";
import { loadCouncilConfig } from "./config-loader.js";
import { JsonlTelemetryStore } from "./file-telemetry.js";
import { JsonCouncilStateStore } from "./file-state.js";
import { PiExpertRuntime } from "./pi-runtime.js";

export interface CreateCouncilOptions {
  cwd?: string;
  configPath?: string;
  telemetryPath?: string;
  statePath?: string;
  roleDirectory?: string;
}

function resolveOperatorPath(cwd: string, value: string, label: string): string {
  if (!value || value.length > 32_768 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty path of at most 32768 characters without NUL bytes.`);
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

export async function createExpertCouncil(options: CreateCouncilOptions = {}): Promise<ExpertCouncil> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = await loadCouncilConfig(options.configPath);
  const roleDirectory = options.roleDirectory
    ? resolveOperatorPath(cwd, options.roleDirectory, "Role directory")
    : undefined;
  const runtime = await PiExpertRuntime.create({ cwd, config, ...(roleDirectory ? { roleDirectory } : {}) });
  const telemetryPath = resolveOperatorPath(
    cwd,
    options.telemetryPath ?? process.env.EXPERT_COUNCIL_TELEMETRY ?? path.join(cwd, ".expert-council", "telemetry.jsonl"),
    "Telemetry path",
  );
  const statePath = resolveOperatorPath(
    cwd,
    options.statePath ?? process.env.EXPERT_COUNCIL_STATE ?? path.join(cwd, ".expert-council", "state.json"),
    "State path",
  );
  const stateStore = new JsonCouncilStateStore(statePath);
  return new ExpertCouncilService(runtime, config, new JsonlTelemetryStore(telemetryPath), {
    initialState: await stateStore.load(),
    persistence: stateStore,
  });
}
