import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MODEL_ASSESSMENT_JSON_SCHEMA,
  modelAssessmentSnapshotSchema,
  type ExpertCouncil,
} from "../packages/core/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import { MCP_INPUT_SCHEMAS, MCP_TOOL_NAMES, withMcpTimeout } from "../packages/mcp-server/src/index.js";
import piExtension from "../packages/pi-package/src/extension.js";

function mockCouncil(): ExpertCouncil {
  const completed = { status: "success" as const, role: "reviewer" as const, model: "p/m", summary: "ok" };
  const assessment = {
    asOf: "2026-09-01T00:00:00.000Z",
    sources: ["https://livebench.ai/"],
    models: { "p/m": { coding: 8 } },
  };
  return {
    inspectResources: async () => ({
      models: [{ provider: "p", id: "m", available: true }],
      skills: [],
      billing: {},
      modelAssessment: assessment,
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
    waitForResults: async ({ executionIds, mode = "all" }) => ({
      status: "completed",
      mode,
      completed: executionIds,
      running: [],
      notFound: [],
      waitedMs: 0,
    }),
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
      "expert_wait",
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
    expect(MCP_INPUT_SCHEMAS.expert_build.modelAssessment.safeParse({
      asOf: "2026-09-01T00:00:00.000Z",
      sources: Array.from({ length: 13 }, (_, index) => `https://example.com/source-${index}`),
      models: { "p/model": { coding: 8 } },
    }).success).toBe(false);
    for (const candidate of [
      { asOf: "2026-09-01T00:00:00.000Z", sources: ["https://livebench.ai/"], models: {} },
      { asOf: "2026-09-01T00:00:00.000Z", sources: ["https://livebench.ai/"], models: { "p/model": {} } },
    ]) {
      expect(MCP_INPUT_SCHEMAS.expert_build.modelAssessment.safeParse(candidate).success)
        .toBe(modelAssessmentSnapshotSchema.safeParse(candidate).success);
    }
    expect((MODEL_ASSESSMENT_JSON_SCHEMA.properties as Record<string, { minProperties?: number }>).models.minProperties).toBe(1);
    expect(MCP_INPUT_SCHEMAS.expert_inspect.detail.safeParse("compact").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_inspect.detail.safeParse("everything").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.role.safeParse("lead").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.taskDescription.safeParse("Review authentication").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.taskDescription.safeParse("x".repeat(501)).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.workspace.safeParse("bad\0path").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.task.safeParse("x".repeat(100_001)).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_result.executionId.safeParse("../outside").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_wait.executionIds.safeParse(["exec_one", "exec_two"]).success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_wait.executionIds.safeParse(["exec_one", "exec_one"]).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_wait.timeoutMs.safeParse(999).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_wait.timeoutMs.safeParse(120_000).success).toBe(true);
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

describe("Codex plugin packaging", () => {
  it("uses a plugin-relative cwd without relying on MCP argument interpolation", () => {
    const mcpFile = JSON.parse(
      readFileSync("packages/codex-integration/plugin/expert-council/.mcp.json", "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string }>;
    };
    const server = mcpFile.mcpServers.expert_council;

    expect(server).toMatchObject({
      command: "node",
      args: ["dist/server.mjs"],
      cwd: ".",
    });
    expect(JSON.stringify(server)).not.toContain("${PLUGIN_ROOT}");
    expect(mcpFile.mcpServers).not.toHaveProperty("expert-council");
  });
});

describe("Pi adapter registration", () => {
  it("documents shell-safe local Pi installation and removal commands", () => {
    const readme = readFileSync("README.md", "utf8");
    const chineseReadme = readFileSync("README.zh-CN.md", "utf8");
    for (const document of [readme, chineseReadme]) {
      expect(document).toContain('pi install "./packages/pi-package"');
      expect(document).toContain('pi remove "./packages/pi-package"');
      expect(document).not.toContain("pi remove .\\packages\\pi-package");
    }
  });

  it("pins the tested Pi host and TypeBox peer ranges", () => {
    const manifest = JSON.parse(readFileSync("packages/pi-package/package.json", "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.84.0 <1");
    expect(manifest.peerDependencies.typebox).toBe("^1.3.7");
  });

  it("packages only the completion workflow supported by each host", () => {
    const sharedSkill = readFileSync("shared/skills/expert-council/SKILL.md", "utf8");
    const piSkill = readFileSync("packages/pi-package/skills/expert-council/SKILL.md", "utf8");
    const codexSkill = readFileSync(
      "packages/codex-integration/plugin/expert-council/skills/expert-council/SKILL.md",
      "utf8",
    );

    expect(sharedSkill).not.toContain("expert_wait");
    expect(piSkill).not.toContain("expert_wait");
    expect(piSkill).toContain("`steer`");
    expect(piSkill).toContain("`followUp`");
    expect(codexSkill).toContain("`expert_wait`");
    expect(codexSkill).not.toContain("`steer`");
    expect(codexSkill).not.toContain("`followUp`");
  });

  it("registers only the semantic Expert Council tools", () => {
    const names: string[] = [];
    piExtension({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
    expect(names).toEqual(MCP_TOOL_NAMES.filter((name) => name !== "expert_wait"));
  });

  it("refuses to build before the mandatory model assessment is complete", async () => {
    type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
    const tools = new Map<string, Tool>();
    let buildCalls = 0;
    const council: ExpertCouncil = {
      ...mockCouncil(),
      inspectResources: async () => ({
        models: [{ provider: "p", id: "m", available: true }],
        skills: [],
        billing: { p: { billingType: "unknown" } },
        roles: [],
        runtimeCapabilities: (await mockCouncil().inspectResources()).runtimeCapabilities,
        warnings: [],
      }),
      buildCouncil: async (request) => {
        buildCalls += 1;
        return { id: "unexpected", taskClass: "normal", task: request.task, experts: [], createdAt: "now", warnings: [] };
      },
    };
    piExtension({
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      appendEntry: () => {},
    } as never, { councilFor: async () => council });

    const result = await tools.get("expert_build")!.execute(
      "call",
      { task: "review", costPolicy: "balanced" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => [] } },
    );
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "model-assessment-required",
      assessmentStatus: "required",
      reason: "missing",
      requiredModels: ["p/m"],
    });
    expect(buildCalls).toBe(0);
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
