import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  MODEL_ASSESSMENT_JSON_SCHEMA,
  modelAssessmentSnapshotSchema,
  type CouncilStatus,
  type CouncilStatusView,
  type CouncilStatusViewResult,
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
import piExtension from "../packages/pi-package/src/extension.js"

// The release references in the documentation are checked against the version this repository
// actually publishes, so the assertion follows a release instead of freezing at one.
const releaseVersion = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }).version;;

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
    abortExecution: async (request) => ({ executionId: request.executionId, status: "already-finished" }),
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
    getStatus: async <V extends CouncilStatusView = "full">(): Promise<CouncilStatusViewResult<V>> => {
      // Every CLI path this mock feeds reads the legacy full payload, so the stub
      // answers each view with it; the assertion mirrors ExpertCouncilService.getStatus.
      const status: CouncilStatus = { plans: [], executions: [], telemetry: [] };
      return status as CouncilStatusViewResult<V>;
    },
    inspectExecution: async (executionId) => ({
      executionId,
      status: "running" as const,
      role: "scout" as const,
      model: "p/m",
      startedAt: "2026-09-11T00:00:00.000Z",
      elapsedMs: 0,
      messageCount: 0,
    }),
    respondToInteraction: async ({ executionId, response }) => ({ executionId, status: "resolved" as const, kind: response.kind }),
    recordOutcome: async () => {},
    resetAvailability: async () => ({ cleared: [] }),
    verifyCommand: async () => ({ exitCode: null, durationMs: 0 }),
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

  it("answers --version from its own manifest, with no council, runtime or config present", async () => {
    // Deliberately passes no council: an operator on a fresh machine with nothing configured
    // still needs to ask what is installed, and a literal version string here would pass tests
    // while lying about a release. Read the shipped manifest instead.
    const manifest = JSON.parse(
      readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
    ) as { version: string };
    let stdout = "";
    const io = { stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: () => {} } };
    expect(await runCli(["--version"], io)).toBe(0);
    expect(stdout.trim()).toBe(manifest.version);
    stdout = ""; // the fake io accumulates; the JSON case has to be read on its own
    expect(await runCli(["version", "--json"], io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ version: manifest.version });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    // And it must be listed, or the next person rediscover it by trial and error.
    let help = "";
    await runCli(["help"], { stdout: { write: (value: string) => { help += value; } }, stderr: { write: () => {} } });
    expect(help).toContain("--version");
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

  it.each(["abc", "1000ms", "999", "21600001"])("rejects invalid --timeout-ms=%s", async (value) => {
    let stderr = "";
    const code = await runCli(["delegate", "scout", "review", "--timeout-ms", value, "--json"], {
      stdout: { write: () => {} },
      stderr: { write: (output) => { stderr += output; } },
    }, mockCouncil());
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("--timeout-ms must be an integer");
    // The bound itself, stated by the code rather than by this test's memory of it: a delegation
    // whose window is sized for three long attempts is unusable if a host cannot ask for one.
    expect(JSON.parse(stderr).error).toContain("21600000");
  });

  it("requires an explicit --timeout-ms for delegate", async () => {
    let stderr = "";
    const code = await runCli(["delegate", "scout", "review", "--json"], {
      stdout: { write: () => {} },
      stderr: { write: (output) => { stderr += output; } },
    }, mockCouncil());
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("requires --timeout-ms");
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

  it("tells an operator what to pass when --reasoning-level is simply absent", async () => {
    // Defect #45: the flag is required on purpose, but `bounded("")` threw first, so the
    // actionable sentence under it was unreachable and the CLI answered its own documented
    // usage with a validator's complaint. Reachable guidance is part of the feature.
    let stderr = "";
    const code = await runCli(["delegate", "scout", "read one file", "--timeout-ms", "60000", "--json"], {
      stdout: { write: () => {} },
      stderr: { write: (output) => { stderr += output; } },
    }, mockCouncil());
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("delegate requires --reasoning-level");
    expect(JSON.parse(stderr).error.includes("NUL")).toBe(false);
  });

  it("refuses a reasoning level that is really the next flag", async () => {
    let stderr = "";
    const code = await runCli(
      ["delegate", "scout", "read one file", "--timeout-ms", "60000", "--reasoning-level", "--json"],
      {
        stdout: { write: () => {} },
        stderr: { write: (output) => { stderr += output; } },
      },
      mockCouncil(),
    );
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("delegate requires --reasoning-level");
  });
});

describe("CLI expert-window watch", () => {
  const event = (kind: string, extra: Record<string, unknown> = {}) => ({
    t: "2026-09-16T00:00:00.000Z",
    executionId: "exec_watch",
    role: "scout",
    kind,
    ...extra,
  });
  const line = (kind: string, extra?: Record<string, unknown>) => JSON.stringify(event(kind, extra));
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { stdout: { write: (value: string) => { out.push(value); } }, stderr: { write: (value: string) => { err.push(value); } } },
      out,
      err,
    };
  };
  const withStream = async (contents: string, run: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ec-watch-"));
    try {
      await writeFile(path.join(dir, "exec_watch.jsonl"), contents, "utf8");
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("renders a finished stream through the injected formatter and exits", async () => {
    await withStream(`${line("started")}\n${line("tool_started", { tool: "read" })}\n${line("completed", { status: "success" })}\n`, async (dir) => {
      const { io, out } = capture();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir],
        io,
        undefined,
        { formatEvent: (frame) => `FMT ${frame.kind}` },
      );
      expect(code).toBe(0);
      expect(out.join("")).toBe("FMT started\nFMT tool_started\nFMT completed\n");
    });
  });

  it("drains a stream larger than one read chunk when not following", async () => {
    // The non-following reader used to take exactly one pass, so a stream past the 1 MiB chunk -
    // trivial to reach once the content dials are on - was printed only in part, silently.
    const records: string[] = [];
    for (let index = 0; index < 12000; index += 1) {
      records.push(JSON.stringify({
        t: index, executionId: "exec_watch", kind: "assistant_text", text: "x".repeat(120),
      }));
    }
    const body = records.join(String.fromCharCode(10)) + String.fromCharCode(10);
    expect(Buffer.byteLength(body)).toBeGreaterThan(1048576);
    await withStream(body, async (dir) => {
      const { io, out } = capture();
      const code = await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--json"], io);
      expect(code).toBe(0);
      expect(out.join("").trimEnd().split(String.fromCharCode(10))).toHaveLength(records.length);
    });
  });

  it("emits raw objects with --json and never touches the formatter", async () => {
    await withStream(`${line("assistant_text", { text: "reading" })}\n`, async (dir) => {
      const { io, out } = capture();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--json"],
        io,
        undefined,
        { formatEvent: () => { throw new Error("--json must not render"); } },
      );
      expect(code).toBe(0);
      expect(out.join("")).toBe(`${line("assistant_text", { text: "reading" })}\n`);
    });
  });

  it("lists available streams when --exec is missing or unknown", async () => {
    await withStream(`${line("started")}\n`, async (dir) => {
      const missing = capture();
      expect(await runCli(["watch", "--dir", dir], missing.io, undefined, { formatEvent: (frame) => frame.kind })).not.toBe(0);
      expect(missing.err.join("")).toContain("requires --exec");
      expect(missing.err.join("")).toContain("exec_watch");

      const unknown = capture();
      expect(await runCli(["watch", "--exec", "exec_none", "--dir", dir], unknown.io, undefined, { formatEvent: (frame) => frame.kind })).not.toBe(0);
      expect(unknown.err.join("")).toContain('expertWindow');
    });
  });

  it("holds back a trailing line that is still being written", async () => {
    await withStream(`${line("started")}\n{"kind":"assistant_text","tex`, async (dir) => {
      const { io, out, err } = capture();
      const code = await runCli(["watch", "--exec", "exec_watch", "--dir", dir], io, undefined, { formatEvent: (frame) => frame.kind });
      expect(code).toBe(0);
      expect(out.join("")).toBe("started\n");
      expect(err.join("")).toContain("held back");
    });
  });

  it("says the delegation is still open when its own follow window expires", async () => {
    // An attempt-level `failed` is not the end of the story: the council escalates to another model
    // and keeps appending to the same stream. When the follower's own budget runs out first it must
    // not report that stale attempt outcome as the reason for closing. It did, over a delegation that
    // was still streaming on its third attempt, and the operator reasonably read it as a failure.
    await withStream(`${line("started")}\n${line("failed", { status: "failed", failureType: "provider_error" })}\n`, async (dir) => {
      const { io, err } = capture();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--interval-ms", "50",
         "--timeout-ms", "1000", "--quiet-ms", "600000"],
        io,
        undefined,
        { formatEvent: (frame) => frame.kind },
      );
      expect(code).toBe(0);
      const message = err.join("");
      expect(message).toContain("stopped after --timeout-ms 1000");
      expect(message).toContain("still open");
      expect(message).toContain('last attempt-level event was "failed"');
      // The bare form is the lie this replaces.
      expect(message).not.toContain("stream closed (failed)");

      // The raised ceiling must actually be the ceiling, or a delegation whose window is sized for
      // three long attempts cannot be followed at all.
      const tooLong = capture();
      expect(await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--timeout-ms", "30000000"],
        tooLong.io,
      )).toBe(1);
      expect(tooLong.err.join("")).toContain("21600000");
    });
  });

  it("stops following at a terminal event without burning the timeout", async () => {
    await withStream(`${line("started")}\n${line("failed", { status: "failed", failureType: "timeout" })}\n`, async (dir) => {
      const { io, err } = capture();
      const started = Date.now();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--interval-ms", "50", "--timeout-ms", "60000", "--quiet-ms", "750"],
        io,
        undefined,
        { formatEvent: (frame) => frame.kind },
      );
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(err.join("")).toContain("stream closed (failed, no final marker");
    });
  });

  it("follows a retried delegation through both attempts and closes on the final marker", async () => {
    const stream = [
      line("started", { attempt: 1 }),
      line("failed", { attempt: 1, status: "failed", failureType: "provider_error" }),
      line("started", { attempt: 2, model: "p/other" }),
      line("tool_started", { attempt: 2, tool: "grep" }),
      line("completed", { attempt: 2, status: "success" }),
      line("delegation_final", { role: "scout" }),
    ].join("\n") + "\n";
    await withStream(stream, async (dir) => {
      const { io, out, err } = capture();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--interval-ms", "50", "--timeout-ms", "8000"],
        io, undefined, { formatEvent: (frame) => `${frame.kind}${frame.attempt ? `#${frame.attempt}` : ""}` },
      );
      expect(code).toBe(0);
      expect(out.join("").trim().split("\n")).toEqual([
        "started#1", "failed#1", "started#2", "tool_started#2", "completed#2", "delegation_final",
      ]);
      // A final marker is a fact; the quiet-period fallback must not have been needed.
      expect(err.join("")).not.toContain("no final marker");
      // Defect #19: the closing line used to report the first attempt's terminal event, so
      // a delegation that failed once and then succeeded announced itself as "failed".
      expect(err.join("")).toContain("stream closed (delegation finished)");
    });
  });

  it("keeps the window open while a delegation escalates to another model", async () => {
    // Defect #17: the first per-attempt terminal event used to end the follow, so an
    // operator saw the failure and never saw the attempt that answered the task.
    await withStream(`${line("started", { attempt: 1 })}
${line("failed", { attempt: 1, status: "failed", failureType: "provider_error" })}
`, async (dir) => {
      const { io, out, err } = capture();
      const { appendFile } = await import("node:fs/promises");
      const file = path.join(dir, "exec_watch.jsonl");
      const running = runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--interval-ms", "50", "--timeout-ms", "8000"],
        io, undefined, { formatEvent: (frame) => frame.kind },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await appendFile(file, `${line("started", { attempt: 2 })}
${line("completed", { attempt: 2, status: "success" })}
${line("delegation_final")}
`, { encoding: "utf8" });
      expect(await running).toBe(0);
      expect(out.join("")).toContain("delegation_final");
      expect(out.join("")).toContain("completed");
      expect(err.join("")).not.toContain("no final marker");
    });
  });

  it("copies guardrail counters on an attention frame rather than dropping them", async () => {
    const frame = line("attention", {
      toolCalls: 7,
      toolErrors: 4,
      budgetFractionUsed: 0.85,
      nudgedExpert: true,
      text: "4 of 7 observed tool calls failed.",
    });
    await withStream(frame + String.fromCharCode(10), async (dir) => {
      const { io, out } = capture();
      const seen: Array<Record<string, unknown>> = [];
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir],
        io,
        undefined,
        { formatEvent: (received) => { seen.push({ ...(received as unknown as Record<string, unknown>) }); return received.kind; } },
      );
      expect(code).toBe(0);
      // Defect #22: the reader copies only fields it knows, so the counters were silently
      // lost between the file and the renderer - the same whitelist hazard as `attempt`.
      expect(seen[0]).toMatchObject({
        kind: "attention",
        toolCalls: 7,
        toolErrors: 4,
        budgetFractionUsed: 0.85,
        nudgedExpert: true,
      });
      expect(out.join("")).toBe("attention" + String.fromCharCode(10));
    });
  });

  it("carries every field a real runtime writes, checked against live stream keys", async () => {
    // Audit rather than hope: these are the keys actually observed in streams written by
    // the runtime (plus `nudgedExpert` and `argsSummary`, which it can also emit). Every
    // one must survive the CLI's frame parser, whose whole design is to copy only fields
    // it knows - which is exactly how `attempt` and the guardrail counters were lost.
    const full = {
      model: "p/m",
      attempt: 2,
      tool: "bash",
      ok: false,
      status: "failed",
      failureType: "tool_call_error",
      durationMs: 9000,
      text: "3 consecutive tool calls failed (3 of 3 observed).",
      argsSummary: "cmd=npm test",
      toolCalls: 3,
      toolErrors: 3,
      budgetFractionUsed: 0.85,
      nudgedExpert: true,
      streaming: true,
      omittedBytes: 1234,
      line: 42,
      argsText: '{"command":"npm test"}',
    };
    const expectedKeys = ["t", "executionId", "role", "kind", ...Object.keys(full)];
    await withStream(line("attention", full) + String.fromCharCode(10), async (dir) => {
      const { io } = capture();
      const frames: Array<Record<string, unknown>> = [];
      const code = await runCli(["watch", "--exec", "exec_watch", "--dir", dir], io, undefined, {
        formatEvent: (frame) => { frames.push({ ...(frame as unknown as Record<string, unknown>) }); return frame.kind; },
      });
      expect(code).toBe(0);
      expect(frames).toHaveLength(1);
      const received = frames[0]!;
      const missing = expectedKeys.filter((key) => !(key in received));
      expect(missing).toEqual([]);
      expect(received.toolErrors).toBe(3);
      expect(received.attempt).toBe(2);
      expect(received.streaming).toBe(true);
      expect(received.line).toBe(42);
      expect(received.omittedBytes).toBe(1234);
      expect(received.argsText).toContain("npm test");
    });
  });

  it("shows only the configured tail of a recorded content block", async () => {
    // The stream carries the whole payload; the window decides how much to print. This is
    // that decision, asserted at the boundary the operator actually sees.
    const text = [1, 2, 3, 4, 5, 6].map((index) => `output line ${index}`).join("\n");
    await withStream(`${line("tool_output", { tool: "bash", ok: true, line: 7, text })}
`, async (dir) => {
      const { io, out } = capture();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--max-lines", "2", "--max-chars", "40"],
        io,
        undefined,
        { formatEvent: (frame) => `HEADER ${frame.kind}` },
      );
      expect(code).toBe(0);
      const shown = out.join("");
      expect(shown).toContain("output line 6");
      expect(shown).toContain("output line 5");
      expect(shown).not.toContain("output line 4");
      expect(shown).toContain("4 earlier lines not shown");
      expect(shown).toContain("HEADER tool_output");
    });
  });

  it("caps a single enormous recorded line instead of wrapping the console", async () => {
    await withStream(`${line("assistant_text", { text: "y".repeat(5000) })}
`, async (dir) => {
      const { io, out } = capture();
      await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--max-chars", "30"],
        io,
        undefined,
        { formatEvent: (frame) => frame.kind },
      );
      const body = out.join("").split("\n").find((entry) => entry.trimStart().startsWith("y")) ?? "";
      expect(body.trim().length).toBeLessThanOrEqual(30);
    });
  });

  it("does not mistake an expert's silence for a dead stream (defect #23)", async () => {
    // A terminal event followed by a long pause is the ordinary shape of a model thinking
    // or a build running. Only the final marker, or the operator's own --timeout-ms, may
    // end the follow; the quiet fallback has to be generous enough to survive silence.
    await withStream(`${line("started")}` + String.fromCharCode(10) + line("failed", { status: "failed", failureType: "timeout" }) + String.fromCharCode(10), async (dir) => {
      const { io, err } = capture();
      const { appendFile } = await import("node:fs/promises");
      let settled: number | undefined;
      const running = runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--interval-ms", "100", "--timeout-ms", "20000"],
        io, undefined, { formatEvent: (frame) => frame.kind },
      ).then((code) => { settled = code; return code; });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(settled).toBeUndefined();
      await appendFile(
        path.join(dir, "exec_watch.jsonl"),
        line("delegation_final") + String.fromCharCode(10),
        { encoding: "utf8" },
      );
      expect(await running).toBe(0);
      expect(err.join("")).toContain("stream closed (delegation finished)");
      expect(err.join("")).not.toContain("no final marker");
    });
  });

  it("rejects an unusable --quiet-ms", async () => {
    await withStream(`${line("started")}` + String.fromCharCode(10), async (dir) => {
      const { io, err } = capture();
      // The CLI's contract for a bad option is a non-zero exit plus stderr, not a rejection.
      const code = await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--quiet-ms", "50"], io, undefined, {
        formatEvent: (frame) => frame.kind,
      });
      expect(code).not.toBe(0);
      expect(err.join("")).toContain("--quiet-ms");
    });
  });

  it("closes a legacy stream with no final marker once it stops growing", async () => {
    await withStream(`${line("started")}
${line("failed", { status: "failed", failureType: "timeout" })}
`, async (dir) => {
      const { io, err } = capture();
      const started = Date.now();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--interval-ms", "50", "--timeout-ms", "20000", "--quiet-ms", "750"],
        io, undefined, { formatEvent: (frame) => frame.kind },
      );
      expect(code).toBe(0);
      expect(err.join("")).toContain("no final marker and no growth for 750ms");
      // Bounded by quiet detection, never by the 20-second ceiling.
      expect(Date.now() - started).toBeLessThan(6_000);
    });
  });

  it("bounds --follow by --timeout-ms when a stream never terminates", async () => {
    await withStream(`${line("started")}\n`, async (dir) => {
      const { io, err } = capture();
      const started = Date.now();
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--interval-ms", "50", "--timeout-ms", "1000"],
        io,
        undefined,
        { formatEvent: (frame) => frame.kind },
      );
      const elapsed = Date.now() - started;
      expect(code).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(6_000);
      expect(err.join("")).toContain("stopped after --timeout-ms");
    });
  });

  it("rejects an out-of-range follow budget instead of silently clamping it", async () => {
    await withStream(`${line("started")}\n`, async (dir) => {
      const { io, err } = capture();
      // 800ms is below the accepted minimum: refusing beats pretending to obey an operator.
      const code = await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--follow", "--timeout-ms", "800"],
        io,
        undefined,
        { formatEvent: (frame) => frame.kind },
      );
      expect(code).not.toBe(0);
      expect(err.join("")).toContain("--timeout-ms");
    });
  });

  it("refuses an execution id that could not name a file", async () => {
    await withStream(`${line("started")}\n`, async (dir) => {
      const { io, err } = capture();
      const code = await runCli(["watch", "--exec", "../../etc/passwd", "--dir", dir], io, undefined, { formatEvent: (frame) => frame.kind });
      expect(code).not.toBe(0);
      expect(err.join("")).toContain("rejected value");
    });
  });

  it("keeps piped output byte-for-byte in the single-line form and offers the window layout on request", async () => {
    const stream = [
      line("assistant_text", { attempt: 1, text: "Reading the file now.\nIt has two exports." }),
      line("tool_output", { attempt: 1, tool: "bash", argsSummary: "npm test", text: "3 passed", line: 5 }),
      line("assistant_text", { attempt: 1, text: "Tests are green." }),
      line("completed", { attempt: 1, status: "success", durationMs: 76_000 }),
      line("delegation_final"),
    ].join("\n") + "\n";
    await withStream(stream, async (dir) => {
      // Plain mode is what a pipe, a redirect and a file that interleaves experts get. The
      // injected formatter proves the header still comes from the single-line renderer and the
      // body is still indented under it - exactly the shape from before the panel existed.
      const plain = capture();
      expect(await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--style", "plain"],
        plain.io,
        undefined,
        { formatEvent: (frame: { kind: string }) => `FMT ${frame.kind}` },
      )).toBe(0);
      expect(plain.out.join("")).toBe(
        "FMT assistant_text\n      Reading the file now.\n      It has two exports.\n"
        + "FMT tool_output\n      3 passed\nFMT assistant_text\n      Tests are green.\n"
        + "FMT completed\nFMT delegation_final\n",
      );

      // Panel mode: prose carries no attribution, a tool call becomes a block naming what ran,
      // and the two kinds are separated because they are different things.
      const panel = capture();
      expect(await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--style", "panel", "--no-color"],
        panel.io,
      )).toBe(0);
      const lines = panel.out.join("").split("\n");
      expect(lines[0]).toBe("Reading the file now.");
      expect(lines[1]).toBe("It has two exports.");
      expect(lines.join("")).not.toContain("says:");
      expect(lines).toContain("$ npm test #1 - full record on line 5");
      expect(lines).toContain("  3 passed");
      expect(lines[lines.indexOf("$ npm test #1 - full record on line 5") + 2]).toBe("");
      // The closing notice belongs to stderr, so stdout stays clean enough to redirect.
      expect(panel.err.join("")).toContain("stream closed");

      // Colour is opt-in per view, never per stream.
      const coloured = capture();
      expect(await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--style", "panel", "--color", "--columns", "40"],
        coloured.io,
      )).toBe(0);
      expect(coloured.out.join("")).toContain(String.fromCharCode(27));
      const raw = capture();
      expect(await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--json", "--color"],
        raw.io,
      )).toBe(0);
      expect(raw.out.join("")).not.toContain(String.fromCharCode(27));
      expect(raw.out.join("").split("\n")[1]).toContain('"kind":"tool_output"');

      // A layout name that does not exist is refused with the list of ones that do.
      const bogus = capture();
      expect(await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--style", "fancy"], bogus.io)).toBe(1);
      expect(bogus.err.join("")).toContain("auto, panel or plain");
    });
  });

  it("carries the reasoning marker through the frame whitelist into both layouts", async () => {
    // The recorder marks reasoning on the event; if the follower's whitelist dropped the field,
    // reasoning would print as ordinary speech, which is the one outcome that must not happen.
    const stream = [
      line("assistant_text", { attempt: 1, reasoning: true, text: "The caller holds no lock here." }),
      line("assistant_text", { attempt: 1, text: "I will read the caller now." }),
      line("delegation_final"),
    ].join("\n") + "\n";
    await withStream(stream, async (dir) => {
      const plain = capture();
      expect(await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--style", "plain"], plain.io)).toBe(0);
      expect(plain.out.join("")).toContain("thinks: The caller holds no lock here.");
      expect(plain.out.join("")).toContain("says: I will read the caller now.");

      const panel = capture();
      expect(await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--style", "panel", "--no-color"],
        panel.io,
      )).toBe(0);
      expect(panel.out.join("")).toContain("thinks \u2502 The caller holds no lock here.");
      expect(panel.out.join("")).toContain("I will read the caller now.");
      expect(panel.out.join("")).not.toContain("thinks \u2502 I will read");
    });
  });

  it("carries the guardrail code and the reasoning effort through the frame whitelist", async () => {
    // Two fields the follower used to drop, both of which an operator needs: `code` says which
    // guardrail fired - a budget warning, a tool-failure warning and a tool-silence warning must not
    // read as one sentence - and `reasoningLevel` answers "was this model simply thinking?" without
    // inferring it from the model name. They were in the file and in no layout.
    const stream = [
      line("started", { attempt: 1, reasoningLevel: "xhigh" }),
      line("attention", {
        attempt: 1,
        code: "tool_silence",
        toolCalls: 0,
        text: "1 minutes of this attempt elapsed with no tool call yet - it is reasoning or writing text only.",
      }),
      line("delegation_final"),
    ].join("\n") + "\n";
    await withStream(stream, async (dir) => {
      const json = capture();
      expect(await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--json"], json.io)).toBe(0);
      const frames = json.out.join("").trim().split("\n")
        .map((value) => JSON.parse(value) as Record<string, unknown>);
      expect(frames[0]).toMatchObject({ kind: "started", reasoningLevel: "xhigh" });
      expect(frames[1]).toMatchObject({ kind: "attention", code: "tool_silence", toolCalls: 0 });

      const plain = capture();
      expect(await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--style", "plain"], plain.io)).toBe(0);
      expect(plain.out.join("")).toContain("no tool call yet");
    });
  });

  it("separates one block from the next, but not a block from itself", async () => {
    // Seen in an operator's screenshot: two grey bands touching read as one block, so the seam
    // between them is invisible. A running tool that repaints is the opposite case - it is one
    // block growing, and blank lines through the middle of it would shred it.
    const block = (tool: string, text: string, extra: Record<string, unknown> = {}) =>
      line("tool_output", { attempt: 1, tool, text, ...extra });
    const stream = [
      block("read", "first payload", { line: 3 }),
      block("grep", "second payload", { line: 4 }),
      block("bash", "building", { streaming: true }),
      block("bash", "building\ncompiled", { streaming: true }),
      block("bash", "done", { line: 9 }),
      line("delegation_final"),
    ].join("\n") + "\n";
    await withStream(stream, async (dir) => {
      const { io, out } = capture();
      expect(await runCli(
        ["watch", "--exec", "exec_watch", "--dir", dir, "--style", "panel", "--no-color"],
        io,
      )).toBe(0);
      const lines = out.join("").split("\n");
      const at = (needle: string) => lines.findIndex((value) => value === needle);
      // The second block starts on its own line, with a blank above it.
      expect(lines[at("grep #1 - full record on line 4") - 1]).toBe("");
      // Two repaints of the same running tool carry no blank between them.
      expect(at("bash #1 - running")).toBeGreaterThan(-1);
      expect(lines[at("bash #1 - running") + 1]).toBe("  building");
      expect(lines[at("bash #1 - running") + 2]).toBe("bash #1 - running");
      // The finished block is a new block, so it is separated again.
      expect(lines[at("bash #1 - full record on line 9") - 1]).toBe("");
    });
  });

  it("resolves an explicit --style auto the same way as the default on a terminal", async () => {
    // `auto` is a request, not a layout. Comparing the raw option against "panel" meant that a
    // caller who typed `--style auto` - the documented default - got the single-line form in a
    // terminal while the help promised blocks, and no test could see it because a suite under a
    // pipe only ever exercises the plain branch.
    const stream = [
      line("assistant_text", { attempt: 1, text: "Prose should arrive without a timestamp prefix." }),
      line("tool_output", { attempt: 1, tool: "bash", argsSummary: "npm test", text: "ok", line: 2 }),
      line("delegation_final"),
    ].join("\n") + "\n";
    await withStream(stream, async (dir) => {
      const onTerminal = () => {
        const captured = capture();
        return { io: { ...captured.io, isTty: true }, out: captured.out };
      };
      const explicit = onTerminal();
      expect(await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--style", "auto", "--no-color"], explicit.io)).toBe(0);
      const implicit = onTerminal();
      expect(await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--no-color"], implicit.io)).toBe(0);
      expect(explicit.out.join("")).toBe(implicit.out.join(""));
      expect(explicit.out.join("")).toContain("$ npm test #1 - full record on line 2");
      expect(explicit.out.join("")).not.toContain("says:");
      // And on a pipe, `auto` still means plain - the byte-for-byte form redirect relies on.
      const piped = capture();
      expect(await runCli(["watch", "--exec", "exec_watch", "--dir", dir, "--style", "auto", "--no-color"], piped.io)).toBe(0);
      expect(piped.out.join("")).toContain("says:");
    });
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
      "expert_availability_reset",
      "expert_verify",
      "expert_respond",
    ]);
    expect(MCP_INPUT_SCHEMAS.expert_respond.response.shape.kind.safeParse("decision").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_respond.response.shape.scope.safeParse("once").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_respond.response.shape.scope.safeParse("maybe").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_build.task.safeParse("fix race").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_build.constraints.unwrap().shape.costPolicy.safeParse("speed").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_build.modelAssessment.safeParse({
      asOf: "2026-09-01T00:00:00.000Z",
      sources: ["https://livebench.ai/"],
      models: { "p/model": { coding: 8, speed: 7 } },
      billing: { p: { billingType: "subscription", costMultiplier: 0.1 } },
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
    expect((MODEL_ASSESSMENT_JSON_SCHEMA.properties as Record<string, { minProperties?: number }>).models?.minProperties).toBe(1);
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
    // Each assignment carries its own timeoutMs/reasoningLevel; the top level is
    // optional because a batch supplies them per entry, and the handler enforces
    // them whenever a single role/task delegation is requested.
    expect(MCP_INPUT_SCHEMAS.expert_delegate.timeoutMs.safeParse(undefined).success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.timeoutMs.safeParse(600_000).success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.reasoningLevel.safeParse(undefined).success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.reasoningLevel.safeParse("high").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.assignments.safeParse([
      { role: "scout", task: "map files" },
    ]).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.assignments.safeParse([
      { role: "scout", task: "map files", reasoningLevel: "low", timeoutMs: 600_000 },
      { role: "reviewer", task: "review findings", reasoningLevel: "medium", timeoutMs: 600_000 },
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
      // Derived, never restated: a literal here would pin the documentation to whichever release
      // was current when the test was written.
      expect(document).toContain(`codex plugin marketplace add Labiey/expert-council-router --ref v${releaseVersion} --json`);
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
      expect(section).toContain(`codex plugin marketplace add Labiey/expert-council-router --ref v${releaseVersion} --json`);
      expect(section).toContain("codex plugin add expert-council@expert-council-router --json");
    }
  });

  it("keeps the documented host tool counts in sync with the code", () => {
    // The README is the acceptance baseline, so a stale count is a defect: assert it
    // against the registry instead of trusting prose. MCP exposes every semantic tool
    // including the MCP-only blocking wait; the native Pi package omits that one.
    const english = readFileSync("README.md", "utf8");
    const chinese = readFileSync("README.zh-CN.md", "utf8");
    expect(english).toContain(`An MCP Server with ${MCP_TOOL_NAMES.length} async semantic tools`);
    expect(chinese).toContain(`包含 ${MCP_TOOL_NAMES.length} 个异步语义工具`);
    expect(MCP_TOOL_NAMES).toContain("expert_respond");
    expect(MCP_TOOL_NAMES).toContain("expert_wait");
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
    expect(server?.env_vars).toBeUndefined();
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

describe("MCP delegation contract", () => {
  it("forwards the host's reasoning level on a single delegation and validates the batch form", async () => {
    const received: Array<Record<string, unknown>> = [];
    let nextId = 0;
    const council: ExpertCouncil = {
      ...mockCouncil(),
      startDelegation: (request) => {
        received.push(request as unknown as Record<string, unknown>);
        nextId += 1;
        return { executionId: `exec_fwd_${nextId}`, result: new Promise(() => {}) };
      },
    };
    const server = createClientRootMcpServer({ cwd: process.cwd() }, async () => council);
    const client = new Client({ name: "forwarding-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const single = await client.callTool({
        name: "expert_delegate",
        arguments: { role: "scout", task: "Inspect a tiny file", reasoningLevel: "high", timeoutMs: 60_000 },
      });
      expect(single.isError).not.toBe(true);
      // Regression: the single-assignment branch used to drop reasoningLevel, so a
      // host-chosen effort level was silently ignored on the MCP path only.
      expect(received.at(-1)).toMatchObject({ role: "scout", reasoningLevel: "high", timeoutMs: 60_000 });

      // A batch carries both per entry, so the top level may stay empty.
      const batch = await client.callTool({
        name: "expert_delegate",
        arguments: {
          assignments: [
            { role: "scout", task: "Inspect file A", reasoningLevel: "low", timeoutMs: 60_000 },
            { role: "reviewer", task: "Review file B", reasoningLevel: "medium", timeoutMs: 90_000 },
          ],
        },
      });
      expect(batch.isError).not.toBe(true);
      expect(received.slice(-2).map((request) => request.reasoningLevel)).toEqual(["low", "medium"]);

      const incomplete = await client.callTool({
        name: "expert_delegate",
        arguments: { role: "scout", task: "Inspect a tiny file", timeoutMs: 60_000 },
      });
      expect(incomplete.isError).toBe(true);
      expect(JSON.stringify(incomplete.content)).toContain("reasoningLevel");
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
        arguments: { role: "scout", task: "Inspect a tiny file", reasoningLevel: "low", timeoutMs: 60000 },
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
        arguments: { role: "scout", task: "Inspect another tiny file", reasoningLevel: "low", timeoutMs: 60000 },
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
    piExtension({ registerTool: (tool: { name: string }) => names.push(tool.name), on: () => {} } as never);
    expect(names).toEqual(MCP_TOOL_NAMES.filter((name) => name !== "expert_wait"));
  });

  it("defaults the Pi-package expert_status to the bounded summary view", async () => {
    type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
    const tools = new Map<string, Tool>();
    let capturedView: unknown = "UNSET";
    const council = {
      ...mockCouncil(),
      getStatus: async (options?: { view?: string }) => {
        capturedView = options?.view;
        return { running: [], recentCompleted: [], providerSlots: [] };
      },
    };
    piExtension({
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      on: () => {},
    } as never, { councilFor: async () => council as never });
    await tools.get("expert_status")!.execute("c1", {}, undefined, undefined, { cwd: "." });
    expect(capturedView).toBe("summary");
    await tools.get("expert_status")!.execute("c2", { view: "full" }, undefined, undefined, { cwd: "." });
    expect(capturedView).toBe("full");
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
        routePolicy: { sessionKey: "default", effective: {} },
        warnings: [],
      }),
      buildCouncil: async (request) => {
        buildCalls += 1;
        return { id: "unexpected", taskClass: "normal", task: request.task, experts: [], createdAt: "now", warnings: [] };
      },
    };
    piExtension({
      on: () => {},
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
    // Read the captured request through a closure: the `received = undefined` resets
    // below would otherwise narrow the variable away for the rest of the block.
    const constraintsSeen = () => received?.constraints;

    const council: ExpertCouncil = {
      ...mockCouncil(),
      buildCouncil: async (request) => {
        received = request;
        return { id: "c", taskClass: "normal", task: request.task, experts: [], createdAt: "now", warnings: [] };
      },
    };
    const sessionEntries: Array<{ type: string; customType: string; data: unknown }> = [];
    piExtension({
      on: () => {},
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
    // The first build consults the service for a composition menu; no cost
    // policy is established yet, so no constraints are forwarded.
    expect(received).toBeDefined();
    expect(received?.constraints).toBeUndefined();
    expect(JSON.parse(firstAttempt.content[0]!.text).status).not.toBe("preference-required");
    received = undefined;

    await tools.get("expert_build")!.execute(
      "call",
      { task: "review", minimumContextWindow: 128_000, costPolicy: "speed" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => sessionEntries } },
    );

    expect(constraintsSeen()?.minimumContextWindow).toBe(128_000);
    expect(constraintsSeen()?.costPolicy).toBe("speed");

    received = undefined;
    await tools.get("expert_build")!.execute(
      "call",
      { task: "review again" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => sessionEntries } },
    );
    expect(constraintsSeen()?.costPolicy).toBe("speed");
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
      on: () => {},
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      sendMessage: (message: { content: string }, options: { deliverAs: string; triggerTurn: boolean }) => {
        messages.push({ message, options });
      },
    } as never, { councilFor: async () => council });

    const delegated = await tools.get("expert_delegate")!.execute(
      "call",
      { role: "reviewer", task: "review", reasoningLevel: "medium", timeoutMs: 60_000, ...(taskDescription ? { taskDescription } : {}) },
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

  it("passes an explicit composition and surfaces the composition menu", async () => {
    type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
    const tools = new Map<string, Tool>();
    const requests: Array<Parameters<ExpertCouncil["buildCouncil"]>[0]> = [];
    const council: ExpertCouncil = {
      ...mockCouncil(),
      buildCouncil: async (request) => {
        requests.push(request);
        return {
          id: "c",
          taskClass: "normal",
          task: request.task,
          experts: [],
          createdAt: "now",
          warnings: [],
          ...(request.composition
            ? {}
            : { compositionMenu: [{ name: "auto", description: "create a session composition via costPolicy (economy/balanced/speed)" }] }),
        };
      },
    };
    piExtension({
      on: () => {},
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      appendEntry: () => {},
    } as never, { councilFor: async () => council });

    const menu = await tools.get("expert_build")!.execute(
      "call",
      { task: "review" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => [] } },
    );
    const menuPayload = JSON.parse(menu.content[0]!.text);
    expect(menuPayload.status).toBe("composition-menu-required");
    expect(menuPayload.compositionMenu).toHaveLength(1);

    await tools.get("expert_build")!.execute(
      "call",
      { task: "review", composition: "daily-cheap" },
      undefined,
      undefined,
      { cwd: ".", sessionManager: { getBranch: () => [] } },
    );
    expect(requests.at(-1)?.composition).toBe("daily-cheap");
  });

  it("aborts host-bound experts at session shutdown when no operator config file exists", async () => {
    // A fresh install has no council-config.json. Treating that optional default
    // file as an explicit path made the loader throw, the teardown catch swallowed
    // it, and running experts were silently never aborted (orphans burning quota).
    const dataDir = await mkdtemp(path.join(tmpdir(), "expert-council-empty-data-"));
    const previous = process.env.EXPERT_COUNCIL_DATA_DIR;
    let shutdownCalls = 0;
    try {
      process.env.EXPERT_COUNCIL_DATA_DIR = dataDir;
      const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
      const council = {
        shutdownAll: async () => {
          shutdownCalls += 1;
          return { aborted: [] };
        },
      } as unknown as ExpertCouncil;
      piExtension({
        registerTool: () => undefined,
        on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
          handlers[event] = handler;
        },
        sendMessage: () => undefined,
      } as never, { councilFor: async () => council });
      expect(typeof handlers.session_shutdown).toBe("function");
      await handlers.session_shutdown!(undefined, { cwd: process.cwd() });
      expect(shutdownCalls).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.EXPERT_COUNCIL_DATA_DIR;
      else process.env.EXPERT_COUNCIL_DATA_DIR = previous;
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("forwards an optional model pin on a single delegation", async () => {
    type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
    const tools = new Map<string, Tool>();
    let received: Parameters<ExpertCouncil["startDelegation"]>[0] | undefined;
    const council: ExpertCouncil = {
      ...mockCouncil(),
      startDelegation: (request) => {
        received = request;
        return { executionId: "exec_pin", result: new Promise(() => {}) };
      },
    };
    piExtension({
      on: () => {},
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      sendMessage: () => {},
    } as never, { councilFor: async () => council });

    await tools.get("expert_delegate")!.execute(
      "call",
      { role: "scout", task: "map files", reasoningLevel: "low", timeoutMs: 60_000, model: "p/m" },
      undefined,
      undefined,
      { cwd: ".", isIdle: () => false },
    );
    expect(received?.model).toBe("p/m");
    expect(received?.reasoningLevel).toBe("low");
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
      on: () => {},
      registerTool: (tool: { name: string; execute: Tool["execute"] }) => tools.set(tool.name, tool),
      sendMessage: () => {},
    } as never, { councilFor: async () => council });

    const delegated = await tools.get("expert_delegate")!.execute(
      "call",
      { assignments: [
        { role: "scout", task: "map files", taskDescription: "repository map", reasoningLevel: "low", timeoutMs: 60_000 },
        { role: "reviewer", task: "review findings", reasoningLevel: "medium", timeoutMs: 60_000 },
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

describe("council composition surface", () => {
  it("accepts composition and model-pinning schemas", () => {
    expect(MCP_INPUT_SCHEMAS.expert_build.composition.safeParse("daily-cheap").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_build.composition.safeParse("x".repeat(81)).success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_build.composition.safeParse("bad\0name").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.model.safeParse("p/m").success).toBe(true);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.model.safeParse("nope").success).toBe(false);
    expect(MCP_INPUT_SCHEMAS.expert_delegate.assignments.safeParse([
      { role: "scout", task: "map files", reasoningLevel: "low", timeoutMs: 600_000, model: "p/m" },
    ]).success).toBe(true);
  });

  it("permits a compositionMenu in the expert_build response", async () => {
    const council: ExpertCouncil = {
      ...mockCouncil(),
      buildCouncil: async (request) => ({
        id: "c",
        taskClass: "normal",
        task: request.task,
        experts: [],
        createdAt: "now",
        warnings: [],
        compositionMenu: [
          { name: "daily-cheap", rolesSummary: { scout: 2 } },
          { name: "auto", description: "create a session composition via costPolicy (economy/balanced/speed)" },
        ],
      }),
    };
    const server = createClientRootMcpServer({ cwd: process.cwd() }, async () => council);
    const client = new Client({ name: "composition-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const build = await client.callTool({
        name: "expert_build",
        arguments: { task: "Implement a small bounded feature", composition: "daily-cheap" },
      });
      const payload = JSON.parse((build.content as Array<{ text: string }>)[0]!.text);
      expect(payload.compositionMenu).toHaveLength(2);
      expect(payload.compositionMenu[0]).toMatchObject({ name: "daily-cheap", rolesSummary: { scout: 2 } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
