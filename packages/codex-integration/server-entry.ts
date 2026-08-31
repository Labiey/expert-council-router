import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultMcpServer } from "@expert-council/mcp-server";

process.env.EXPERT_COUNCIL_ROLE_DIR ??= fileURLToPath(new URL("./roles", import.meta.url));
const server = await createDefaultMcpServer({ cwd: process.env.EXPERT_COUNCIL_WORKSPACE });
await server.connect(new StdioServerTransport());
