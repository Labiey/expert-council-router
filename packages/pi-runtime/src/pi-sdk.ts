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
  DefaultResourceLoader?: new (options: Record<string, unknown>) => {
    reload(): Promise<void>;
    getSkills(): { skills: Array<Record<string, unknown>>; diagnostics?: unknown[] };
  };
  getAgentDir?: () => string;
}

const SUPPORTED_PI_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
] as const;

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
      const candidate = imported as Record<string, unknown>;
      const modelRuntime = candidate.ModelRuntime as Record<string, unknown> | undefined;
      if (typeof modelRuntime?.create === "function" && typeof candidate.createAgentSession === "function") {
        return { sdk: imported as PiSdkLike, packageName };
      }
      errors.push(`${packageName}: missing ModelRuntime/createAgentSession exports`);
    } catch (error) {
      errors.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const explicitDirectory = process.env.PI_CODING_AGENT_MODULE;
  if (explicitDirectory) {
    try {
      const imported = await loadFromPackageDirectory(explicitDirectory);
      return { sdk: imported as PiSdkLike, packageName: `path:${explicitDirectory}` };
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
        return { sdk: imported as PiSdkLike, packageName: `${packageName}:global` };
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
