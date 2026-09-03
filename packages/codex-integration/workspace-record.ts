import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface CodexHookInput {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
}

interface WorkspaceRecord {
  version: 1;
  sessionId: string;
  cwd: string;
  recordedAt: string;
}

const SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;

function pluginDataRoot(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.PLUGIN_DATA ?? environment.CLAUDE_PLUGIN_DATA;
  return value && !value.includes("\0") ? path.resolve(value) : undefined;
}

function sessionId(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.CODEX_SESSION_ID ?? environment.CODEX_THREAD_ID;
  return value && SESSION_ID.test(value) ? value : undefined;
}

function recordPath(dataRoot: string, id: string): string {
  const key = createHash("sha256").update(id).digest("hex");
  return path.join(dataRoot, "workspace-roots", `${key}.json`);
}

export async function recordCodexWorkspace(
  input: CodexHookInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (input.hook_event_name !== "PreToolUse"
    || typeof input.tool_name !== "string"
    || !/^mcp__expert_council__expert_/.test(input.tool_name)
    || typeof input.session_id !== "string"
    || !SESSION_ID.test(input.session_id)
    || typeof input.cwd !== "string"
    || !path.isAbsolute(input.cwd)
    || input.cwd.includes("\0")) {
    return false;
  }
  const dataRoot = pluginDataRoot(environment);
  if (!dataRoot) return false;

  const cwd = await realpath(input.cwd);
  if (!(await stat(cwd)).isDirectory()) return false;
  const target = recordPath(dataRoot, input.session_id);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const record: WorkspaceRecord = {
    version: 1,
    sessionId: input.session_id,
    cwd,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return true;
}

export async function readCodexWorkspaceRoots(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const dataRoot = pluginDataRoot(environment);
  const id = sessionId(environment);
  if (!dataRoot || !id) return [];

  try {
    const parsed = JSON.parse(await readFile(recordPath(dataRoot, id), "utf8")) as Partial<WorkspaceRecord>;
    if (parsed.version !== 1 || parsed.sessionId !== id || typeof parsed.cwd !== "string" || !path.isAbsolute(parsed.cwd)) {
      return [];
    }
    const cwd = await realpath(parsed.cwd);
    return (await stat(cwd)).isDirectory() ? [cwd] : [];
  } catch {
    return [];
  }
}
