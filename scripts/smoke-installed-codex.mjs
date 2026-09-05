import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryPlugin = await mkdtemp(path.join(tmpdir(), "expert-council-installed-plugin-"));
try {
  const source = path.resolve("packages/codex-integration/plugin/expert-council");
  await cp(source, temporaryPlugin, { recursive: true });
  const isolatedAppData = path.join(temporaryPlugin, "empty-appdata");
  await mkdir(isolatedAppData);

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
    env: {
      ...process.env,
      ...server.env,
      // A Git marketplace install must not accidentally pass because the
      // developer has a compatible SDK in their global npm directory.
      APPDATA: isolatedAppData,
      NODE_PATH: "",
      PI_CODING_AGENT_MODULE: "",
    },
  });
  const client = new Client({ name: "expert-council-installed-smoke", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!client.getServerCapabilities()?.experimental?.["codex/sandbox-state-meta"]) {
      throw new Error("Installed plugin server did not advertise Codex sandbox metadata support");
    }
    const inspect = await client.callTool({
      name: "expert_inspect",
      arguments: {},
      _meta: {
        "codex/sandbox-state-meta": {
          sandboxCwd: pathToFileURL(process.cwd()).href,
          permissionProfile: {
            type: "managed",
            network: "restricted",
            file_system: { type: "restricted", entries: [] },
          },
        },
      },
    });
    const inspectText = inspect.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    let inventory;
    try {
      inventory = JSON.parse(inspectText);
    } catch {
      throw new Error(`expert_inspect did not return structured JSON: ${inspectText.slice(0, 500)}`);
    }
    if (!inventory || typeof inventory.summary?.modelCount !== "number" || !inventory.runtimeCapabilities) {
      throw new Error(`expert_inspect returned an error or invalid inventory: ${inspectText.slice(0, 500)}`);
    }
    if (!/^pi:@earendil-works\/pi-coding-agent:bundled-\d+\.\d+\.\d+$/.test(inventory.runtimeCapabilities.hostType)) {
      throw new Error(`Installed plugin did not use its bundled Pi SDK: ${inventory.runtimeCapabilities.hostType}`);
    }
    console.log(JSON.stringify({
      isolatedPluginDirectory: true,
      configuredCommand: server.command,
      configuredArgs: server.args,
      configuredCwd: server.cwd,
      workspaceHook: false,
      codexSandboxMetadata: true,
      noMcpRootsFallback: true,
      tools: tools.tools.map((tool) => tool.name),
      inspectContentBlocks: inspect.content.length,
      bundledPiSdk: true,
      availableModels: inventory.summary.modelCount,
    }));
  } finally {
    await client.close();
  }
} finally {
  await rm(temporaryPlugin, { recursive: true, force: true });
}
