import { fileURLToPath } from "node:url";
import * as bundledPiSdk from "@earendil-works/pi-coding-agent";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClientRootMcpServer } from "@expert-council/mcp-server";
import type { PiSdkLike } from "@expert-council/pi-runtime";

declare const BUNDLED_PI_SDK_VERSION: string;

const server = createClientRootMcpServer({
  cwd: process.env.EXPERT_COUNCIL_WORKSPACE,
  roleDirectory: fileURLToPath(new URL("./roles", import.meta.url)),
  sdk: bundledPiSdk as unknown as PiSdkLike,
  sdkPackageName: `@earendil-works/pi-coding-agent:bundled-${BUNDLED_PI_SDK_VERSION}`,
});
await server.connect(new StdioServerTransport());
