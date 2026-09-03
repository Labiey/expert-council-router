import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClientRootMcpServer } from "@expert-council/mcp-server";
import { readCodexWorkspaceRoots } from "./workspace-record.js";

const server = createClientRootMcpServer({
  cwd: process.env.EXPERT_COUNCIL_WORKSPACE,
  roleDirectory: fileURLToPath(new URL("./roles", import.meta.url)),
}, undefined, readCodexWorkspaceRoots);
await server.connect(new StdioServerTransport());
