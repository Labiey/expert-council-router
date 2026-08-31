import { describe, expect, it } from "vitest";
import type { ExpertCouncil } from "../packages/core/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import { MCP_INPUT_SCHEMAS, MCP_TOOL_NAMES, withMcpTimeout } from "../packages/mcp-server/src/index.js";
import piExtension from "../packages/pi-package/src/extension.js";

function mockCouncil(): ExpertCouncil {
  const completed = { status: "success" as const, role: "reviewer" as const, model: "p/m", summary: "ok" };
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
    startDelegation: () => ({ executionId: "exec_mock", result: Promise.resolve(completed) }),
    getResult: async (executionId) => ({ executionId, status: "completed", result: completed }),
    recordFeedback: async ({ executionId, verificationPassed }) => ({ executionId, status: "recorded", verificationPassed }),
    cleanup: async (executionId) => ({ executionId, status: "not-required" }),
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

  it("records verification feedback through the shared council service", async () => {
    let stdout = "";
    const code = await runCli(["feedback", "exec_mock", "--verification", "passed", "--json"], {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: () => {} },
    }, mockCouncil());
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ executionId: "exec_mock", status: "recorded", verificationPassed: true });
  });
});

describe("MCP semantic surface", () => {
  it("keeps the asynchronous semantic tools and validates schemas", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "expert_inspect",
      "expert_build",
      "expert_delegate",
      "expert_result",
      "expert_feedback",
      "expert_cleanup",
      "expert_escalate",
      "expert_status",
    ]);
    expect(MCP_INPUT_SCHEMAS.expert_build.task.safeParse("fix race").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.role.safeParse("lead").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.taskDescription.safeParse("Review authentication").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.taskDescription.safeParse("x".repeat(501)).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_feedback.verificationPassed.safeParse(true).success).toBe(true);
  });

  it("bounds a stalled MCP operation", async () => {
    await expect(withMcpTimeout(new Promise(() => {}), 20)).rejects.toThrow("timed out after 20ms");
  });
});

describe("Pi adapter registration", () => {
  it("registers only the semantic Expert Council tools", () => {
    const names: string[] = [];
    piExtension({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
    expect(names).toEqual([...MCP_TOOL_NAMES]);
  });

  it("forwards the MCP-compatible minimum context constraint", async () => {
    type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
    const tools = new Map<string, Tool>();
    let received: Parameters<ExpertCouncil["buildCouncil"]>[0] | undefined;
    const council: ExpertCouncil = {
      ...mockCouncil(),
      buildCouncil: async (request) => {
        received = request;
        return { id: "c", taskClass: "normal", task: request.task, experts: [], createdAt: "now", warnings: [] };
      },
    };
    piExtension({
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
    } as never, { councilFor: async () => council });

    await tools.get("expert_build")!.execute(
      "call",
      { task: "review", minimumContextWindow: 128_000 },
      undefined,
      undefined,
      { cwd: "." },
    );

    expect(received?.constraints?.minimumContextWindow).toBe(128_000);
  });

  it.each([
    { idleAtCompletion: false, expectedDelivery: "steer", taskDescription: "Review authentication changes" },
    { idleAtCompletion: true, expectedDelivery: "followUp", taskDescription: undefined },
  ])("pushes a compact completed-task notification using $expectedDelivery", async ({
    idleAtCompletion,
    expectedDelivery,
    taskDescription,
  }) => {
    type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
    const tools = new Map<string, Tool>();
    const messages: Array<{ message: { content: string }; options: { deliverAs: string; triggerTurn: boolean } }> = [];
    let finish!: (value: { status: "success"; role: "reviewer"; model: string; summary: string }) => void;
    const pending = new Promise<Parameters<typeof finish>[0]>((resolve) => {
      finish = resolve;
    });
    let completedResult: Parameters<typeof finish>[0] | undefined;
    const council: ExpertCouncil = {
      ...mockCouncil(),
      startDelegation: () => ({
        executionId: "exec_background",
        result: pending.then((result) => {
          completedResult = result;
          return result;
        }),
      }),
      getResult: async (executionId) => completedResult
        ? { executionId, status: "completed", result: completedResult }
        : { executionId, status: "running" },
    };
    let idle = false;
    piExtension({
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      sendMessage: (message: { content: string }, options: { deliverAs: string; triggerTurn: boolean }) => {
        messages.push({ message, options });
      },
    } as never, { councilFor: async () => council });

    const delegated = await tools.get("expert_delegate")!.execute(
      "call",
      { role: "reviewer", task: "review", ...(taskDescription ? { taskDescription } : {}) },
      undefined,
      undefined,
      { cwd: ".", isIdle: () => idle },
    );
    expect(JSON.parse(delegated.content[0]!.text)).toEqual({ executionId: "exec_background", status: "running" });
    expect(messages).toHaveLength(0);

    idle = idleAtCompletion;
    finish({ status: "success", role: "reviewer", model: "p/m", summary: "private feedback" });
    await pending;
    await Promise.resolve();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.options).toEqual({ deliverAs: expectedDelivery, triggerTurn: true });
    expect(JSON.parse(messages[0]!.message.content)).toEqual({
      executionId: "exec_background",
      ...(taskDescription ? { taskDescription } : {}),
    });

    const fetched = await tools.get("expert_result")!.execute(
      "call",
      { executionId: "exec_background" },
      undefined,
      undefined,
      { cwd: ".", isIdle: () => true },
    );
    expect(JSON.parse(fetched.content[0]!.text).result.summary).toBe("private feedback");
  });
});
