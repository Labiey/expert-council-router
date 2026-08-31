import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCouncilConfig } from "../packages/core/src/index.js";
import { PiExpertRuntime, type PiSdkLike } from "../packages/pi-runtime/src/index.js";

const originalRoleDir = process.env.EXPERT_COUNCIL_ROLE_DIR;

afterEach(() => {
  if (originalRoleDir === undefined) delete process.env.EXPERT_COUNCIL_ROLE_DIR;
  else process.env.EXPERT_COUNCIL_ROLE_DIR = originalRoleDir;
});

describe("Pi runtime adapter", () => {
  it("discovers runtime models and enforces read-only tool removal", async () => {
    process.env.EXPERT_COUNCIL_ROLE_DIR = path.resolve("packages/core/src/roles/prompts");
    let sessionOptions: Record<string, unknown> | undefined;
    const nativeModel = { provider: "p", id: "m" };
    const modelRuntime = {
      getAvailable: async () => [{
        provider: "p",
        id: "m",
        name: "Mock",
        reasoning: true,
        contextWindow: 100_000,
        maxTokens: 4_000,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }],
      getModel: () => nativeModel,
    };
    const sdk: PiSdkLike = {
      ModelRuntime: { create: async () => modelRuntime },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options) => {
        sessionOptions = options;
        return {
          session: {
            prompt: async () => {},
            waitForIdle: async () => {},
            dispose: () => {},
            getAvailableThinkingLevels: () => ["low"],
            setThinkingLevel: () => {},
            state: {
              messages: [{
                role: "assistant",
                content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "scouted", findings: ["x"] }) }],
              }],
            },
          },
        };
      },
    };
    const runtime = await PiExpertRuntime.create({
      cwd: process.cwd(),
      config: parseCouncilConfig({}),
      sdk,
      modelRuntime,
    });
    expect(await runtime.listAvailableModels()).toMatchObject([{ provider: "p", id: "m", displayName: "Mock" }]);
    const result = await runtime.executeExpert({
      role: "scout",
      task: "Find the entrypoint",
      model: "p/m",
      tools: ["read", "grep", "edit", "write"],
      skills: [],
      reasoningLevel: "low",
      readOnly: false,
      workspace: process.cwd(),
      timeoutMs: 1_000,
      attempt: 1,
    });
    expect(result).toMatchObject({ status: "success", summary: "scouted", findings: ["x"] });
    expect(sessionOptions?.tools).toEqual(["read", "grep"]);
    expect(sessionOptions?.model).toBe(nativeModel);
  });
});
