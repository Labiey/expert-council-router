import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  message?: string;
}

export interface WorkspaceMutationCapability {
  mutation: boolean;
  workspaceIsolation: "git-worktree" | "bounded-workspace" | "none";
  limitations: string[];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonical(value: string): Promise<string> {
  return realpath(path.resolve(value));
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

  private worktreeBase(): string {
    return path.join(tmpdir(), "expert-council-worktrees");
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
    const base = path.resolve(this.worktreeBase());
    const removed: string[] = [];
    for (const worktree of await this.listedWorktrees(gitRoot)) {
      if (worktree === base || !isWithin(base, worktree)) continue;
      try {
        const info = await stat(worktree);
        if (Date.now() - info.mtimeMs < this.config.worktreeRetentionMs) continue;
        await git(gitRoot, ["worktree", "remove", "--force", worktree], 30_000);
        removed.push(worktree);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
    }
    await git(gitRoot, ["worktree", "prune"]);
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
      return { mutation: true, workspaceIsolation: "git-worktree", limitations: [] };
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

    try {
      const gitRoot = await canonical(await git(cwd, ["rev-parse", "--show-toplevel"]));
      const relativeCwd = path.relative(gitRoot, cwd);
      const worktreeBase = this.worktreeBase();
      await mkdir(worktreeBase, { recursive: true });
      await this.pruneExpired(gitRoot);
      const safeName = path.basename(gitRoot).replace(/[^a-zA-Z0-9._-]/g, "-");
      const worktree = path.join(
        worktreeBase,
        `${safeName}-${Date.now()}-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      );
      await git(gitRoot, ["worktree", "add", "--detach", worktree, "HEAD"], 30_000);
      return {
        cwd: path.join(worktree, relativeCwd),
        root: worktree,
        isolated: true,
        strategy: "git-worktree",
        sourceRoot: gitRoot,
      };
    } catch (error) {
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
    if (this.config.workspaceStrategy === "read-only" || this.config.workspaceStrategy === "bounded-in-place") {
      return { status: "not-required", message: "This workspace strategy creates no detached worktree." };
    }
    try {
      const gitRoot = await this.defaultGitRoot();
      const base = path.resolve(this.worktreeBase());
      const suffix = `-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const worktree = (await this.listedWorktrees(gitRoot)).find(
        (candidate) => candidate !== base && isWithin(base, candidate) && path.basename(candidate).endsWith(suffix),
      );
      if (!worktree) {
        await git(gitRoot, ["worktree", "prune"]);
        return { status: "not-found" };
      }
      await git(gitRoot, ["worktree", "remove", "--force", worktree], 30_000);
      await git(gitRoot, ["worktree", "prune"]);
      return { status: "cleaned", workspace: worktree };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
