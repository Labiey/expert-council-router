import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CouncilConfig, WorkspaceProvisioningConfig } from "@expert-council/core";

const execFileAsync = promisify(execFile);

export interface WorkspaceProvisioningStatus {
  status: "ready" | "skipped" | "failed";
  packageManager?: string;
  command?: string;
  durationMs?: number;
  detail?: string;
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

/** Run a single argv command without a shell, bounded by timeout and output size. */
export async function runBoundedCommand(argv: string[], options: BoundedCommandOptions): Promise<BoundedCommandOutcome> {
  const [file, ...args] = argv;
  if (!file) return { exitCode: 1, stdout: "", stderr: "", timedOut: false, error: "Empty command argv." };
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: options.env,
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

/**
 * Detect how a worktree should be provisioned from its own committed lockfile.
 * Only ecosystems with a deterministic lockfile are supported; everything else
 * is reported as skipped so the expert degrades to the absent-dependencies path.
 */
export async function detectProvisioningPlan(
  root: string,
  config: WorkspaceProvisioningConfig,
): Promise<ProvisioningPlan> {
  if (config.mode === "custom") {
    if (!config.command?.length) {
      return { detail: "security.workspaceProvisioning.mode=custom requires a non-empty command." };
    }
    return { packageManager: config.command[0], argv: [...config.command] };
  }
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return {
      packageManager: "pnpm",
      argv: withIgnoreScripts(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]),
    };
  }
  if (await pathExists(path.join(root, "package-lock.json"))) {
    return {
      packageManager: "npm",
      argv: withIgnoreScripts(["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"]),
    };
  }
  if (await pathExists(path.join(root, "bun.lock")) || await pathExists(path.join(root, "bun.lockb"))) {
    return { packageManager: "bun", argv: ["bun", "install", "--frozen-lockfile"] };
  }
  if (
    await pathExists(path.join(root, "uv.lock")) ||
    await pathExists(path.join(root, "requirements.txt")) ||
    await pathExists(path.join(root, "Cargo.toml")) ||
    await pathExists(path.join(root, "go.mod"))
  ) {
    return { detail: "no supported provisioning for this ecosystem" };
  }
  return { detail: "no supported provisioning for this ecosystem" };
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
  options: { runner?: BoundedCommandRunner; reused?: boolean } = {},
): Promise<WorkspaceProvisioningStatus> {
  const started = Date.now();
  if (config.mode === "none") {
    return { status: "skipped", detail: "security.workspaceProvisioning.mode is none." };
  }
  const plan = await detectProvisioningPlan(root, config);
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
  const env = config.scrubEnv ? scrubProvisioningEnv() : { ...process.env };
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
    return path.resolve(tmpdir(), `expert-council-worktrees-${identity}`);
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
      const provisioning = await provisionWorkspace(created, this.config.workspaceProvisioning, { reused });
      const limitations: string[] = [];
      if (provisioning.status === "failed") {
        limitations.push(
          `Worktree provisioning failed: ${provisioning.detail ?? "unknown error"}. Dependencies are not installed; do not attempt an install.`.slice(0, 2_000),
        );
      }
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

  async changedFiles(workspace: PreparedWorkspace): Promise<string[]> {
    try {
      const output = await git(workspace.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
      return output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const file = line.slice(2).trimStart();
          return file.split(" -> ").at(-1) ?? file;
        });
    } catch {
      return [];
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
          failures.push(`${worktree}: ${error instanceof Error ? error.message : String(error)}`);
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
