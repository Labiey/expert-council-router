import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CouncilConfig } from "@expert-council/core";

const execFileAsync = promisify(execFile);

export interface PreparedWorkspace {
  cwd: string;
  root: string;
  isolated: boolean;
  strategy: "read-only" | "git-worktree" | "bounded-in-place";
  sourceRoot?: string;
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

  private async defaultGitRoot(): Promise<string> {
    const cwd = await this.assertAllowed(this.defaultWorkspace);
    return canonical(await git(cwd, ["rev-parse", "--show-toplevel"]));
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
        if (Date.now() - info.mtimeMs < this.config.worktreeRetentionMs) continue;
        await git(resolvedGitRoot, ["worktree", "remove", "--force", worktree], 30_000);
        removed.push(worktree);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
    }
    await git(resolvedGitRoot, ["worktree", "prune"]);
    return removed;
  }

  async mutationCapability(): Promise<WorkspaceMutationCapability> {
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
      const gitRoot = await this.defaultGitRoot();
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
          `Mutation requires a Git repository with a committed HEAD. To opt into in-place mutation, set security.workspaceStrategy=bounded-in-place and security.allowInPlaceMutations=true. ${error instanceof Error ? error.message : String(error)}`,
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

  async prepare(candidate: string | undefined, readOnly: boolean, executionId: string): Promise<PreparedWorkspace> {
    validateExecutionId(executionId);
    const cwd = await this.assertAllowed(candidate ?? this.defaultWorkspace);
    if (readOnly || this.config.workspaceStrategy === "read-only") {
      if (!readOnly) throw new Error("Mutation role was denied because workspaceStrategy is read-only.");
      return { cwd, root: cwd, isolated: false, strategy: "read-only" };
    }

    const strategy = this.config.workspaceStrategy;
    if (strategy === "bounded-in-place") {
      if (!this.config.allowInPlaceMutations) {
        throw new Error("bounded-in-place mutation requires security.allowInPlaceMutations=true.");
      }
      return { cwd, root: cwd, isolated: false, strategy: "bounded-in-place" };
    }

    let cleanupGitRoot: string | undefined;
    let cleanupWorktree: string | undefined;
    try {
      const gitRoot = await canonical(await git(cwd, ["rev-parse", "--show-toplevel"]));
      cleanupGitRoot = gitRoot;
      const relativeCwd = path.relative(gitRoot, cwd);
      const worktreeBase = await this.secureWorktreeBase();
      await this.pruneExpired(gitRoot);
      const safeName = path.basename(gitRoot).replace(/[^a-zA-Z0-9._-]/g, "-");
      const worktree = path.join(
        worktreeBase,
        `${safeName}-${Date.now()}-${randomUUID()}-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      );
      await git(gitRoot, ["worktree", "add", "--detach", worktree, "HEAD"], 30_000);
      cleanupWorktree = worktree;
      const created = await canonical(worktree);
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
      return {
        cwd: path.join(created, relativeCwd),
        root: created,
        isolated: true,
        strategy: "git-worktree",
        sourceRoot: gitRoot,
      };
    } catch (error) {
      if (cleanupGitRoot && cleanupWorktree) {
        await git(cleanupGitRoot, ["worktree", "remove", "--force", cleanupWorktree], 30_000).catch(() => undefined);
        await git(cleanupGitRoot, ["worktree", "prune"]).catch(() => undefined);
      }
      if (strategy === "git-worktree" || !this.config.allowInPlaceMutations) {
        throw new Error(
          `Unable to create an isolated Git worktree; in-place mutation is disabled. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { cwd, root: cwd, isolated: false, strategy: "bounded-in-place" };
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
      const gitRoot = await this.defaultGitRoot();
      const base = await this.secureWorktreeBase();
      const suffix = `-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const worktrees: string[] = [];
      for (const listed of await this.listedWorktrees(gitRoot)) {
        try {
          const resolved = await canonical(listed);
          if (resolved !== base && isWithin(base, resolved) && path.basename(resolved).endsWith(suffix)) {
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
          await git(gitRoot, ["worktree", "remove", "--force", worktree], 30_000);
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
