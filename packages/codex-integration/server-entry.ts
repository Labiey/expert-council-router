import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultMcpServer } from "@expert-council/mcp-server";

const server = await createDefaultMcpServer({
  cwd: process.env.EXPERT_COUNCIL_WORKSPACE,
  roleDirectory: fileURLToPath(new URL("./roles", import.meta.url)),
});
await server.connect(new StdioServerTransport());
