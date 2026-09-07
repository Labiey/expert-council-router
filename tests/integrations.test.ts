import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  MODEL_ASSESSMENT_JSON_SCHEMA,
  modelAssessmentSnapshotSchema,
  type ExpertCouncil,
} from "../packages/core/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import {
  createClientRootMcpServer,
  CODEX_SANDBOX_STATE_META_CAPABILITY,
  MCP_INPUT_SCHEMAS,
  MCP_TOOL_NAMES,
  workspaceRootFromCodexSandbox,
  withMcpTimeout,
} from "../packages/mcp-server/src/index.js";
import piExtension from "../packages/pi-package/src/extension.js";

function codexSandboxMeta(workspace: string) {
  return {
    [CODEX_SANDBOX_STATE_META_CAPABILITY]: {
      sandboxCwd: pathToFileURL(workspace).href,
      permissionProfile: {
        type: "managed",
        network: "restricted",
        file_system: { type: "restricted", entries: [] },
      },
    },
  };
}

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
      routePolicy: { sessionKey: "default", effective: {} },
      warnings: [],
    }),
    buildCouncil: async (request) => ({ id: "c", taskClass: "normal", task: request.task, experts: [], createdAt: "now", warnings: [] }),
    delegate: async (request) => ({ status: "success", role: request.role, model: "p/m", summary: "ok" }),
    startDelegation: () => ({ executionId: "exec_mock", result: Promise.resolve(completed) }),
    inspectExecution: async () => undefined,
    abortExecution: async (request) => ({ executionId: request.executionId, status: "already-finished" }),
    setRoutePolicy: async (policy) => ({
      ...(policy.allow?.length ? { allow: policy.allow } : {}),
      ...(policy.deny?.length ? { deny: policy.deny } : {}),
      excludedModels: [],
    }),
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
      "expert_abort",
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
  it("ships a repo marketplace entry for CLI-managed installation", () => {
    const marketplace = JSON.parse(readFileSync(".agents/plugins/marketplace.json", "utf8"));
    expect(marketplace).toMatchObject({
      name: "expert-council-router",
      interface: { displayName: "Expert Council" },
      plugins: [{
        name: "expert-council",
        source: {
          source: "local",
          path: "./packages/codex-integration/plugin/expert-council",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Developer Tools",
      }],
    });
    expect(existsSync("packages/codex-integration/plugin/expert-council/dist/server.mjs")).toBe(true);
    expect(existsSync("packages/codex-integration/plugin/expert-council/THIRD_PARTY_NOTICES.md")).toBe(true);
  });

  it("documents CLI-managed install, verification, upgrade, and removal", () => {
    for (const document of [
      readFileSync("README.md", "utf8"),
      readFileSync("README.zh-CN.md", "utf8"),
    ]) {
      expect(document).toContain("codex plugin marketplace add Labiey/expert-council-router --ref v0.5.6 --json");
      expect(document).toContain("codex plugin marketplace list --json");
      expect(document).toContain("codex plugin list --marketplace expert-council-router --available --json");
      expect(document).toContain("codex plugin add expert-council@expert-council-router --json");
      expect(document).toContain("codex plugin remove expert-council@expert-council-router --json");
      expect(document).toContain("codex plugin marketplace remove expert-council-router --json");
      expect(document).toContain("expert_inspect");
    }
  });

  it("advertises the prebuilt remote install in both quick-start sections", () => {
    const english = readFileSync("README.md", "utf8")
      .match(/### Install the Codex plugin \(optional\)([\s\S]*?)### Build from source/)?.[1];
    const chinese = readFileSync("README.zh-CN.md", "utf8")
      .match(/### 安装 Codex 插件（可选）([\s\S]*?)### 从源码构建/)?.[1];

    for (const section of [english, chinese]) {
      expect(section).toContain("codex plugin marketplace add Labiey/expert-council-router --ref v0.5.6 --json");
      expect(section).toContain("codex plugin add expert-council@expert-council-router --json");
    }
  });

  it("uses a plugin-relative cwd without relying on MCP argument interpolation", () => {
    const mcpFile = JSON.parse(
      readFileSync("packages/codex-integration/plugin/expert-council/.mcp.json", "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env_vars?: string[] }>;
    };
    const server = mcpFile.mcpServers.expert_council;

    expect(server).toMatchObject({
      command: "node",
      args: ["dist/server.mjs"],
      cwd: ".",
    });
    expect(server.env_vars).toBeUndefined();
    expect(JSON.stringify(server)).not.toContain("${PLUGIN_ROOT}");
    expect(mcpFile.mcpServers).not.toHaveProperty("expert-council");
    expect(existsSync("packages/codex-integration/plugin/expert-council/hooks/hooks.json")).toBe(false);
    expect(existsSync("packages/codex-integration/plugin/expert-council/hooks/record-workspace.mjs")).toBe(false);
  });

  it("derives the project root from trusted Codex sandbox metadata", async () => {
    const workspace = await realpath(process.cwd());
    const nestedWorkspace = path.join(workspace, "packages", "mcp-server");
    expect(workspaceRootFromCodexSandbox({ _meta: codexSandboxMeta(nestedWorkspace) }))
      .toBe(workspace);
    expect(workspaceRootFromCodexSandbox({})).toBeUndefined();
    expect(() => workspaceRootFromCodexSandbox({
      _meta: codexSandboxMeta(workspace),
      requestInfo: { _meta: codexSandboxMeta(path.dirname(workspace)) },
    })).toThrow("conflicting sandbox metadata");
  });

  it("uses MCP client roots as trusted workspace boundaries", async () => {
    const workspace = process.cwd();
    let receivedOptions: { cwd?: string; trustedWorkspaceRoots?: string[] } | undefined;
    const server = createClientRootMcpServer({}, async (options) => {
      receivedOptions = options;
      return mockCouncil();
    });
    const client = new Client(
      { name: "roots-test", version: "0.1.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({ name: "expert_inspect", arguments: {} });
      expect(receivedOptions).toMatchObject({
        cwd: workspace,
        trustedWorkspaceRoots: [workspace],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed when the MCP client exposes no workspace roots", async () => {
    let factoryCalled = false;
    const server = createClientRootMcpServer({}, async () => {
      factoryCalled = true;
      return mockCouncil();
    });
    const client = new Client({ name: "no-roots-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "expert_inspect", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("No trusted local workspace") }),
      ]));
      expect(factoryCalled).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses Codex sandbox metadata when the MCP client does not implement roots", async () => {
    const workspace = await realpath(process.cwd());
    let receivedOptions: { cwd?: string; trustedWorkspaceRoots?: string[] } | undefined;
    const server = createClientRootMcpServer({}, async (options) => {
      receivedOptions = options;
      return mockCouncil();
    });
    const client = new Client({ name: "codex-sandbox-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getServerCapabilities()?.experimental)
        .toHaveProperty(CODEX_SANDBOX_STATE_META_CAPABILITY);
      const result = await client.callTool({
        name: "expert_inspect",
        arguments: {},
        _meta: codexSandboxMeta(workspace),
      });
      expect(result.isError).not.toBe(true);
      expect(receivedOptions).toMatchObject({
        cwd: workspace,
        trustedWorkspaceRoots: [workspace],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("route policy via file, not tools", () => {
  it("exposes no policy tool and carries the route-policy view through inspect", async () => {
    expect(MCP_TOOL_NAMES).not.toContain("expert_policy");

    const server = createClientRootMcpServer({ cwd: process.cwd() }, async () => mockCouncil());
    const client = new Client({ name: "policy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inspect = await client.callTool({ name: "expert_inspect", arguments: {} });
      expect(inspect.isError).not.toBe(true);
      expect(JSON.stringify(inspect.content)).toContain("routePolicy");
      const rejected = await client.callTool({ name: "expert_policy", arguments: { deny: ["q"] } });
      expect(rejected.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("expert_abort tool", () => {
  it("validates its schema and routes through the shared council", async () => {
    expect(MCP_INPUT_SCHEMAS.expert_abort.executionId.safeParse("exec_1").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_abort.reason.safeParse("wrong direction").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_abort.reason.safeParse("").success).toBe(false);

    const server = createClientRootMcpServer({ cwd: process.cwd() }, async () => mockCouncil());
    const client = new Client({ name: "abort-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "expert_abort",
        arguments: { executionId: "exec_mock", reason: "wrong direction" },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("already-finished");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("cost policy reminders", () => {
  it("reminds the host to establish a cost policy until one is supplied", async () => {
    const server = createClientRootMcpServer({ cwd: process.cwd() }, async () => mockCouncil());
    const client = new Client({ name: "cost-policy-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const first = await client.callTool({
        name: "expert_delegate",
        arguments: { role: "scout", task: "Inspect a tiny file", timeoutMs: 60000 },
      });
      expect(JSON.stringify(first.content)).toContain("Ask the user once whether to optimize for economy, balanced, or speed");

      const build = await client.callTool({
        name: "expert_build",
        arguments: { task: "Implement a small bounded feature", constraints: { costPolicy: "balanced" } },
      });
      expect(build.isError).not.toBe(true);
      expect(JSON.stringify(build.content)).not.toContain("Ask the user once whether to optimize");

      const second = await client.callTool({
        name: "expert_delegate",
        arguments: { role: "scout", task: "Inspect another tiny file", timeoutMs: 60000 },
      });
      expect(JSON.stringify(second.content)).not.toContain("Ask the user once whether to optimize");
    } finally {
      await client.close();
      await server.close();
    }
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
