export interface PiModelRuntimeLike {
  getAvailable(providerId?: string): Promise<readonly unknown[]>;
  getAvailableSnapshot?(): readonly unknown[];
  getModel(provider: string, id: string): unknown;
}

export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  waitForIdle?(): Promise<void>;
  abort?(): Promise<void>;
  dispose(): void;
  getAvailableThinkingLevels?(): string[];
  setThinkingLevel?(level: string): void;
  readonly messages?: readonly unknown[];
  readonly state?: { messages?: readonly unknown[] };
}

export interface PiSdkLike {
  ModelRuntime: { create(options?: Record<string, unknown>): Promise<PiModelRuntimeLike> };
  createAgentSession(options?: Record<string, unknown>): Promise<{ session: PiSessionLike }>;
  SessionManager?: { inMemory(cwd?: string): unknown };
  SettingsManager?: {
    create(cwd: string, agentDir?: string, options?: { projectTrusted?: boolean }): unknown;
  };
  DefaultResourceLoader?: new (options: Record<string, unknown>) => {
    reload(options?: { resolveProjectTrust?: (context: unknown) => Promise<boolean> }): Promise<void>;
    getSkills(): { skills: Array<Record<string, unknown>>; diagnostics?: unknown[] };
    getExtensions(): { extensions: unknown[]; diagnostics?: unknown[] };
  };
  getAgentDir?: () => string;
}

const SUPPORTED_PI_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
] as const;

export function validatePiSdk(value: unknown, source = "Pi SDK"): PiSdkLike {
  if (!value || typeof value !== "object") throw new Error(`${source} is not an object module.`);
  const candidate = value as Record<string, unknown>;
  const modelRuntime = candidate.ModelRuntime as Record<string, unknown> | undefined;
  const missing: string[] = [];
  if (typeof modelRuntime?.create !== "function") missing.push("ModelRuntime.create");
  if (typeof candidate.createAgentSession !== "function") missing.push("createAgentSession");
  const sessionManager = candidate.SessionManager as Record<string, unknown> | undefined;
  if (sessionManager && typeof sessionManager.inMemory !== "function") missing.push("SessionManager.inMemory");
  if (candidate.DefaultResourceLoader === undefined) missing.push("DefaultResourceLoader constructor");
  if (candidate.DefaultResourceLoader !== undefined) {
    if (typeof candidate.DefaultResourceLoader !== "function") {
      missing.push("DefaultResourceLoader constructor");
    } else {
      const prototype = (candidate.DefaultResourceLoader as { prototype?: Record<string, unknown> }).prototype;
      if (typeof prototype?.reload !== "function") missing.push("DefaultResourceLoader.reload");
      if (typeof prototype?.getSkills !== "function") missing.push("DefaultResourceLoader.getSkills");
      if (typeof prototype?.getExtensions !== "function") missing.push("DefaultResourceLoader.getExtensions");
    }
    const settingsManager = candidate.SettingsManager as Record<string, unknown> | undefined;
    if (typeof settingsManager?.create !== "function") missing.push("SettingsManager.create");
  }
  if (typeof candidate.getAgentDir !== "function") missing.push("getAgentDir");
  if (missing.length) {
    throw new Error(`${source} is incompatible with Expert Council; missing callable API(s): ${missing.join(", ")}.`);
  }
  return value as PiSdkLike;
}

export function validatePiModelRuntime(value: unknown, source = "Pi ModelRuntime"): PiModelRuntimeLike {
  if (!value || typeof value !== "object") throw new Error(`${source} did not return a runtime object.`);
  const runtime = value as Record<string, unknown>;
  const missing = ["getAvailable", "getModel"].filter((name) => typeof runtime[name] !== "function");
  if (missing.length) throw new Error(`${source} is incompatible; missing callable API(s): ${missing.join(", ")}.`);
  return value as PiModelRuntimeLike;
}

export function validatePiSession(value: unknown, source = "Pi session"): PiSessionLike {
  if (!value || typeof value !== "object") throw new Error(`${source} was not created.`);
  const session = value as Record<string, unknown>;
  const missing = ["prompt", "dispose"].filter((name) => typeof session[name] !== "function");
  if (missing.length) throw new Error(`${source} is incompatible; missing callable API(s): ${missing.join(", ")}.`);
  if (session.waitForIdle !== undefined && typeof session.waitForIdle !== "function") {
    throw new Error(`${source} exposes a non-callable waitForIdle API.`);
  }
  return value as PiSessionLike;
}

async function dynamicImport(specifier: string): Promise<unknown> {
  return import(specifier);
}

const execFileAsync = promisify(execFile);

async function loadFromPackageDirectory(packageDirectory: string): Promise<unknown> {
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as {
    main?: string;
  };
  const entry = path.resolve(packageDirectory, manifest.main ?? "dist/index.js");
  await access(entry);
  return dynamicImport(pathToFileURL(entry).href);
}

export async function loadPiSdk(): Promise<{ sdk: PiSdkLike; packageName: string }> {
  const errors: string[] = [];
  for (const packageName of SUPPORTED_PI_PACKAGES) {
    try {
      const imported = await dynamicImport(packageName);
      return { sdk: validatePiSdk(imported, packageName), packageName };
    } catch (error) {
      errors.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const explicitDirectory = process.env.PI_CODING_AGENT_MODULE;
  if (explicitDirectory) {
    try {
      const imported = await loadFromPackageDirectory(explicitDirectory);
      return { sdk: validatePiSdk(imported, `PI_CODING_AGENT_MODULE ${explicitDirectory}`), packageName: `path:${explicitDirectory}` };
    } catch (error) {
      errors.push(`PI_CODING_AGENT_MODULE: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const globalRoots = new Set<string>();
  for (const entry of (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean)) globalRoots.add(entry);
  if (process.platform === "win32" && process.env.APPDATA) {
    globalRoots.add(path.join(process.env.APPDATA, "npm", "node_modules"));
  } else {
    globalRoots.add(path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules"));
    try {
      const npmRoot = (await execFileAsync("npm", ["root", "-g"], { timeout: 5_000, windowsHide: true })).stdout.trim();
      if (npmRoot) globalRoots.add(npmRoot);
    } catch (error) {
      errors.push(`global npm lookup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const npmRoot of globalRoots) {
    for (const packageName of SUPPORTED_PI_PACKAGES) {
      try {
        const imported = await loadFromPackageDirectory(path.join(npmRoot, ...packageName.split("/")));
        return { sdk: validatePiSdk(imported, `global ${packageName}`), packageName: `${packageName}:global` };
      } catch (error) {
        errors.push(`global ${npmRoot} ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(
    `No compatible Pi SDK is installed. Install a supported Pi coding-agent package.\n${errors.join("\n")}`,
  );
}
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
