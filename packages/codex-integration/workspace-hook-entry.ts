import { recordCodexWorkspace } from "./workspace-record.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await recordCodexWorkspace(input);
} catch {
  // Workspace discovery remains fail-closed in the MCP server. A hook must never
  // emit task context or block the host merely because its input was malformed.
}
