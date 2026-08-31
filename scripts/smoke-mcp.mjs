import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.resolve(process.argv[2] ?? "packages/mcp-server/dist/bin.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, EXPERT_COUNCIL_WORKSPACE: process.cwd() },
});
const client = new Client({ name: "expert-council-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  const expected = [
    "expert_inspect",
    "expert_build",
    "expert_delegate",
    "expert_result",
    "expert_feedback",
    "expert_cleanup",
    "expert_escalate",
    "expert_status",
  ];
  if (names.length !== expected.length || expected.some((name) => !names.includes(name))) {
    throw new Error(`Unexpected MCP tools: ${names.join(", ")}`);
  }
  const result = await client.callTool({ name: "expert_inspect", arguments: {} });
  console.log(JSON.stringify({ entry, tools: names, inspectContentBlocks: result.content.length }));
} finally {
  await client.close();
}
