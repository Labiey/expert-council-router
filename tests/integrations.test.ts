import { describe, expect, it } from "vitest";
import type { ExpertCouncil } from "../packages/core/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import { MCP_INPUT_SCHEMAS, MCP_TOOL_NAMES } from "../packages/mcp-server/src/index.js";
import piExtension from "../packages/pi-package/src/extension.js";

function mockCouncil(): ExpertCouncil {
  return {
    inspectResources: async () => ({
      models: [{ provider: "p", id: "m", available: true }],
      skills: [],
      billing: {},
      roles: [],
      runtimeCapabilities: {
        hostType: "mock",
        modelDiscovery: true,
        hardToolRestriction: true,
        skillOverride: true,
        subagentBackend: true,
        mutation: false,
        workspaceIsolation: "none",
        supportedTools: [],
        limitations: [],
      },
      warnings: [],
    }),
    buildCouncil: async (request) => ({ id: "c", taskClass: "normal", task: request.task, experts: [], createdAt: "now", warnings: [] }),
    delegate: async (request) => ({ status: "success", role: request.role, model: "p/m", summary: "ok" }),
    escalate: async () => ({ action: "stop", reason: "done" }),
    getStatus: async () => ({ plans: [], executions: [], telemetry: [] }),
    recordOutcome: async () => {},
  };
}

describe("CLI JSON integration", () => {
  it("uses the shared council service and emits machine-readable JSON", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["models", "--json"], {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    }, mockCouncil());
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ provider: "p", id: "m", available: true }]);
    expect(stderr).toBe("");
  });
});

describe("MCP semantic surface", () => {
  it("keeps five stable semantic tools and validates schemas", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "expert_inspect",
      "expert_build",
      "expert_delegate",
      "expert_escalate",
      "expert_status",
    ]);
    expect(MCP_INPUT_SCHEMAS.expert_build.task.safeParse("fix race").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.role.safeParse("lead").success).toBe(false);
  });
});

describe("Pi adapter registration", () => {
  it("registers only the semantic Expert Council tools", () => {
    const names: string[] = [];
    piExtension({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
    expect(names).toEqual([...MCP_TOOL_NAMES]);
  });
});
