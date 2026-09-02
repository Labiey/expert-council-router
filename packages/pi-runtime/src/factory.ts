import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ExpertCouncilService, type ExpertCouncil } from "@expert-council/core";
import { loadCouncilConfig } from "./config-loader.js";
import { JsonlTelemetryStore } from "./file-telemetry.js";
import { JsonModelAssessmentStore } from "./file-assessment.js";
import { JsonCouncilStateStore } from "./file-state.js";
import { SplitCouncilStateStore } from "./persistent-state.js";
import { PiExpertRuntime } from "./pi-runtime.js";

export interface CreateCouncilOptions {
  cwd?: string;
  configPath?: string;
  telemetryPath?: string;
  statePath?: string;
  modelAssessmentPath?: string;
  roleDirectory?: string;
}

function resolveOperatorPath(cwd: string, value: string, label: string): string {
  if (!value || value.length > 32_768 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty path of at most 32768 characters without NUL bytes.`);
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

async function fileExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export function defaultCouncilDataRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (environment.EXPERT_COUNCIL_DATA_DIR) return path.resolve(environment.EXPERT_COUNCIL_DATA_DIR);
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ExpertCouncil");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ExpertCouncil");
  return path.join(environment.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "expert-council");
}

export function defaultCouncilStoragePaths(cwd: string, dataRoot = defaultCouncilDataRoot()) {
  const resolved = path.resolve(cwd);
  const workspaceIdentity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const workspaceId = createHash("sha256").update(workspaceIdentity).digest("hex").slice(0, 20);
  const workspaceRoot = path.join(path.resolve(dataRoot), "workspaces", workspaceId);
  return {
    workspaceRoot,
    statePath: path.join(workspaceRoot, "state.json"),
    telemetryPath: path.join(path.resolve(dataRoot), "telemetry.jsonl"),
    modelAssessmentPath: path.join(path.resolve(dataRoot), "model-assessment.json"),
  };
}

export async function createExpertCouncil(options: CreateCouncilOptions = {}): Promise<ExpertCouncil> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = await loadCouncilConfig(options.configPath);
  const roleDirectory = options.roleDirectory
    ? resolveOperatorPath(cwd, options.roleDirectory, "Role directory")
    : undefined;
  const runtime = await PiExpertRuntime.create({ cwd, config, ...(roleDirectory ? { roleDirectory } : {}) });
  const defaults = defaultCouncilStoragePaths(cwd);
  const telemetryPath = resolveOperatorPath(
    cwd,
    options.telemetryPath ?? process.env.EXPERT_COUNCIL_TELEMETRY ?? defaults.telemetryPath,
    "Telemetry path",
  );
  const statePath = resolveOperatorPath(
    cwd,
    options.statePath ?? process.env.EXPERT_COUNCIL_STATE ?? defaults.statePath,
    "State path",
  );
  const modelAssessmentPath = resolveOperatorPath(
    cwd,
    options.modelAssessmentPath
      ?? process.env.EXPERT_COUNCIL_MODEL_ASSESSMENT
      ?? defaults.modelAssessmentPath,
    "Model assessment path",
  );
  const stateStore = new JsonCouncilStateStore(statePath);
  const assessmentStore = new JsonModelAssessmentStore(modelAssessmentPath);
  const persistence = new SplitCouncilStateStore(stateStore, assessmentStore);
  let initialState = await persistence.load();
  if (process.platform === "win32" && !initialState?.modelAssessment) {
    const legacyRoot = path.join(homedir(), ".expert-council");
    if (path.relative(legacyRoot, defaultCouncilDataRoot()) !== "") {
      const legacyPaths = defaultCouncilStoragePaths(cwd, legacyRoot);
      if (await fileExists(legacyPaths.statePath) || await fileExists(legacyPaths.modelAssessmentPath)) {
        const legacyPersistence = new SplitCouncilStateStore(
          new JsonCouncilStateStore(legacyPaths.statePath),
          new JsonModelAssessmentStore(legacyPaths.modelAssessmentPath),
        );
        const legacyState = await legacyPersistence.load();
        if (legacyState?.modelAssessment) {
          await assessmentStore.save(legacyState.modelAssessment);
          initialState = {
            version: 1,
            plans: initialState?.plans ?? legacyState.plans,
            executions: initialState?.executions ?? legacyState.executions,
            results: initialState?.results ?? legacyState.results,
            modelAssessment: legacyState.modelAssessment,
          };
        }
      }
    }
  }
  return new ExpertCouncilService(runtime, config, new JsonlTelemetryStore(telemetryPath), {
    ...(initialState ? { initialState } : {}),
    persistence,
  });
}
