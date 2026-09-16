import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rm as rmPath, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CouncilConfig, WorkspaceProvisioningConfig } from "@expert-council/core";

const execFileAsync = promisify(execFile);

/**
 * Whether a provisioning driver can actually suppress the ecosystem's build/lifecycle
 * scripts. Declared per driver so the documentation and the host-facing limitation stay
 * tied to code rather than to a sentence (defect #37):
 *   flag          - an install-time switch is appended (npm, pnpm, bun)
 *   env           - suppression exists only as configuration, not as a CLI flag (yarn)
 *   unavailable   - the toolchain executes build code and offers no supported opt-out
 *   unverified    - this repository has not verified the driver's behavior either way,
 *                   so it must not be documented as suppressing scripts
 */
export type ScriptSuppression = "flag" | "env" | "unavailable" | "unverified";

export interface WorkspaceProvisioningStatus {
  status: "ready" | "skipped" | "failed";
  packageManager?: string;
  command?: string;
  durationMs?: number;
  detail?: string;
  /** Suppression class of the driver that actually ran, when one did. */
  scriptSuppression?: ScriptSuppression;
  /** Why this driver cannot suppress scripts, when a reason was recorded. */
  suppressionNote?: string;
}

export interface PreparedWorkspace {
  cwd: string;
  root: string;
  isolated: boolean;
  strategy: "read-only" | "git-worktree" | "bounded-in-place";
  sourceRoot?: string;
  /** Result of runtime provisioning for this attempt. */
  provisioning: WorkspaceProvisioningStatus;
  /** Per-execution degradation notes, e.g. a provisioning failure. */
  limitations?: string[];
}

export interface WorkspaceCleanupResult {
  status: "cleaned" | "not-found" | "not-required" | "failed";
  workspace?: string;
  workspaces?: string[];
  removedCount?: number;
  message?: string;
}

export interface WorkspaceMutationCapability {
  mutation: boolean;
  workspaceIsolation: "git-worktree" | "bounded-workspace" | "none";
  sourceWorkspaceDirty?: boolean;
  limitations: string[];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonical(value: string): Promise<string> {
  return realpath(path.resolve(value));
}

function validateBoundedPath(value: string, label: string): void {
  if (!value || value.length > 32_768 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty path of at most 32768 characters without NUL bytes.`);
  }
}

function validateExecutionId(value: string): void {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) {
    throw new Error("executionId must contain only letters, digits, underscore, or hyphen and be at most 200 characters.");
  }
}

function assertOwnedAndPrivate(info: Stats, label: string): void {
  if (typeof process.getuid !== "function") return;
  if (info.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user.`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} is writable by another user or group.`);
}

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

/**
 * Creation time embedded in the generated worktree directory name
 * (`<safeName>-<epochMs>-<uuid>-<executionId>`). Directory mtime is not a
 * reliable creation signal on Windows, so retention checks prefer this
 * explicit epoch and fall back to mtime only for older directories.
 */
export function worktreeNameEpochMs(worktree: string): number | undefined {
  const match = /-(\d{13})-[0-9a-f]{8}-/i.exec(path.basename(worktree));
  if (!match) return undefined;
  const epoch = Number(match[1]);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : undefined;
}

/** Suffix used to match a worktree to its execution id (shared with cleanup). */
export function worktreeMatchesExecutionId(worktree: string, executionId: string): boolean {
  return path.basename(worktree).endsWith(`-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
}

const PROVISIONING_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_CACHE",
]);

/**
 * Child environments for provisioning and verification are allowlisted: only
 * runtime plumbing and the registry/cache locations npm-family tools need are
 * forwarded. Credentials (API tokens, cloud keys, git credentials) are dropped
 * because they are not in the allowlist.
 */
export function scrubProvisioningEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (PROVISIONING_ENV_ALLOWLIST.has(upper) || upper.startsWith("GIT_")) scrubbed[key] = value;
  }
  return scrubbed;
}

/**
 * The residual-exposure note for a provisioning run whose driver could not suppress
 * ecosystem build scripts, or whose behavior this repository has not verified (defect #37).
 *
 * This exists because the previous documentation asserted "never running lifecycle
 * scripts" for a driver registry where the claim was true for two commands out of thirteen.
 * The honest form is not a sentence nobody can falsify: it is a class declared per driver
 * and reported to the Main Agent whenever the class is weaker than the promise, so an
 * operator can decide whether that is acceptable for the repository being provisioned.
 * A lockfile still bounds *what* gets installed; it does not bound *whether installed code
 * runs* during the install.
 */
export function provisioningSuppressionLimitation(status: WorkspaceProvisioningStatus): string | undefined {
  if (status.status !== "ready") return undefined;
  const driver = status.packageManager ?? "the detected package manager";
  if (status.scriptSuppression === "unavailable") {
    return `Worktree provisioning used ${driver}, which cannot suppress ecosystem build scripts${
      status.suppressionNote ? ` (${status.suppressionNote})` : ""
    }. The committed lockfile still bounds what is installed, but installing may run code shipped by packages it pins.`;
  }
  if (status.scriptSuppression === "unverified") {
    return `Worktree provisioning used ${driver}; Expert Council has not verified whether that command suppresses ecosystem build scripts${
      status.suppressionNote ? ` (${status.suppressionNote})` : ""
    }, so treat the install as able to execute build code from pinned packages.`;
  }
  return undefined;
}

export interface BoundedCommandOptions {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export interface BoundedCommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export type BoundedCommandRunner = (argv: string[], options: BoundedCommandOptions) => Promise<BoundedCommandOutcome>;

/**
 * Windows resolves npm/pnpm through .cmd shims that execFile cannot launch
 * directly; modern Node also refuses .bat/.cmd children without a shell.
 * Route those commands through cmd.exe while keeping every other argv
 * element intact (all argv entries are operator/runtime owned).
 */
export function resolvePlatformCommand(file: string): { file: string; shell: boolean } {
  if (process.platform === "win32" && /^(npm|pnpm|yarn)$/i.test(file)) {
    return { file: `${file}.cmd`, shell: true };
  }
  return { file, shell: false };
}

/** Run a single argv command without a shell, bounded by timeout and output size. */
export async function runBoundedCommand(argv: string[], options: BoundedCommandOptions): Promise<BoundedCommandOutcome> {
  const [file, ...args] = argv;
  if (!file) return { exitCode: 1, stdout: "", stderr: "", timedOut: false, error: "Empty command argv." };
  const resolved = resolvePlatformCommand(file);
  try {
    const result = await execFileAsync(resolved.file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: options.env,
      shell: resolved.shell,
    });
    return {
      exitCode: 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      timedOut: false,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      timedOut: failure.killed === true || failure.signal === "SIGTERM" || failure.code === "ETIMEDOUT",
      error: failure.message,
    };
  }
}

/** Keep only the tail of a child's output, sanitized of control characters. */
export function tailCommandOutput(value: string, maximum: number): string {
  const sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  return sanitized.length > maximum ? sanitized.slice(sanitized.length - maximum) : sanitized;
}

export interface ProvisioningPlan {
  packageManager?: string;
  argv?: string[];
  detail?: string;
  /** Merged into the child environment after scrubbing, so it cannot be scrubbed away. */
  env?: Record<string, string>;
  scriptSuppression?: ScriptSuppression;
  /** Ecosystem-specific wording for the residual-exposure note. */
  suppressionNote?: string;
}

function withIgnoreScripts(argv: string[]): string[] {
  return argv.includes("--ignore-scripts") ? argv : [...argv, "--ignore-scripts"];
}

/** Bound a package-manager label to the persisted identifier limits. */
function safePackageManager(value?: string): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 200);
  return sanitized || undefined;
}

/** Bound a command label to the persisted executionMetadata limits. */
function safeCommandLabel(argv: string[]): string {
  return argv.join(" ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 8_000);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function existsAny(root: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    if (await pathExists(path.join(root, file))) return true;
  }
  return false;
}

interface EcosystemDriver {
  packageManager: string;
  markers: string[];
  argv?: string[];
  detail?: string;
  env?: Record<string, string>;
  scriptSuppression?: ScriptSuppression;
  suppressionNote?: string;
}

/**
 * Ordered, most-specific-first per-ecosystem materialization drivers. Each runs
 * the ecosystem's standard install/build command, which already reads that
 * toolchain's machine-global download cache (pnpm store, ~/.cargo, GOMODCACHE,
 * ~/.m2, ~/.nuget, pip/uv cache, bundler, composer, hex), so a per-worktree
 * install is a fast local materialization, not a full re-download. A driver
 * never points concurrent worktrees at a shared recompiled build/target dir
 * (cargo locks its target); each worktree materializes its own.
 */
const PROVISIONING_DRIVERS: EcosystemDriver[] = [
  // Suppression is stated per driver, from evidence rather than from a wish: the
  // --ignore-scripts flag exists for npm/pnpm/bun, Yarn Berry removed it from its CLI (so
  // passing it breaks the install instead of hardening it), current Poetry has no install
  // script switch at all, and the remaining toolchains are marked unverified rather than
  // assumed safe. The old registry relied on a README sentence that said "always".
  { packageManager: "pnpm", markers: ["pnpm-lock.yaml"], scriptSuppression: "flag", argv: withIgnoreScripts(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]) },
  { packageManager: "npm", markers: ["package-lock.json"], scriptSuppression: "flag", argv: withIgnoreScripts(["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"]) },
  { packageManager: "bun", markers: ["bun.lock", "bun.lockb"], scriptSuppression: "flag", argv: withIgnoreScripts(["bun", "install", "--frozen-lockfile"]) },
  {
    packageManager: "yarn",
    markers: ["yarn.lock"],
    // Deliberately no --ignore-scripts in argv: Berry removed that option, and Yarn
    // Classic is the only generation that accepts it. Both generations read their
    // setting from the environment instead, so both are covered by two variables.
    // Berry defaults enableScripts to false already, with documented cases where scripts
    // still ran (a dependency carrying its own Yarn v1 lockfile), so this is stated as
    // env-suppression, not as a guarantee.
    scriptSuppression: "env",
    env: { YARN_ENABLE_SCRIPTS: "false", YARN_IGNORE_SCRIPTS: "true" },
    argv: ["yarn", "install", "--frozen-lockfile"],
  },
  { packageManager: "uv", markers: ["uv.lock"], scriptSuppression: "unavailable", suppressionNote: "uv sync builds source distributions when no wheel is available, which executes Python build code (--no-build avoids that but fails instead of building)", argv: ["uv", "sync", "--frozen"] },
  { packageManager: "poetry", markers: ["poetry.lock"], scriptSuppression: "unavailable", suppressionNote: "current Poetry exposes no install-time script switch and builds the project itself", argv: ["poetry", "install", "--no-interaction"] },
  { packageManager: "cargo", markers: ["Cargo.lock", "Cargo.toml"], scriptSuppression: "unavailable", suppressionNote: "cargo build runs build scripts (build.rs) for crates that declare them", argv: ["cargo", "build", "--locked"] },
  { packageManager: "go", markers: ["go.mod"], scriptSuppression: "unverified", argv: ["go", "mod", "download"] },
  { packageManager: "maven", markers: ["pom.xml"], scriptSuppression: "unverified", argv: ["mvn", "-q", "-B", "-DskipTests", "dependency:go-offline"] },
  { packageManager: "dotnet", markers: ["global.json", "Directory.Build.props"], scriptSuppression: "unverified", suppressionNote: "restore evaluates MSBuild, and custom targets can execute code", argv: ["dotnet", "restore"] },
  { packageManager: "bundler", markers: ["Gemfile.lock"], scriptSuppression: "unverified", suppressionNote: "bundle install compiles native extensions", argv: ["bundle", "install"] },
  // composer supports a no-scripts switch upstream; it is not applied here because this
  // repository has not verified it in this environment, and guessing an installer flag
  // is how provisioning gets broken while looking hardened.
  { packageManager: "composer", markers: ["composer.lock"], scriptSuppression: "unverified", argv: ["composer", "install", "--no-interaction", "--prefer-dist"] },
  { packageManager: "mix", markers: ["mix.lock"], scriptSuppression: "unverified", argv: ["mix", "deps.get"] },
];

/** Environment-as-code backends: detected and surfaced, never materialized here. */
const AS_CODE_BACKENDS: EcosystemDriver[] = [
  {
    packageManager: "nix",
    markers: ["flake.nix", "shell.nix"],
    detail: "Nix detected; run expert commands via `nix develop` / `nix build`. Expert Council does not materialize Nix environments — use security.workspaceProvisioning.strategy=in-place or run the expert inside the Nix shell.",
  },
  {
    packageManager: "devcontainer",
    markers: [".devcontainer/devcontainer.json"],
    detail: "Dev Container detected; the environment is containerized. Run the expert inside the container or use in-place read-execution; Expert Council does not build container images.",
  },
];

async function pythonEcosystemPlan(root: string, hostWorkspace?: string): Promise<ProvisioningPlan> {
  const hostInterpreter = await findHostPythonInterpreter(hostWorkspace);
  if (hostInterpreter) {
    return { detail: `Python ecosystem detected; venv provisioning is unsupported — invoke the host workspace interpreter directly by absolute path: ${hostInterpreter}` };
  }
  return { detail: "Python ecosystem detected but no host .venv interpreter was found; create one in the host workspace first." };
}

/**
 * Detect how a worktree should be provisioned from its own committed lockfile.
 * Only ecosystems with a deterministic lockfile are supported; everything else
 * is reported as skipped so the expert degrades to the absent-dependencies path.
 */
export async function detectProvisioningPlan(
  root: string,
  config: WorkspaceProvisioningConfig,
  hostWorkspace?: string,
): Promise<ProvisioningPlan> {
  if (config.mode === "custom") {
    if (!config.command?.length) {
      return { detail: "security.workspaceProvisioning.mode=custom requires a non-empty command." };
    }
    return { packageManager: config.command[0], argv: [...config.command] };
  }
  if (config.strategy === "in-place") {
    return { detail: "strategy=in-place: dependencies are resolved by read-only execution against the host workspace, not materialized in the worktree." };
  }
  if (config.strategy === "as-code") {
    for (const backend of AS_CODE_BACKENDS) {
      if (await existsAny(root, backend.markers)) return { packageManager: backend.packageManager, detail: backend.detail };
    }
  }
  for (const driver of PROVISIONING_DRIVERS) {
    if (await existsAny(root, driver.markers)) {
      return {
        packageManager: driver.packageManager,
        ...(driver.argv ? { argv: driver.argv } : {}),
        ...(driver.detail ? { detail: driver.detail } : {}),
        ...(driver.env ? { env: driver.env } : {}),
        ...(driver.scriptSuppression ? { scriptSuppression: driver.scriptSuppression } : {}),
        ...(driver.suppressionNote ? { suppressionNote: driver.suppressionNote } : {}),
      };
    }
  }
  if (await existsAny(root, ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"])) {
    return await pythonEcosystemPlan(root, hostWorkspace);
  }
  // No standard install driver matched; surface an environment-as-code backend as
  // the actionable path when present, else report the unsupported ecosystem.
  for (const backend of AS_CODE_BACKENDS) {
    if (await existsAny(root, backend.markers)) return { packageManager: backend.packageManager, detail: backend.detail };
  }
  if (await existsAny(root, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"])) {
    return { packageManager: "gradle", detail: "Gradle detected; no cache-only materialization runs automatically. Use in-place read-execution or a custom provisioning command." };
  }
  if (await existsAny(root, ["composer.json", "Gemfile", "mix.exs"])) {
    return { detail: "Ruby/PHP/Elixir detected without a committed lockfile; add one for deterministic provisioning or use in-place read-execution." };
  }
  if (await existsAny(root, ["CMakeLists.txt", "meson.build", "configure", "Makefile"])) {
    return { detail: "C/C++ build system detected; toolchain assumed present on PATH. Use in-place read-execution or a custom provisioning command." };
  }
  return { detail: "no supported provisioning for this ecosystem" };
}

/** Locate an existing virtualenv interpreter in the host workspace. */
async function findHostPythonInterpreter(hostWorkspace: string | undefined): Promise<string | undefined> {
  if (!hostWorkspace) return undefined;
  const windows = process.platform === "win32";
  for (const dir of [".venv", "venv"]) {
    const python = windows
      ? path.join(hostWorkspace, dir, "Scripts", "python.exe")
      : path.join(hostWorkspace, dir, "bin", "python");
    if (await pathExists(python)) return python;
  }
  return undefined;
}

class ProvisioningSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
    this.active += 1;
  }
  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }
}

let activeProvisioningSemaphore: ProvisioningSemaphore | undefined;

function provisioningSemaphore(limit: number): ProvisioningSemaphore {
  if (!activeProvisioningSemaphore || activeProvisioningSemaphore.limit !== limit) {
    activeProvisioningSemaphore = new ProvisioningSemaphore(limit);
  }
  return activeProvisioningSemaphore;
}

async function isAlreadyProvisioned(root: string, packageManager?: string): Promise<boolean> {
  return packageManager === "npm" || packageManager === "pnpm" || packageManager === "bun"
    ? pathExists(path.join(root, "node_modules"))
    : false;
}

/**
 * Provision a worktree from its committed lockfile. Never throws: failures are
 * recorded so the caller can continue with today's unprovisioned behavior.
 */
export async function provisionWorkspace(
  root: string,
  config: WorkspaceProvisioningConfig,
  options: { runner?: BoundedCommandRunner; reused?: boolean; hostWorkspace?: string } = {},
): Promise<WorkspaceProvisioningStatus> {
  const started = Date.now();
  if (config.mode === "none") {
    return { status: "skipped", detail: "security.workspaceProvisioning.mode is none." };
  }
  const plan = await detectProvisioningPlan(root, config, options.hostWorkspace);
  const packageManager = safePackageManager(plan.packageManager);
  if (!plan.argv) {
    return {
      status: "skipped",
      ...(packageManager ? { packageManager } : {}),
      detail: plan.detail ?? "no supported provisioning for this ecosystem",
      durationMs: Date.now() - started,
    };
  }
  const commandLabel = safeCommandLabel(plan.argv);
  if (options.reused && (config.mode === "custom" || await isAlreadyProvisioned(root, plan.packageManager))) {
    return {
      status: "ready",
      ...(packageManager ? { packageManager } : {}),
      command: commandLabel,
      durationMs: Date.now() - started,
      detail: "Reused a worktree already provisioned for this execution.",
    };
  }
  const runner = options.runner ?? runBoundedCommand;
  const scrubbedEnv = config.runtimeEnv === "host-env"
    ? { ...process.env }
    : (config.scrubEnv ? scrubProvisioningEnv() : { ...process.env });
  // The driver's own settings are merged AFTER scrubbing: the child environment is an
  // allowlist, so a suppression value that merely sat in the parent environment would be
  // dropped and the hardening would be invisible. Explicit merge also means a parent's
  // YARN_ENABLE_SCRIPTS=true cannot override the council's intent.
  const env: NodeJS.ProcessEnv = plan.env ? { ...scrubbedEnv, ...plan.env } : scrubbedEnv;
  const semaphore = provisioningSemaphore(config.maxConcurrent);
  await semaphore.acquire();
  let outcome: BoundedCommandOutcome;
  try {
    outcome = await runner(plan.argv, { cwd: root, timeoutMs: config.timeoutMs, env });
  } catch (error) {
    outcome = {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    semaphore.release();
  }
  const durationMs = Date.now() - started;
  if (outcome.exitCode === 0 && !outcome.timedOut) {
    return {
      status: "ready",
      ...(packageManager ? { packageManager } : {}),
      command: commandLabel,
      durationMs,
      detail: `Provisioned with ${plan.argv[0]}.`,
      ...(plan.scriptSuppression ? { scriptSuppression: plan.scriptSuppression } : {}),
      ...(plan.suppressionNote ? { suppressionNote: plan.suppressionNote } : {}),
    };
  }
  const tail = tailCommandOutput(outcome.stderr || outcome.stdout, 4 * 1024);
  const detail = `Provisioning failed${outcome.timedOut ? " (timed out)" : ` with exit code ${outcome.exitCode}`}${
    outcome.error ? `: ${outcome.error}` : ""
  }${tail ? `: ${tail}` : ""}`;
  return {
    status: "failed",
    ...(packageManager ? { packageManager } : {}),
    command: commandLabel,
    durationMs,
    detail: detail.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 8_000),
  };
}

export class WorkspaceBoundary {
  constructor(
    private readonly defaultWorkspace: string,
    private readonly config: CouncilConfig["security"],
  ) {}

  private worktreeBasePath(): string {
    const identity = typeof process.getuid === "function"
      ? `uid-${process.getuid()}`
      : createHash("sha256").update(userInfo().username).digest("hex").slice(0, 16);
    // EXPERT_COUNCIL_WORKTREES redirects the parent directory (administrative
    // input, like the other EXPERT_COUNCIL_* path flags) so operators can move
    // worktrees off a short-path or slow volume, and tests can isolate
    // themselves from the shared production namespace. The per-user private
    // identity directory is always preserved.
    const parent = (process.env.EXPERT_COUNCIL_WORKTREES ?? "").trim();
    return path.resolve(parent || tmpdir(), `expert-council-worktrees-${identity}`);
  }

  private async secureWorktreeBase(): Promise<string> {
    const expected = this.worktreeBasePath();
    await mkdir(expected, { recursive: true, mode: 0o700 });
    const linkInfo = await lstat(expected);
    if (linkInfo.isSymbolicLink()) throw new Error("Expert Council worktree base must not be a symbolic link.");
    const resolved = await canonical(expected);
    if (path.relative(expected, resolved) !== "") {
      throw new Error("Expert Council worktree base resolves outside its expected temporary path.");
    }
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error("Expert Council worktree base is not a directory.");
    assertOwnedAndPrivate(info, "Expert Council worktree base");
    await chmod(resolved, 0o700).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32") throw error;
    });
    return resolved;
  }

  private async defaultGitRoot(cwd: string): Promise<string> {
    const allowed = await this.assertAllowed(cwd);
    return canonical(await git(allowed, ["rev-parse", "--show-toplevel"]));
  }

  private async listedWorktrees(gitRoot: string): Promise<string[]> {
    const output = await git(gitRoot, ["worktree", "list", "--porcelain"]);
    return output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length)));
  }

  async pruneExpired(gitRoot: string): Promise<string[]> {
    validateBoundedPath(gitRoot, "Git root");
    const resolvedGitRoot = await canonical(gitRoot);
    const base = await this.secureWorktreeBase();
    const removed: string[] = [];
    for (const listed of await this.listedWorktrees(resolvedGitRoot)) {
      try {
        const worktree = await canonical(listed);
        if (worktree === base || !isWithin(base, worktree)) continue;
        const info = await stat(worktree);
        assertOwnedAndPrivate(info, `Worktree ${worktree}`);
        const creationMs = worktreeNameEpochMs(worktree) ?? info.mtimeMs;
        if (Date.now() - creationMs < this.config.worktreeRetentionMs) continue;
        await git(resolvedGitRoot, ["worktree", "remove", "--force", worktree], this.config.workspaceProvisioning.removalTimeoutMs);
        removed.push(worktree);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
    }
    await git(resolvedGitRoot, ["worktree", "prune"]);
    return removed;
  }

  async mutationCapability(cwd: string = this.defaultWorkspace): Promise<WorkspaceMutationCapability> {
    if (this.config.workspaceStrategy === "read-only") {
      return { mutation: false, workspaceIsolation: "none", limitations: ["Mutation is disabled by workspaceStrategy=read-only."] };
    }
    if (this.config.workspaceStrategy === "bounded-in-place") {
      return this.config.allowInPlaceMutations
        ? { mutation: true, workspaceIsolation: "bounded-workspace", limitations: ["Mutation runs in-place inside configured allowed roots."] }
        : {
            mutation: false,
            workspaceIsolation: "none",
            limitations: ["bounded-in-place requires security.allowInPlaceMutations=true."],
          };
    }
    try {
      const gitRoot = await this.defaultGitRoot(cwd);
      await git(gitRoot, ["rev-parse", "--verify", "HEAD"]);
      let sourceWorkspaceDirty: boolean | undefined;
      const limitations: string[] = [];
      try {
        sourceWorkspaceDirty = Boolean(await git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]));
      } catch {
        limitations.push(
          "Unable to determine whether the source workspace has uncommitted changes; detached mutation worktrees still start from committed HEAD.",
        );
      }
      if (sourceWorkspaceDirty) {
        limitations.push("Source workspace has uncommitted changes; detached mutation worktrees start from committed HEAD and will not include them.");
      }
      return {
        mutation: true,
        workspaceIsolation: "git-worktree",
        ...(sourceWorkspaceDirty !== undefined ? { sourceWorkspaceDirty } : {}),
        limitations,
      };
    } catch (error) {
      if (this.config.workspaceStrategy === "auto" && this.config.allowInPlaceMutations) {
        return {
          mutation: true,
          workspaceIsolation: "bounded-workspace",
          limitations: ["Git worktree isolation is unavailable; explicitly enabled bounded in-place mutation will be used."],
        };
      }
      return {
        mutation: false,
        workspaceIsolation: "none",
        limitations: [
          `Mutation requires a Git repository with a committed HEAD inside the allowed roots. Retry the writable delegation with workspace set to the target project's Git repository root, or explicitly opt into in-place mutation with security.workspaceStrategy=bounded-in-place and security.allowInPlaceMutations=true. ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  private async assertAllowed(candidate: string): Promise<string> {
    validateBoundedPath(candidate, "Workspace");
    const resolved = await canonical(candidate);
    const roots = this.config.allowedWorkspaceRoots.length
      ? await Promise.all(this.config.allowedWorkspaceRoots.map(canonical))
      : [await canonical(this.defaultWorkspace)];
    if (!roots.some((root) => isWithin(root, resolved))) {
      throw new Error(`Workspace ${resolved} is outside configured allowed roots.`);
    }
    return resolved;
  }

  /**
   * Resolve and containment-check a workspace path for read-only use — the
   * same validation the read-only branch of prepare() applies. Throws when the
   * path is outside the configured allowed roots.
   */
  async resolveReadOnlyWorkspace(candidate: string): Promise<string> {
    return this.assertAllowed(candidate);
  }

  /**
   * Resolve a retained worktree root by execution id — the same per-execution
   * matching (git worktree list + execution-id suffix inside the private worktree
   * base) that cleanupExecution uses. Returns undefined when no retained
   * worktree exists; never throws.
   */
  async retainedWorktree(executionId: string): Promise<string | undefined> {
    try {
      validateExecutionId(executionId);
      if (this.config.workspaceStrategy === "read-only" || this.config.workspaceStrategy === "bounded-in-place") {
        return undefined;
      }
      const gitRoot = await this.defaultGitRoot(this.defaultWorkspace);
      const base = await this.secureWorktreeBase();
      for (const listed of await this.listedWorktrees(gitRoot)) {
        try {
          const resolved = await canonical(listed);
          if (resolved !== base && isWithin(base, resolved) && worktreeMatchesExecutionId(resolved, executionId)) {
            assertOwnedAndPrivate(await stat(resolved), `Worktree ${resolved}`);
            return resolved;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch {
      // Best-effort resolution: an unreadable repository or worktree base means
      // there is no usable retained worktree for this execution.
    }
    return undefined;
  }

  /** Find a worktree created for this execution id so a retry can reuse its provisioned state. */
  private async findReusableWorktree(gitRoot: string, worktreeBase: string, executionId: string): Promise<string | undefined> {
    for (const listed of await this.listedWorktrees(gitRoot)) {
      try {
        const resolved = await canonical(listed);
        if (
          resolved !== worktreeBase &&
          isWithin(worktreeBase, resolved) &&
          worktreeMatchesExecutionId(resolved, executionId)
        ) {
          return resolved;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }

  /** Re-run the full containment/ownership/registration validation for a worktree path. */
  private async validateWorktree(gitRoot: string, worktreeBase: string, candidate: string): Promise<string> {
    const created = await canonical(candidate);
    if (!isWithin(worktreeBase, created)) throw new Error("Created worktree escaped the private worktree base.");
    const createdInfo = await stat(created);
    assertOwnedAndPrivate(createdInfo, `Worktree ${created}`);
    await chmod(created, 0o700).catch((chmodError: NodeJS.ErrnoException) => {
      if (process.platform !== "win32") throw chmodError;
    });
    const marker = await lstat(path.join(created, ".git"));
    if (!marker.isFile()) throw new Error("Created worktree has an invalid .git registration marker.");
    const markerText = (await readFile(path.join(created, ".git"), "utf8")).trim();
    const gitDirValue = /^gitdir:\s*(.+)$/i.exec(markerText)?.[1];
    if (!gitDirValue) throw new Error("Created worktree .git registration is malformed.");
    const registeredGitDir = await canonical(path.isAbsolute(gitDirValue) ? gitDirValue : path.resolve(created, gitDirValue));
    const commonDirValue = await git(gitRoot, ["rev-parse", "--git-common-dir"]);
    const commonDir = await canonical(path.isAbsolute(commonDirValue) ? commonDirValue : path.resolve(gitRoot, commonDirValue));
    const worktreeRegistrations = await canonical(path.join(commonDir, "worktrees"));
    if (!isWithin(worktreeRegistrations, registeredGitDir)) {
      throw new Error("Created worktree registration is outside this repository's Git metadata.");
    }
    assertOwnedAndPrivate(await stat(commonDir), "Repository Git metadata");
    return created;
  }

  async prepare(candidate: string | undefined, readOnly: boolean, executionId: string): Promise<PreparedWorkspace> {
    validateExecutionId(executionId);
    const cwd = await this.assertAllowed(candidate ?? this.defaultWorkspace);
    if (readOnly || this.config.workspaceStrategy === "read-only") {
      if (!readOnly) throw new Error("Mutation role was denied because workspaceStrategy is read-only.");
      return {
        cwd,
        root: cwd,
        isolated: false,
        strategy: "read-only",
        provisioning: { status: "skipped", detail: "Read-only roles run in the main workspace; no provisioning is performed." },
      };
    }

    const strategy = this.config.workspaceStrategy;
    if (strategy === "bounded-in-place") {
      if (!this.config.allowInPlaceMutations) {
        throw new Error("bounded-in-place mutation requires security.allowInPlaceMutations=true.");
      }
      return {
        cwd,
        root: cwd,
        isolated: false,
        strategy: "bounded-in-place",
        provisioning: { status: "skipped", detail: "bounded-in-place workspaces are not provisioned." },
      };
    }

    let cleanupGitRoot: string | undefined;
    let cleanupWorktree: string | undefined;
    try {
      const gitRoot = await canonical(await git(cwd, ["rev-parse", "--show-toplevel"]));
      cleanupGitRoot = gitRoot;
      const relativeCwd = path.relative(gitRoot, cwd);
      const worktreeBase = await this.secureWorktreeBase();
      await this.pruneExpired(gitRoot);
      const reusable = await this.findReusableWorktree(gitRoot, worktreeBase, executionId);
      let reused = false;
      let worktree: string;
      if (reusable) {
        reused = true;
        worktree = reusable;
      } else {
        const safeName = path.basename(gitRoot).replace(/[^a-zA-Z0-9._-]/g, "-");
        worktree = path.join(
          worktreeBase,
          `${safeName}-${Date.now()}-${randomUUID()}-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        );
        await git(gitRoot, ["worktree", "add", "--detach", worktree, "HEAD"], 30_000);
      }
      cleanupWorktree = worktree;
      const created = await this.validateWorktree(gitRoot, worktreeBase, worktree);
      cleanupWorktree = created;
      if (reused) {
        // Re-establish the documented clean-slate-from-HEAD guarantee before the
        // retry runs, while preserving the node_modules paid for by provisioning.
        await git(created, ["reset", "--hard", "HEAD"], this.config.workspaceProvisioning.removalTimeoutMs);
        await git(created, ["clean", "-fdxq", "-e", "node_modules"], this.config.workspaceProvisioning.removalTimeoutMs);
      }
      const provisioning = await provisionWorkspace(created, this.config.workspaceProvisioning, {
        reused,
        hostWorkspace: this.defaultWorkspace,
      });
      const limitations: string[] = [];
      if (provisioning.status === "failed") {
        limitations.push(
          `Worktree provisioning failed: ${provisioning.detail ?? "unknown error"}. Dependencies are not installed; do not attempt an install.`.slice(0, 2_000),
        );
      }
      // A successful provisioning that could not suppress build scripts is not a silent
      // pass: the host has to be able to see the exposure it inherited (#37).
      const suppression = provisioningSuppressionLimitation(provisioning);
      if (suppression) limitations.push(suppression.slice(0, 2_000));
      return {
        cwd: path.join(created, relativeCwd),
        root: created,
        isolated: true,
        strategy: "git-worktree",
        sourceRoot: gitRoot,
        provisioning,
        ...(limitations.length ? { limitations } : {}),
      };
    } catch (error) {
      if (cleanupGitRoot && cleanupWorktree) {
        await git(cleanupGitRoot, ["worktree", "remove", "--force", cleanupWorktree], this.config.workspaceProvisioning.removalTimeoutMs).catch(() => undefined);
        await git(cleanupGitRoot, ["worktree", "prune"]).catch(() => undefined);
      }
      if (strategy === "git-worktree" || !this.config.allowInPlaceMutations) {
        throw new Error(
          `Unable to create an isolated Git worktree; in-place mutation is disabled. Retry with workspace set to the target project's Git repository root inside the allowed roots, or enable security.workspaceStrategy=bounded-in-place with security.allowInPlaceMutations=true explicitly. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        cwd,
        root: cwd,
        isolated: false,
        strategy: "bounded-in-place",
        provisioning: { status: "skipped", detail: "bounded-in-place workspaces are not provisioned." },
      };
    }
  }

  /**
   * Which files this workspace changed. A failed `git status` comes back as an error, not
   * as an empty list: "nothing changed" and "cannot tell" are different facts, and
   * collapsing them makes a mutation expert's real work invisible to the host - the host
   * reads `filesChanged: []` on a successful run and integrates nothing (defect #28).
   */
  async changedFiles(workspace: PreparedWorkspace): Promise<{ files: string[]; error?: string }> {
    try {
      const output = await git(workspace.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
      return {
        files: output
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const file = line.slice(2).trimStart();
            return file.split(" -> ").at(-1) ?? file;
          }),
      };
    } catch (error) {
      return {
        files: [],
        error: String(error instanceof Error ? error.message : error).slice(0, 200),
      };
    }
  }

  async cleanupExecution(executionId: string): Promise<WorkspaceCleanupResult> {
    validateExecutionId(executionId);
    if (this.config.workspaceStrategy === "read-only" || this.config.workspaceStrategy === "bounded-in-place") {
      return { status: "not-required", message: "This workspace strategy creates no detached worktree." };
    }
    try {
      const gitRoot = await this.defaultGitRoot(this.defaultWorkspace);
      const base = await this.secureWorktreeBase();
      const worktrees: string[] = [];
      for (const listed of await this.listedWorktrees(gitRoot)) {
        try {
          const resolved = await canonical(listed);
          if (resolved !== base && isWithin(base, resolved) && worktreeMatchesExecutionId(resolved, executionId)) {
            assertOwnedAndPrivate(await stat(resolved), `Worktree ${resolved}`);
            worktrees.push(resolved);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!worktrees.length) {
        await git(gitRoot, ["worktree", "prune"]);
        return { status: "not-found" };
      }
      worktrees.sort();
      const removed: string[] = [];
      const failures: string[] = [];
      for (const worktree of worktrees) {
        try {
          await git(gitRoot, ["worktree", "remove", "--force", worktree], this.config.workspaceProvisioning.removalTimeoutMs);
          removed.push(worktree);
        } catch (error) {
          // Provisioned worktrees hold deep node_modules trees that exceed
          // Windows MAX_PATH, which git cannot delete. Node's fs (libuv)
          // handles long paths, so fall back to a direct recursive removal
          // and let `git worktree prune` clear the stale metadata.
          try {
            await rmPath(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
            removed.push(worktree);
          } catch (removeError) {
            failures.push(`${worktree}: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
          }
        }
      }
      await git(gitRoot, ["worktree", "prune"]);
      const details = {
        ...(removed.length ? { workspace: removed.at(-1), workspaces: removed, removedCount: removed.length } : {}),
      };
      return failures.length
        ? { status: "failed", ...details, message: `Unable to remove ${failures.length} matching worktree(s): ${failures.join("; ")}` }
        : { status: "cleaned", ...details };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
