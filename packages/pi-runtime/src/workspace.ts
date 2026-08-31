import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
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
      const worktreeBase = path.join(tmpdir(), "expert-council-worktrees");
      await mkdir(worktreeBase, { recursive: true });
      const safeName = path.basename(gitRoot).replace(/[^a-zA-Z0-9._-]/g, "-");
      const worktree = path.join(worktreeBase, `${safeName}-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
      await git(gitRoot, ["worktree", "add", "--detach", worktree, "HEAD"], 30_000);
      return {
        cwd: path.join(worktree, relativeCwd),
        root: worktree,
        isolated: true,
        strategy: "git-worktree",
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
}
