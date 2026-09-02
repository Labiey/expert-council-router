import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryPlugin = await mkdtemp(path.join(tmpdir(), "expert-council-installed-plugin-"));
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

  const cwd = path.resolve(temporaryPlugin, server.cwd);
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd,
    env: { ...process.env, ...server.env, EXPERT_COUNCIL_WORKSPACE: process.cwd() },
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
      tools: tools.tools.map((tool) => tool.name),
      inspectContentBlocks: inspect.content.length,
    }));
  } finally {
    await client.close();
  }
} finally {
  await rm(temporaryPlugin, { recursive: true, force: true });
}
