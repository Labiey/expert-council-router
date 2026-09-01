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

  it.each([
    ["--max-experts", "abc"],
    ["--max-experts", "4abc"],
    ["--max-experts", "0"],
    ["--max-experts", "9"],
  ])("rejects an invalid CLI numeric option %s=%s", async (name, value) => {
    let stderr = "";
    const code = await runCli(["build", "review", name, value, "--json"], {
      stdout: { write: () => {} },
      stderr: { write: (output) => { stderr += output; } },
    }, mockCouncil());
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain(`${name} must be an integer`);
  });

  it.each(["abc", "1000ms", "999", "3600001"])("rejects invalid --timeout-ms=%s", async (value) => {
    let stderr = "";
    const code = await runCli(["delegate", "scout", "review", "--timeout-ms", value, "--json"], {
      stdout: { write: () => {} },
      stderr: { write: (output) => { stderr += output; } },
    }, mockCouncil());
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("--timeout-ms must be an integer");
  });

  it("rejects a numeric option with no value", async () => {
    let stderr = "";
    const code = await runCli(["build", "review", "--max-experts", "--json"], {
      stdout: { write: () => {} },
      stderr: { write: (output) => { stderr += output; } },
    }, mockCouncil());
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("--max-experts must be an integer");
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
    expect(MCP_INPUT_SCHEMAS.expert_build.constraints.unwrap().shape.costPolicy.safeParse("speed").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_build.modelAssessment.safeParse({
      asOf: "2026-09-01T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/model": { coding: 8, speed: 7 } },
      billing: { p: { billingType: "subscription", marginalCostClass: "very-low" } },
    }).success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_inspect.detail.safeParse("compact").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_inspect.detail.safeParse("everything").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.role.safeParse("lead").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.taskDescription.safeParse("Review authentication").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.taskDescription.safeParse("x".repeat(501)).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.workspace.safeParse("bad\0path").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.task.safeParse("x".repeat(100_001)).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_result.executionId.safeParse("../outside").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.assignments.safeParse([
      { role: "scout", task: "map files" },
      { role: "reviewer", task: "review findings" },
    ]).success).toBe(true);
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
    const sessionEntries: Array<{ type: string; customType: string; data: unknown }> = [];
    piExtension({
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      appendEntry: (customType: string, data: unknown) => sessionEntries.push({ type: "custom", customType, data }),
    } as never, { councilFor: async () => council });

    const firstAttempt = await tools.get("expert_build")!.execute(
      "call",
      { task: "review" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => sessionEntries } },
    );
    expect(JSON.parse(firstAttempt.content[0]!.text)).toMatchObject({ status: "preference-required" });
    expect(received).toBeUndefined();

    await tools.get("expert_build")!.execute(
      "call",
      { task: "review", minimumContextWindow: 128_000, costPolicy: "speed" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => sessionEntries } },
    );

    expect(received?.constraints?.minimumContextWindow).toBe(128_000);
    expect(received?.constraints?.costPolicy).toBe("speed");

    received = undefined;
    await tools.get("expert_build")!.execute(
      "call",
      { task: "review again" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => sessionEntries } },
    );
    expect(received?.constraints?.costPolicy).toBe("speed");
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

  it("dispatches a complete independent batch before returning", async () => {
    type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
    const tools = new Map<string, Tool>();
    const received: Array<{ role: string; task: string }> = [];
    let nextId = 0;
    const council: ExpertCouncil = {
      ...mockCouncil(),
      startDelegation: (request) => {
        received.push(request);
        nextId += 1;
        return {
          executionId: `exec_batch_${nextId}`,
          result: new Promise(() => {}),
        };
      },
    };
    piExtension({
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      sendMessage: () => {},
    } as never, { councilFor: async () => council });

    const delegated = await tools.get("expert_delegate")!.execute(
      "call",
      { assignments: [
        { role: "scout", task: "map files", taskDescription: "repository map" },
        { role: "reviewer", task: "review findings" },
      ] },
      undefined,
      undefined,
      { cwd: ".", isIdle: () => false },
    );

    expect(received.map(({ role, task }) => ({ role, task }))).toEqual([
      { role: "scout", task: "map files" },
      { role: "reviewer", task: "review findings" },
    ]);
    expect(JSON.parse(delegated.content[0]!.text)).toEqual({
      status: "running",
      executions: [
        { executionId: "exec_batch_1", role: "scout", taskDescription: "repository map", status: "running" },
        { executionId: "exec_batch_2", role: "reviewer", status: "running" },
      ],
    });
  });
});
