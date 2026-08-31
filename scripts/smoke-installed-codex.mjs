import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryPlugin = await mkdtemp(path.join(tmpdir(), "expert-council-installed-plugin-"));
try {
  const source = path.resolve("packages/codex-integration/plugin/expert-council/dist");
  await cp(path.join(source, "server.mjs"), path.join(temporaryPlugin, "server.mjs"));
  await cp(path.join(source, "roles"), path.join(temporaryPlugin, "roles"), { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(temporaryPlugin, "server.mjs")],
    env: { ...process.env, EXPERT_COUNCIL_WORKSPACE: process.cwd() },
  });
  const client = new Client({ name: "expert-council-installed-smoke", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const inspect = await client.callTool({ name: "expert_inspect", arguments: {} });
    console.log(JSON.stringify({
      isolatedPluginDirectory: true,
      tools: tools.tools.map((tool) => tool.name),
      inspectContentBlocks: inspect.content.length,
    }));
  } finally {
    await client.close();
  }
} finally {
  await rm(temporaryPlugin, { recursive: true, force: true });
}
