import path from "node:path";
import { ExpertCouncilService, type ExpertCouncil } from "@expert-council/core";
import { loadCouncilConfig } from "./config-loader.js";
import { JsonlTelemetryStore } from "./file-telemetry.js";
import { PiExpertRuntime } from "./pi-runtime.js";

export interface CreateCouncilOptions {
  cwd?: string;
  configPath?: string;
  telemetryPath?: string;
}

export async function createExpertCouncil(options: CreateCouncilOptions = {}): Promise<ExpertCouncil> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = await loadCouncilConfig(options.configPath);
  const runtime = await PiExpertRuntime.create({ cwd, config });
  const telemetryPath = options.telemetryPath ?? path.join(cwd, ".expert-council", "telemetry.jsonl");
  return new ExpertCouncilService(runtime, config, new JsonlTelemetryStore(telemetryPath));
}
