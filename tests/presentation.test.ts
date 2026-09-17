import { describe, expect, it } from "vitest";
import {
  EXPERT_EVENT_KINDS,
  displayWidth,
  formatExpertEvent,
  formatExpertPanel,
  presentCouncilPlan,
  presentResourceInventory,
  type CouncilPlan,
  type ResourceInventory,
} from "../packages/core/src/index.js";
import { capabilities, model } from "./helpers.js";

describe("compact host presentation", () => {
  const inventory: ResourceInventory = {
    models: [
      model("subscription", "reasoner", { reasoning: true }),
      model("subscription", "worker", { reasoning: false }),
      model("metered", "reviewer", { reasoning: true }),
    ],
    skills: [
      { name: "enabled", installed: true, enabled: true },
      { name: "disabled", installed: true, enabled: false },
    ],
    billing: {
      subscription: { billingType: "subscription" },
      metered: { billingType: "metered" },
    },
    roles: [{
      role: "scout",
      description: "Explore",
      readOnly: true,
      tools: ["read"],
      skills: [],
      weights: { speed: 1 },
    }],
    runtimeCapabilities: capabilities,
    routePolicy: { sessionKey: "default", effective: {} },
    warnings: [],
  };

  it("forwards 0.8.0 interaction and permission capabilities to the host view", () => {
    const compact = presentResourceInventory(inventory) as any;
    // Hosts must be able to discover that experts can raise decision points and
    // request tools; a runtime that reports these flags has to survive presentation.
    expect(compact.runtimeCapabilities).toMatchObject({
      realtimeInteraction: true,
      dynamicToolPermissions: true,
    });
  });

  it("forwards the interactive event-stream capability so hosts can discover the window", () => {
    // 0.8.0 lesson: a capability field the runtime reports but presentation drops is
    // invisible to every host. The window is only reachable if this survives.
    const withStream: ResourceInventory = {
      ...inventory,
      runtimeCapabilities: {
        ...capabilities,
        eventStream: { enabled: true, dir: "/tmp/ec/observability", redactToolArgs: true },
      },
    };
    expect((presentResourceInventory(withStream) as any).runtimeCapabilities.eventStream)
      .toEqual({ enabled: true, dir: "/tmp/ec/observability", redactToolArgs: true });
    // A runtime that reports no stream must not grow a fabricated one.
    expect(presentResourceInventory(inventory) as any).not.toHaveProperty("runtimeCapabilities.eventStream");
  });

  it("omits individual model metadata and role weights by default", () => {
    const compact = presentResourceInventory(inventory) as any;
    expect(compact.summary).toEqual({ modelCount: 3, providerCount: 2, enabledSkillCount: 1, roleCount: 1 });
    expect(compact.providers).toEqual([
      { provider: "subscription", modelCount: 2, reasoningModelCount: 1, billingType: "subscription" },
      { provider: "metered", modelCount: 1, reasoningModelCount: 1, billingType: "metered" },
    ]);
    expect(compact.roles).toEqual([{ role: "scout", readOnly: true }]);
    expect(JSON.stringify(compact)).not.toContain("contextWindow");
    expect(JSON.stringify(compact)).not.toContain("weights");
    expect(presentResourceInventory(inventory, "full")).toBe(inventory);
  });

  it("keeps selected experts but omits task copies, alternatives, tools, and scores", () => {
    const plan: CouncilPlan = {
      id: "council_compact",
      taskClass: "normal",
      task: "A long host task that should not be repeated into the model context",
      experts: [{
        role: "scout",
        model: "subscription/reasoner",
        provider: "subscription",
        score: 8.5,
        reason: ["reason one", "reason two", "reason three"],
        alternatives: [{ model: "metered/reviewer", provider: "metered", score: 7, reasons: ["alternative"] }],
        tools: ["read", "grep"],
        skills: [],
        readOnly: true,
      }],
      createdAt: "now",
      warnings: [],
    };
    const compact = presentCouncilPlan(plan) as any;
    expect(compact.experts).toEqual([{
      role: "scout",
      model: "subscription/reasoner",
      reason: ["reason one", "reason two"],
      readOnly: true,
    }]);
    expect(compact).not.toHaveProperty("task");
    expect(compact.experts[0]).not.toHaveProperty("alternatives");
    expect(compact.experts[0]).not.toHaveProperty("score");
    expect(presentCouncilPlan(plan, "full")).toBe(plan);
  });
});

describe("formatExpertEvent - the renderer shipped in core, not a CLI stub", () => {
  const at = "2026-09-16T11:18:05.123Z";
  const base = { t: at, executionId: "exec_1" };

  it("renders tool activity, narration, and waits with the model that produced them", () => {
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "tool_started", tool: "grep" })).toBe("11:18:05 [scout p/m] tool grep");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "tool_finished", tool: "grep", ok: false })).toBe("11:18:05 [scout p/m] tool grep FAILED");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "assistant_text", text: "checking the build" })).toBe("11:18:05 [scout p/m] says: checking the build");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "interaction_opened", text: "which one?" })).toContain("WAITING FOR HOST");
  });

  it("labels an attempt only once a delegation has more than one", () => {
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "started" })).toBe("11:18:05 [scout p/m] started");
    expect(formatExpertEvent({ ...base, role: "scout", model: "p/m", kind: "started", attempt: 1 })).toBe("11:18:05 [scout p/m] started");
    expect(formatExpertEvent({ ...base, role: "worker", model: "p/other", kind: "started", attempt: 2 })).toBe("11:18:05 [worker p/other #2] started");
  });

  it("names the delegation-level terminator", () => {
    expect(formatExpertEvent({ ...base, role: "worker", kind: "delegation_final" })).toContain("delegation finished");
  });

  it("never lets one event occupy more than a single terminal line", () => {
    const noisy = formatExpertEvent({ ...base, role: "scout", kind: "assistant_text", text: "first line\nsecond line" });
    expect(noisy.includes("\n")).toBe(false);
  });
});

describe("struggle warnings reach the window with their meaning", () => {
  const at = "2026-09-16T11:38:41.000Z";

  it("renders an attention event as a warning carrying detail and numbers, not a bare kind name", () => {
    const rendered = formatExpertEvent({
      t: at,
      executionId: "exec_1",
      role: "scout",
      model: "p/m",
      kind: "attention",
      attempt: 1,
      text: "60% of the execution budget used with no result yet.",
      toolCalls: 2,
      toolErrors: 1,
      budgetFractionUsed: 0.6,
      nudgedExpert: true,
    });
    // Defect #21: there was no `attention` case at all, so the shared renderer fell through
    // to its default branch and printed the bare kind name - the window said `attention`
    // and threw the sentence away. Observed live.
    expect(rendered).toContain("WARNING");
    expect(rendered).toContain("60% of the execution budget used with no result yet.");
    expect(rendered).toContain("budget 60%");
    expect(rendered).toContain("tool errors 1/2");
    expect(rendered).toContain("expert steered");
    expect(rendered).not.toBe("11:38:41 [scout p/m] attention");
  });

  it("still renders a warning that carries no counters", () => {
    expect(formatExpertEvent({ t: at, executionId: "exec_1", role: "scout", kind: "attention" }))
      .toBe("11:38:41 [scout] WARNING: struggle detected");
  });
});

import type { ExpertEventKind, ExpertObservabilityEvent } from "../packages/core/src/index.js";

describe("every event kind the stream can carry renders meaningfully", () => {
  const at = "2026-09-16T11:38:41.000Z";

  const cases: Array<{ kind: ExpertEventKind; event: Partial<ExpertObservabilityEvent>; expected: string }> = [
    { kind: "started", event: {}, expected: "started" },
    { kind: "tool_started", event: { tool: "read" }, expected: "tool read" },
    { kind: "tool_finished", event: { tool: "read", ok: true }, expected: "tool read ok" },
    { kind: "assistant_text", event: { text: "looking now" }, expected: "says: looking now" },
    { kind: "tool_output", event: { tool: "bash", ok: true, line: 87 }, expected: "bash - returned - full record on line 87" },
    { kind: "attention", event: { text: "budget spent", toolErrors: 1, toolCalls: 2 }, expected: "WARNING: budget spent" },
    { kind: "interaction_opened", event: { text: "pick one" }, expected: "WAITING FOR HOST: pick one" },
    { kind: "interaction_answered", event: { text: "chose ls" }, expected: "host answered: chose ls" },
    { kind: "stopped", event: { status: "partial", failureType: "missing_context" }, expected: "stopped by expert: partial (missing_context)" },
    { kind: "completed", event: { status: "success", durationMs: 3000 }, expected: "completed: success in 3s" },
    { kind: "failed", event: { status: "failed", failureType: "timeout", durationMs: 9000 }, expected: "failed: failed (timeout) in 9s" },
    { kind: "stream_truncated", event: { text: "too many events" }, expected: "stream truncated: too many events" },
    { kind: "delegation_final", event: {}, expected: "delegation finished" },
  ];

  it("covers exactly the kinds the union defines, so a new one cannot skip the renderer", () => {
    // Drift guard for defect #21: an unlisted kind still compiles and still streams, but
    // it falls through to the default branch and prints a bare word. The `Record` over the
    // union in core makes an unlisted kind a build failure; this makes an untested one red.
    expect([...EXPERT_EVENT_KINDS].sort()).toEqual(cases.map((item) => item.kind).sort());
  });

  it.each(cases)("renders $kind with its own wording, on one line", ({ kind, event, expected }) => {
    const rendered = formatExpertEvent({ t: at, executionId: "exec_1", role: "scout", model: "p/m", kind, ...event });
    expect(rendered).toContain(expected);
    expect(rendered.includes(String.fromCharCode(10))).toBe(false);
  });
});

describe("panel layout for an observer window", () => {
  const frame = (
    kind: ExpertObservabilityEvent["kind"],
    extra: Partial<ExpertObservabilityEvent> = {},
  ): ExpertObservabilityEvent => ({
    t: "2026-09-17T00:00:00.000Z",
    executionId: "exec_panel",
    role: "scout",
    model: "vendor/m",
    attempt: 1,
    kind,
    ...extra,
  });
  const escape = String.fromCharCode(27);

  it("shows narration as prose, with no attribution and no clamp", () => {
    // The window follows one delegation, so `scout vendor/m says:` on every line was noise, and
    // the 120-character clamp cut sentences at an arbitrary column while the terminal wrapped
    // them again. Pi's own layout is the reference: the text is the point.
    const long = "a".repeat(400);
    expect(formatExpertPanel(frame("assistant_text", { text: `Line one.\n${long}\n` }))).toEqual([
      "Line one.",
      long,
    ]);
    // Text that carries nothing at all - whitespace, or an empty fragment - prints nothing.
    expect(formatExpertPanel(frame("assistant_text", { text: "\n   \n  " }))).toEqual([]);
  });

  it("names the tool and what it was asked to run, and points at the full record", () => {
    const bash = formatExpertPanel(frame("tool_output", {
      tool: "bash",
      argsSummary: "npm test",
      text: "3 passed",
      line: 7,
    }));
    expect(bash[0]).toBe("$ npm test #1 - full record on line 7");
    expect(bash[1]).toBe("  3 passed");
    // A write names the path the way Pi does, and a tool with nothing allowed to show stays bare.
    expect(formatExpertPanel(frame("tool_output", { tool: "write", argsSummary: "src/a.ts", text: "ok" }))[0])
      .toBe("write src/a.ts #1");
    expect(formatExpertPanel(frame("tool_output", { tool: "grep", text: "hit" }))[0]).toBe("grep #1");
    // The top dial stores full arguments; the first line becomes the subject.
    expect(formatExpertPanel(frame("tool_output", { tool: "bash", argsText: "cd /tmp\n&& make", text: "ok" }))[0])
      .toBe("$ cd /tmp && make #1");
    expect(formatExpertPanel(frame("tool_output", { tool: "bash", text: "boom", ok: false }))[0])
      .toBe("bash #1 - failed");
    // A block still running says so instead of pretending to be finished.
    expect(formatExpertPanel(frame("tool_output", { tool: "bash", text: "building", streaming: true }))[0])
      .toBe("bash #1 - running");
  });

  it("caps a block body at the configured tail and says what it hid", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    const shown = formatExpertPanel(frame("tool_output", { tool: "bash", text }), { maxLines: 3 });
    expect(shown[1]).toBe("[\u2191 9 earlier lines not shown]");
    expect(shown.slice(2)).toEqual(["  line 9", "  line 10", "  line 11"]);
  });

  it("keeps colour out of the output unless it is asked for", () => {
    const plain = formatExpertPanel(frame("tool_output", { tool: "bash", text: "ok" }));
    expect(plain.join("\n")).not.toContain(escape);
    const coloured = formatExpertPanel(frame("tool_output", { tool: "bash", text: "ok" }), {
      color: true,
      columns: 30,
    });
    expect(coloured[0]).toContain(escape);
    // The background has to reach the right edge, which needs the padded width measured in
    // terminal cells, not in characters.
    const cjk = formatExpertPanel(frame("tool_output", { tool: "bash", text: "\u4e2d\u6587" }), {
      color: true,
      columns: 30,
    });
    const visible = cjk[0]!.replace(/\u001b\[[0-9;]*m/g, "");
    expect(displayWidth(visible)).toBe(30);
  });

  it("measures display width in cells, not characters", () => {
    expect(displayWidth("abcd")).toBe(4);
    expect(displayWidth("\u4e2d\u6587")).toBe(4);
    expect(displayWidth("\u4e2d\u6587ab")).toBe(6);
    expect(displayWidth("")).toBe(0);
  });

  it("falls back to the single-line form for structure and terminal events", () => {
    const completed = formatExpertPanel(frame("completed", { status: "success", durationMs: 76_000 }));
    expect(completed).toEqual([formatExpertEvent(frame("completed", { status: "success", durationMs: 76_000 }))]);
    expect(formatExpertPanel(frame("delegation_final"))[0]).toContain("delegation finished");
    // Name-only tool lines survive, because at the lower dials they are the only tool visibility.
    expect(formatExpertPanel(frame("tool_started", { tool: "read" }))[0]).toBe("read #1");
    expect(formatExpertPanel(frame("tool_finished", { tool: "read", ok: true }))[0]).toBe("read ok #1");
  });
});
