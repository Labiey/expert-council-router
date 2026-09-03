import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryPlugin = await mkdtemp(path.join(tmpdir(), "expert-council-installed-plugin-"));
const temporaryPluginData = await mkdtemp(path.join(tmpdir(), "expert-council-plugin-data-"));
try {
  const source = path.resolve("packages/codex-integration/plugin/expert-council");
  await cp(source, temporaryPlugin, { recursive: true });

  const mcpFile = JSON.parse(await readFile(path.join(temporaryPlugin, ".mcp.json"), "utf8"));
  const servers = mcpFile.mcp_servers ?? mcpFile.mcpServers ?? mcpFile;
  const server = servers.expert_council;
  if (!server || typeof server.command !== "string" || !Array.isArray(server.args)) {
    throw new Error("Installed plugin smoke test could not find the expert_council stdio server");
  }
  if (server.command.includes("${PLUGIN_ROOT}") || server.args.some((arg) => arg.includes("${PLUGIN_ROOT}"))) {
    throw new Error("Codex MCP launch configuration must not depend on PLUGIN_ROOT interpolation");
  }
  if (typeof server.cwd !== "string") {
    throw new Error("Codex MCP launch configuration must set a plugin-relative cwd");
  }
  const hooks = JSON.parse(await readFile(path.join(temporaryPlugin, "hooks", "hooks.json"), "utf8"));
  if (!hooks.hooks?.PreToolUse?.length) {
    throw new Error("Installed plugin smoke test could not find the workspace-recording hook");
  }

  const cwd = path.resolve(temporaryPlugin, server.cwd);
  const sessionId = "installed_codex_smoke";
  const hookProcess = spawn(process.execPath, [path.join(temporaryPlugin, "hooks", "record-workspace.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLUGIN_ROOT: temporaryPlugin,
      PLUGIN_DATA: temporaryPluginData,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  hookProcess.stdin.end(JSON.stringify({
    session_id: sessionId,
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "mcp__expert_council__expert_inspect",
  }));
  const hookExitCode = await new Promise((resolve, reject) => {
    hookProcess.once("error", reject);
    hookProcess.once("close", resolve);
  });
  if (hookExitCode !== 0) throw new Error(`Workspace hook exited with code ${hookExitCode}`);

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd,
    env: {
      ...process.env,
      ...server.env,
      PLUGIN_DATA: temporaryPluginData,
      CODEX_SESSION_ID: sessionId,
    },
  });
  const client = new Client({ name: "expert-council-installed-smoke", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const inspect = await client.callTool({ name: "expert_inspect", arguments: {} });
    console.log(JSON.stringify({
      isolatedPluginDirectory: true,
      configuredCommand: server.command,
      configuredArgs: server.args,
      configuredCwd: server.cwd,
      workspaceHook: true,
      noMcpRootsFallback: true,
      tools: tools.tools.map((tool) => tool.name),
      inspectContentBlocks: inspect.content.length,
    }));
  } finally {
    await client.close();
  }
} finally {
  await Promise.all([
    rm(temporaryPlugin, { recursive: true, force: true }),
    rm(temporaryPluginData, { recursive: true, force: true }),
  ]);
}
