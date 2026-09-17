import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENT_LEVELS,
  EXPERT_EVENT_KINDS,
  formatExpertEventBody,
  isContentEvent,
  parseCouncilConfig,
  type ContentStreamLevel,
  type ExpertObservabilityEvent,
} from "../packages/core/src/index.js";
import {
  ContentRecorder,
  flushPoint,
  headTailSeam,
  recordsAssistant,
  recordsToolArgs,
  recordsToolOutput,
  resolveContentLevel,
  tailOnly,
} from "../packages/pi-runtime/src/content-stream.js";
import { PiExpertRuntime, toolResultText, type PiSdkLike } from "../packages/pi-runtime/src/index.js";

const roleDirectory = path.resolve("packages/core/src/roles/prompts");

/** Collect what the recorder would append, without a file or a process. */
function captureEmitter() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    emit: (kind: string, fields: Record<string, unknown>) => {
      records.push({ kind, ...fields });
    },
  };
}

describe("content dial resolution", () => {
  it("follows built-in < global < byRole < environment", () => {
    const base = { levels: CONTENT_LEVELS, global: "none" as ContentStreamLevel };
    expect(resolveContentLevel({ ...base, role: "scout" }).level).toBe("none");
    expect(resolveContentLevel({ ...base, global: "assistant", role: "scout" }).level).toBe("assistant");
    expect(
      resolveContentLevel({ ...base, global: "assistant", byRole: { scout: "none" }, role: "scout" }).level,
    ).toBe("none");
    expect(
      resolveContentLevel({
        ...base,
        global: "assistant",
        byRole: { scout: "none" },
        role: "scout",
        envValue: "transcript",
      }).level,
    ).toBe("transcript");
    // A role with no entry inherits the global dial rather than falling to none.
    expect(resolveContentLevel({ ...base, global: "assistant", byRole: { scout: "none" }, role: "reviewer" }).level)
      .toBe("assistant");
  });

  it("refuses to guess when the environment names a dial that does not exist", () => {
    // Silently ignoring the knob an operator reached for is how a security setting becomes
    // folklore, so the fallback is reported alongside it.
    const resolved = resolveContentLevel({
      levels: CONTENT_LEVELS,
      global: "assistant",
      role: "scout",
      envValue: "everything",
    });
    expect(resolved.level).toBe("assistant");
    expect(resolved.warning ?? "").toContain("everything");
    expect(resolved.warning ?? "").toContain("transcript+args");
  });

  it("gates every field on the dial, and only the top dial writes arguments", () => {
    expect(CONTENT_LEVELS).toEqual(["none", "assistant", "assistant+tool-tail", "transcript", "transcript+args"]);
    const assistant = new Set(["assistant", "assistant+tool-tail", "transcript", "transcript+args"]);
    const tool = new Set(["assistant+tool-tail", "transcript", "transcript+args"]);
    for (const level of CONTENT_LEVELS) {
      expect(recordsAssistant(level)).toBe(assistant.has(level));
      expect(recordsToolOutput(level)).toBe(tool.has(level));
      expect(recordsToolArgs(level)).toBe(level === "transcript+args");
    }
  });
});

describe("recorded payloads keep their truncation visible", () => {
  it("stores a head and a tail and names what went between them", () => {
    const text = `HEAD${"x".repeat(4000)}TAIL`;
    const seam = headTailSeam(text, 1000);
    expect(seam.omittedBytes).toBeGreaterThan(2000);
    expect(seam.text.startsWith("HEAD")).toBe(true);
    expect(seam.text.endsWith("TAIL")).toBe(true);
    expect(seam.text).toContain("bytes between head and tail omitted");
    expect(Buffer.byteLength(seam.text)).toBeLessThanOrEqual(1200);
    // Under the cap nothing is rewritten: an operator must be able to trust that a short
    // block arrived exactly as the tool produced it.
    expect(headTailSeam("short", 1000)).toEqual({ text: "short", omittedBytes: 0 });
  });

  it("keeps the tail for the tool-tail dial without splitting a multi-byte character", () => {
    const text = "中文日志输出".repeat(2000); // three bytes per character
    const kept = tailOnly(text, 1001);
    expect(kept.omittedBytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(kept.text)).toBeLessThanOrEqual(1001);
    expect(kept.text.endsWith("中文日志输出")).toBe(true);
    expect(kept.text.includes("\uFFFD")).toBe(false);
  });
});

describe("a recorder pushes only what has not been pushed", () => {
  function recorder(level: ContentStreamLevel, options: { eventBytes?: number; reasoning?: boolean } = {}) {
    const sink = captureEmitter();
    const rec = new ContentRecorder({
      level,
      eventBytes: options.eventBytes ?? 65536,
      ...(options.reasoning ? { reasoning: true } : {}),
      emit: sink.emit,
    });
    return { rec, records: sink.records };
  }

  it("appends assistant text as it grows, and never repeats a character", () => {
    const { rec, records } = recorder("assistant");
    const newline = String.fromCharCode(10);
    const first = "the race is in applyHotplug(), which is called from the hotplug path without a lock, ";
    const second = first + "so two arrivals can overwrite each other." + newline;
    rec.onAssistantText(first);                      // no boundary yet: held
    expect(records).toHaveLength(0);
    rec.onAssistantText(second);
    expect(records).toHaveLength(1);
    expect(String(records[0]?.text)).toBe(second);
    rec.onAssistantText(second);
    expect(records).toHaveLength(1);                            // no growth, no record
    const joined = records.map((record) => String(record.text)).join("");
    expect(joined).toBe(second);
  });

  it("does not turn a punctuation-only line into a record", () => {
    // What the operator saw as `says: ],`: a JSON report streams line by line, and flushing at
    // every newline made `],` and a bare fence their own record. A boundary must carry substance.
    const quiet = recorder("assistant");
    quiet.rec.onAssistantText(String.fromCharCode(10) + "  ]," + String.fromCharCode(10));
    quiet.rec.onAssistantText(String.fromCharCode(10) + "  ]," + String.fromCharCode(10) + "  }" + String.fromCharCode(10));
    expect(quiet.records).toHaveLength(0);            // held until there is something to show
    quiet.rec.onAssistantText(
      String.fromCharCode(10) + "  ]," + String.fromCharCode(10) + "  }" + String.fromCharCode(10),
      true,
    );
    expect(quiet.records).toHaveLength(1);
    expect(String(quiet.records[0]?.text)).toContain("],");
  });

  it("cuts an oversized fragment at whitespace rather than inside a word", () => {
    // The mid-word splits in the window (`"Def` / `ect numbers`) came from a byte threshold that
    // cut wherever the limit happened to fall.
    // A 14-character unit: 600 does not divide by 14, so the ceiling lands inside a word and the
    // test cannot pass by arithmetic accident. (It did pass that way at first: "alpha bravo " is
    // 12 characters, 600 / 12 is exact, and the falsification came back inert.)
    const words = "alpha bravo12 ".repeat(80);       // 1120 bytes, no sentence boundary
    const { rec, records } = recorder("assistant");
    rec.onAssistantText(words);
    expect(records).toHaveLength(1);
    const emitted = String(records[0]?.text);
    expect(emitted.length).toBeLessThan(words.length);
    expect(emitted.endsWith(" ")).toBe(true);
    expect(/\w$/.test(emitted.trimEnd())).toBe(true); // a whole word, not half of one
    expect(words.slice(emitted.length).startsWith("bravo12")).toBe(true);  // cut before a whole word
  });

  it("measures the narration ceiling in bytes, not UTF-16 units", () => {
    // An audit of this file found that the ceiling was compared in bytes but cut in units, so one
    // CJK character - three bytes each - let 1500 bytes through a 600-byte limit.
    const cjk = "\u4e2d".repeat(500);
    const cut = flushPoint(cjk, false, 80, 600);
    expect(cut).toBeGreaterThan(0);
    expect(Buffer.byteLength(cjk.slice(0, cut))).toBeLessThanOrEqual(600);
    // The same holds for the minimum: it is a byte threshold, not a character count.
    expect(flushPoint("\u4e2d".repeat(30) + "\n", false, 80, 600)).toBe(31);
  });

  it("never leaves a lone surrogate at a head/tail seam", () => {
    // Slicing by index can cut an astral character in half; the orphan survives JSON and shows up
    // as a replacement glyph in the operator's window.
    const text = "a".repeat(80) + "\u{1F600}".repeat(40) + "b".repeat(80);
    // 262 bytes gives a 91-unit half: 80 'a' plus 11 units, which lands one surrogate into the
    // emoji run - and 91 units from the end starts on the other half of a pair.
    const seam = headTailSeam(text, 262).text;
    const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
    const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
    let orphan = false;
    for (let index = 0; index < seam.length; index += 1) {
      const code = seam.charCodeAt(index);
      if (isHigh(code) && !isLow(seam.charCodeAt(index + 1))) orphan = true;
      if (isLow(code) && !isHigh(seam.charCodeAt(index - 1))) orphan = true;
    }
    expect(orphan).toBe(false);
    expect(seam).toContain("omitted");
    expect(headTailSeam("ab", 4).text).toBe("ab");   // a short string is never truncated
  });

  it("holds a stream of tiny fragments and flushes them once", () => {
    // Measured on a real run: 129 assistant records for 2.2 KB of text, which would exhaust
    // the event ceiling in the middle of a long answer. Coalescing is the fix, and the flush
    // is what makes it safe rather than lossy.
    const { rec, records } = recorder("assistant");
    let text = "";
    for (let index = 0; index < 100; index += 1) {
      text += "ab";                     // 200 bytes in total: under the hold threshold
      rec.onAssistantText(text);
    }
    expect(records).toHaveLength(0);
    rec.onAssistantText(text, true);
    expect(records).toHaveLength(1);
    expect(String(records[0]?.text)).toBe(text);
    // And a long unbroken run is not held forever: the ceiling releases it, at whitespace.
    const eager = recorder("assistant");
    eager.rec.onAssistantText("x".repeat(300));
    expect(eager.records).toHaveLength(0);            // under the ceiling: still worth holding
    eager.rec.onAssistantText("lead " + "y".repeat(700));
    expect(eager.records).toHaveLength(1);
    expect(/\s$/.test(String(eager.records[0]?.text))).toBe(true);
  });

  it("writes a block that is not a continuation whole, without inventing a gap", () => {
    // A revision and a new message both arrive as text that does not extend what was sent.
    // Both are written in full: over-sending is honest, while a reader who believes they are
    // watching an append is being lied to.
    const { rec, records } = recorder("assistant");
    rec.onAssistantText("planning to edit the wrong file", true);
    rec.onAssistantText("planning to stop", true);
    expect(records).toHaveLength(2);
    expect(String(records[1]?.text)).toBe("planning to stop");
  });

  it("streams a tool block only when it actually advanced", () => {
    const newline = String.fromCharCode(10);
    const { rec, records } = recorder("transcript");
    rec.onToolPartial("tc1", "bash", "one line");        // below the floor: held
    rec.onToolPartial("tc1", "bash", "one line");        // no growth at all
    expect(records).toHaveLength(0);
    const first = "one line" + newline + "x".repeat(240);
    rec.onToolPartial("tc1", "bash", first);             // past the byte floor
    expect(records).toHaveLength(1);
    expect(records[0]?.streaming).toBe(true);
    const second = first + newline + "y".repeat(240);
    rec.onToolPartial("tc1", "bash", second);
    expect(records).toHaveLength(2);
    expect(String(records[1]?.text)).toContain("yyyy");
    // Ten short lines is the other trigger, so a chatty tool still visibly moves.
    const lines = second + Array.from({ length: 10 }, (_unused, i) => newline + "line " + i).join("");
    rec.onToolPartial("tc1", "bash", lines);
    expect(records).toHaveLength(3);
    expect(String(records[2]?.text)).toContain("line 9");
  });

  it("stores the tail only for the tool-tail dial and the whole block above it", () => {
    const long = `${"head ".repeat(600)}final failing line`;
    const tail = recorder("assistant+tool-tail", { eventBytes: 200 });
    tail.rec.onToolResult("tc1", "read", true, long);
    const tailRecord = tail.records[0] ?? {};
    expect(String(tailRecord.text).endsWith("final failing line")).toBe(true);
    expect(String(tailRecord.text).startsWith("head head")).toBe(false);
    expect(typeof tailRecord.omittedBytes).toBe("number");

    const full = recorder("transcript", { eventBytes: 2000 });
    full.rec.onToolResult("tc2", "read", true, long);
    const fullRecord = full.records[0] ?? {};
    expect(String(fullRecord.text).startsWith("head ")).toBe(true);
    expect(String(fullRecord.text).endsWith("final failing line")).toBe(true);
    expect(String(fullRecord.text)).toContain("omitted");
  });

  it("writes arguments at the top dial only, and records a missing result explicitly", () => {
    // Pi sends arguments on the start event and the result on the end event, so the recorder
    // has to hold one until the other arrives; a dial that quietly loses them is worse than
    // one that was never turned on.
    const quiet = recorder("transcript");
    quiet.rec.noteArgs("tc1", { summary: 'cmd=npm test' });
    quiet.rec.onToolResult("tc1", "bash", true, "ok");
    expect(quiet.records[0]?.argsText).toBeUndefined();

    const loud = recorder("transcript+args");
    loud.rec.noteArgs("tc2", { full: '{"command":"npm test"}' });
    loud.rec.onToolResult("tc2", "bash", true, "ok");
    expect(String(loud.records[0]?.argsText)).toContain("npm test");

    const empty = recorder("transcript");
    empty.rec.onToolResult("tc3", "bash", false, null);
    expect(String(empty.records[0]?.text)).toBe("[no result returned]");
    expect(empty.records[0]?.ok).toBe(false);
  });

  it("records reasoning only when the operator asked, and marks every record it writes", () => {
    // The default is the project rule: chain of thought is not stored. The switch is an operator
    // exception, and when it is on the result must still be tellable apart from narration at a
    // glance, or a reader takes what a model thought at itself for what it chose to say.
    const off = recorder("assistant");
    off.rec.onReasoningText("I suspect the lock, but will not say so.\n", true);
    expect(off.records).toHaveLength(0);

    const on = recorder("assistant", { reasoning: true });
    on.rec.onReasoningText("First I should read the caller.\n", true);
    expect(on.records).toHaveLength(1);
    expect(on.records[0]?.reasoning).toBe(true);
    expect(String(on.records[0]?.text)).toContain("First I should read");
    // Narration on the same recorder stays unmarked, and the two channels never cross.
    on.rec.onAssistantText("Reading the caller now.\n", true);
    expect(on.records).toHaveLength(2);
    expect(on.records[1]?.reasoning).toBeUndefined();
    expect(String(on.records[1]?.text)).toContain("Reading the caller");
    // A dial that stores no text stores no reasoning either, however the switch is set.
    const silent = recorder("none", { reasoning: true });
    silent.rec.onReasoningText("still nothing\n", true);
    expect(silent.records).toHaveLength(0);
  });

  it("flushes held reasoning when the closing event no longer carries the part", () => {
    // Pi's `message_end` repeats text content but not the thinking part, so a cursor that only
    // knew the current cumulative string would get an empty final call and drop the last sentence
    // of whatever it was holding - the exact failure this recorder promises not to have.
    const { rec, records } = recorder("assistant", { reasoning: true });
    const thought = "The caller takes no lock so two arrivals can race and overwrite each other";
    rec.onReasoningText(thought);                       // under the threshold: held
    expect(records).toHaveLength(0);
    rec.onReasoningText("", true);                      // the closing event forgot the part
    expect(records).toHaveLength(1);
    expect(String(records[0]?.text)).toBe(thought);
    expect(records[0]?.reasoning).toBe(true);
  });

  it("counts recorded bytes once, not twice", () => {
    // A delegated scout found a duplicated `bytesConsidered` line in the narration path, which
    // made the recorder report twice the content it stored. The stat is what an operator is told
    // about ceiling pressure, so an inflated number is a false alarm about a privacy switch.
    const { rec, records } = recorder("assistant", { reasoning: true });
    const narration = "The caller takes no lock so two arrivals can race.\n";
    const thought = "Weighing whether the ceiling is per record or per byte.\n";
    rec.onAssistantText(narration, true);
    rec.onReasoningText(thought, true);
    expect(records).toHaveLength(2);
    expect(rec.stats.bytes).toBe(Buffer.byteLength(narration) + Buffer.byteLength(thought));
    expect(rec.stats.records).toBe(2);
  });

  it("does not leave a stray leading space on the next chunk after a sentence cut", () => {
    // The boundary rule ends a record at the period and hands the separating space to whatever
    // comes next, which rendered as `thinks |  Read-only` with two spaces after the marker.
    const { rec, records } = recorder("assistant", { reasoning: true });
    const first = "The ceiling is per stream, so the recorder holds a fragment until there is something to show.";
    const second = first + " So a chatty tool, not a chatty model, is what squeezes the budget out.";
    rec.onReasoningText(first);
    expect(records).toHaveLength(1);
    expect(String(records[0]?.text)).toBe(first);
    rec.onReasoningText(second, true);
    expect(records).toHaveLength(2);
    expect(String(records[1]?.text)).toBe("So a chatty tool, not a chatty model, is what squeezes the budget out.");
    // Nothing is lost or duplicated across the two records, apart from the separator itself.
    expect(String(records[0]?.text) + " " + String(records[1]?.text)).toBe(second);
  });

  it("gives a streaming tool a byte floor, not a line floor", () => {
    // The gate used to be "any new line", so output that prints thousands of short progress
    // lines wrote roughly one record per line and squeezed narration out of the per-stream
    // ceiling: the chatty tool, not the chatty model, was the real pressure.
    const { rec, records } = recorder("transcript");
    let text = "";
    for (let index = 0; index < 40; index += 1) {
      text += "x\n";                       // 40 short lines, 80 bytes in total
      rec.onToolPartial("tc1", "bash", text);
    }
    expect(records.filter((r) => r.streaming === true)).toHaveLength(4);
  });

  it("keeps a head/tail seam inside the byte ceiling it was given", () => {
    // The ceiling is documented in bytes. Slicing by UTF-16 units let CJK come out at ~2.7x and
    // astral emoji at ~1.8x of what the operator configured, so the privacy dial was silently
    // wider than the number they set.
    for (const [name, payload] of [
      ["ascii", "a".repeat(4000)],
      ["cjk", String.fromCharCode(0x4e2d).repeat(4000)],
      ["emoji", String.fromCodePoint(0x1f600).repeat(2000)],
    ] as const) {
      const seam = headTailSeam(payload, 600);
      expect(Buffer.byteLength(seam.text)).toBeLessThanOrEqual(600);
      expect(seam.omittedBytes).toBeGreaterThan(0);
      expect(seam.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    }
  });

  it("writes held narration before the tool block that follows it", () => {
    // Coalescing waits for ~80 bytes, so a short sentence followed straight by a tool result used
    // to land in the file *after* that result: the observer read the outcome before the sentence
    // that announced it, and the stream order stopped matching the conversation order.
    const { rec, records } = recorder("transcript");
    rec.onAssistantText("Reading the failing test now.");        // 28 bytes: below the floor
    rec.onToolResult("tc1", "read", true, "assertion failed" + String.fromCharCode(10));
    expect(records).toHaveLength(2);
    expect(String(records[0]?.text)).toContain("Reading the failing test");
    expect(records[0]?.text === undefined).toBe(false);
    expect(records[1]?.tool).toBe("read");
    expect(records[1]?.streaming).toBeUndefined();
  });

  it("does not let the whole-object fallback smuggle chain-of-thought into a tool record", () => {
    // When a host's tool result carries no content array the recorder serialises the object as a
    // last resort. Unfiltered, that fallback writes `thinking` into a record that is not marked as
    // reasoning - the one place the switch could be bypassed by payload shape rather than policy.
    const text = toolResultText({ ok: true, thinking: "SECRET-CHAIN-FALLBACK", detail: "kept" });
    expect(text).toContain("kept");
    expect(text ?? "").not.toContain("SECRET-CHAIN-FALLBACK");
    expect(text ?? "").not.toContain("thinking");
    // A content array still wins, and reasoning parts in it stay the runtime's business.
    expect(toolResultText({ content: [{ type: "text", text: "plain result" }] })).toBe("plain result");
  });

  it("never returns a flush cut inside a surrogate pair", () => {
    // The ceiling walks code points; a future edit back to `held.length` arithmetic would split
    // emoji in half. Swept across every ceiling the recorder can be given.
    const mixed = "\u{1F600}a\u4e2d ".repeat(60);
    const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
    for (let maxBytes = 1; maxBytes <= 600; maxBytes += 7) {
      const cut = flushPoint(mixed, false, 80, maxBytes);
      expect(isHigh(mixed.charCodeAt(cut - 1))).toBe(false);
      expect(Buffer.byteLength(mixed.slice(0, cut))).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("does not write an empty record when a final flush has nothing left to show", () => {
    // Leading blanks are dropped from a chunk, so a whitespace-only closing message would
    // otherwise store a record whose text is empty: noise an operator reads as a missing line.
    const { rec, records } = recorder("assistant", { reasoning: true });
    rec.onAssistantText("   " + String.fromCharCode(9) + "  ", true);
    rec.onReasoningText(" ", true);
    expect(records).toHaveLength(0);
    // The cursor still moved, so a later message is not treated as a continuation of nothing.
    rec.onAssistantText("Real narration after the blank message.", true);
    expect(records).toHaveLength(1);
    expect(String(records[0]?.text)).toContain("Real narration");
  });

  it("records nothing at all while the dial is none", () => {
    const { rec, records } = recorder("none");
    rec.onAssistantText("hello");
    rec.noteArgs("tc1", { summary: "cmd=ls", full: '{"command":"ls"}' });
    rec.onToolPartial("tc1", "bash", "line\nline2");
    rec.onToolResult("tc1", "bash", true, "output");
    expect(records).toEqual([]);
  });
});

describe("the observer view of a content block", () => {
  const fifteen = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join(String.fromCharCode(10));

  it("shows the newest lines and announces how many were hidden", () => {
    const body = formatExpertEventBody({ text: fifteen }, { maxLines: 10, maxChars: 120 });
    expect(body).toHaveLength(11); // the notice plus ten shown lines
    expect(body[0]).toContain("5 earlier lines not shown");
    expect(body[body.length - 1]).toBe("line 15");
    expect(body[1]).toBe("line 6");
  });

  it("clamps one enormous line rather than wrapping the console", () => {
    const body = formatExpertEventBody({ text: "y".repeat(5000) }, { maxLines: 10, maxChars: 40 });
    expect(body).toHaveLength(1);
    expect((body[0] ?? "").length).toBe(40);
    expect((body[0] ?? "").endsWith(String.fromCharCode(0x2026))).toBe(true);
  });

  it("strips control characters and ignores blank payloads", () => {
    const esc = String.fromCharCode(27);
    const body = formatExpertEventBody({ text: `plain${esc}[31mred${String.fromCharCode(0)}` }, { maxLines: 5, maxChars: 120 });
    expect(body.join("")).not.toContain(esc);
    expect(formatExpertEventBody({ text: "   " }, { maxLines: 5, maxChars: 120 })).toEqual([]);
    expect(formatExpertEventBody({}, { maxLines: 5, maxChars: 120 })).toEqual([]);
  });

  it("treats exactly the two content kinds as content", () => {
    const content = EXPERT_EVENT_KINDS.filter((kind) => isContentEvent({ kind }));
    expect(content).toEqual(["assistant_text", "tool_output"]);
  });
});

/**
 * End to end through the runtime: Pi session events are replayed by the fake prompt, the
 * recorder runs on real event shapes, and the assertions read the stream file the delegation
 * actually wrote. No model is contacted.
 */
function streamHarness() {
  const events: unknown[] = [];
  let fire: ((event: unknown) => void) | undefined;
  const nativeModel = { provider: "p", id: "m" };
  const modelRuntime = {
    getAvailable: async () => [
      {
        provider: "p", id: "m", name: "Mock", reasoning: true, contextWindow: 100_000, maxTokens: 4_000,
        input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    getModel: () => nativeModel,
  };
  class Loader {
    constructor(_options: Record<string, unknown>) {}
    async reload() {}
    getSkills() { return { skills: [], diagnostics: [] }; }
    getExtensions() { return { extensions: [], diagnostics: [] }; }
  }
  const sdk = {
    SettingsManager: { create: () => ({}) },
    DefaultResourceLoader: Loader,
    getAgentDir: () => path.resolve(".pi-test-agent"),
    ModelRuntime: { create: async () => modelRuntime },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({
      session: {
        // Pi's own callback ordering: the run narrates, calls tools, and finishes.
        prompt: async () => {
          for (const event of events) fire?.(event);
        },
        waitForIdle: async () => {},
        dispose: () => {},
        subscribe: (callback: (event: unknown) => void) => {
          fire = callback;
          return () => undefined;
        },
        setActiveToolsByName: () => {},
        state: {
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ status: "success", summary: "done" }) }],
          }],
        },
      },
    }),
  } as unknown as PiSdkLike;
  return { sdk, events, modelRuntime };
}

const ASSISTANT_EVENTS = [
  { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "the race is in " }] } },
  { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "the race is in applyHotplug()" }] } },
  {
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "SECRET-CHAIN-OF-THOUGHT" },
        { type: "text", text: "the race is in applyHotplug() and the lock is held" },
      ],
    },
  },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the race is in applyHotplug() and the lock is held" }] } },
  { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "npm test --silent" } },
  {
    type: "tool_execution_update",
    toolCallId: "tc1",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "running tests\nfirst block\n" + "watching the suite ".repeat(20) + "\n" }] },
  },
  {
    type: "tool_execution_end",
    toolCallId: "tc1",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "running tests\nfirst block\nTests  369 passed (369)" }] },
  },
];

async function readStream(dir: string, executionId: string): Promise<ExpertObservabilityEvent[]> {
  const raw = await readFile(path.join(dir, `${executionId}.jsonl`), "utf8");
  return raw
    .split(String.fromCharCode(10))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExpertObservabilityEvent);
}

async function runStream(options: { level?: ContentStreamLevel; reasoning?: boolean; reasoningEnv?: string; byRole?: Record<string, ContentStreamLevel>; envValue?: string; events?: unknown[]; fileBytes?: number; executionId?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), "ec-content-"));
  const previousEnv = process.env.EXPERT_COUNCIL_CONTENT;
  const previousReasoningEnv = process.env.EXPERT_COUNCIL_REASONING;
  if (options.envValue !== undefined) process.env.EXPERT_COUNCIL_CONTENT = options.envValue;
  if (options.reasoningEnv !== undefined) process.env.EXPERT_COUNCIL_REASONING = options.reasoningEnv;
  try {
    const { sdk, events, modelRuntime } = streamHarness();
    events.push(...(options.events ?? ASSISTANT_EVENTS));
    const runtime = await PiExpertRuntime.create({
      cwd: process.cwd(),
      config: parseCouncilConfig({
        security: {
          observability: {
            expertWindow: "interactive",
            ...(options.level ? { contentStream: options.level } : {}),
            ...(options.byRole ? { contentByRole: options.byRole } : {}),
            ...(options.fileBytes ? { contentFileBytes: options.fileBytes } : {}),
            ...(options.reasoning ? { recordReasoning: true } : {}),
          },
        },
      }),
      sdk,
      modelRuntime: modelRuntime as never,
      roleDirectory,
      observabilityDir: dir,
    });
    const result = await runtime.executeExpert({
      executionId: options.executionId ?? "exec_content",
      role: "scout",
      task: "trace the hotplug race",
      model: "p/m",
      tools: ["read", "grep"],
      skills: [],
      readOnly: true,
      workspace: process.cwd(),
      timeoutMs: 20_000,
      attempt: 1,
    });
    return { dir, result, runtime, events: await readStream(dir, options.executionId ?? "exec_content") };
  } finally {
    if (previousEnv === undefined) delete process.env.EXPERT_COUNCIL_CONTENT;
    else process.env.EXPERT_COUNCIL_CONTENT = previousEnv;
    if (previousReasoningEnv === undefined) delete process.env.EXPERT_COUNCIL_REASONING;
    else process.env.EXPERT_COUNCIL_REASONING = previousReasoningEnv;
    // The caller reads the file before this cleanup runs, via the returned dir.
  }
}

describe("the stream records what the dial promises", () => {
  it("streams assistant text once, and never leaks a thinking part", async () => {
    const { dir, events, result } = await runStream({ level: "transcript" });
    try {
      expect(result.status).toBe("success");
      const narration = events.filter((event) => event.kind === "assistant_text");
      const joined = narration.map((event) => event.text ?? "").join("");
      expect(joined).toBe("the race is in applyHotplug() and the lock is held");
      expect(joined.includes("the race is in applyHotplug()the race")).toBe(false);
      // The red line: a `thinking` part inside the same message must not reach disk.
      const raw = await readFile(path.join(dir, "exec_content.jsonl"), "utf8");
      expect(raw.includes("SECRET-CHAIN-OF-THOUGHT")).toBe(false);
      expect(raw.includes("thinking")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a streamed tool block and its complete final record, with a line pointer", async () => {
    const { dir, events } = await runStream({ level: "transcript" });
    try {
      const tool = events.filter((event) => event.kind === "tool_output");
      expect(tool.length).toBeGreaterThanOrEqual(2);
      expect(tool.some((event) => event.streaming === true)).toBe(true);
      const final = tool[tool.length - 1];
      expect(final?.streaming).toBeUndefined();
      expect(final?.ok).toBe(true);
      expect(final?.text ?? "").toContain("Tests  369 passed (369)");
      expect(typeof final?.line).toBe("number");
      // The pointer must actually point at the record it describes.
      const raw = (await readFile(path.join(dir, "exec_content.jsonl"), "utf8")).split(String.fromCharCode(10));
      const at = Number(final?.line);
      expect(JSON.parse(String(raw[at - 1])).kind).toBe("tool_output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes arguments at the top dial only", async () => {
    const quiet = await runStream({ level: "transcript", executionId: "exec_quiet_args" });
    try {
      const raw = await readFile(path.join(quiet.dir, "exec_quiet_args.jsonl"), "utf8");
      expect(raw.includes("npm test --silent")).toBe(false);
    } finally {
      await rm(quiet.dir, { recursive: true, force: true });
    }
    const loud = await runStream({ level: "transcript+args", executionId: "exec_with_args" });
    try {
      const raw = await readFile(path.join(loud.dir, "exec_with_args.jsonl"), "utf8");
      expect(raw.includes("npm test --silent")).toBe(true);
    } finally {
      await rm(loud.dir, { recursive: true, force: true });
    }
  });

  it("keeps the historical single-line behaviour while the dial is none", async () => {
    const { dir, events } = await runStream({});
    try {
      expect(events.some((event) => event.kind === "tool_output")).toBe(false);
      const narration = events.filter((event) => event.kind === "assistant_text");
      expect(narration).toHaveLength(1);
      expect(narration[0]?.text).toBe("the race is in applyHotplug() and the lock is held");
      const raw = await readFile(path.join(dir, "exec_content.jsonl"), "utf8");
      expect(raw.includes("SECRET-CHAIN-OF-THOUGHT")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces the bare name lines with the block once a dial records tool output", async () => {
    // The window showed `tool read`, `tool read ok`, then a block repeating both. Once a dial
    // records the output, that output carries the tool name, the arguments and the result, so
    // the name lines are pure duplication. At the lower dials there is no block, and hiding
    // them there would leave an operator with no tool visibility at all - the worse trade.
    const loud = await runStream({ level: "transcript", executionId: "exec_loud_lines" });
    const loudKinds = loud.events.map((record) => record.kind);
    expect(loudKinds).toContain("tool_output");
    expect(loudKinds).not.toContain("tool_started");
    expect(loudKinds).not.toContain("tool_finished");

    const quiet = await runStream({ level: "assistant", executionId: "exec_quiet_lines" });
    const quietKinds = quiet.events.map((record) => record.kind);
    expect(quietKinds).toContain("tool_started");
    expect(quietKinds).toContain("tool_finished");
    expect(quietKinds).not.toContain("tool_output");
  });

  it("keeps thinking off disk by default and writes it, marked, when the operator opts in", async () => {
    // The scripted session carries a `thinking` part and a `text` part in the same message, which
    // is the shape that would let reasoning slip in unnoticed. Default: only the text is stored.
    const off = await runStream({ level: "assistant", executionId: "exec_reason_off" });
    expect(off.events.some((event) => JSON.stringify(event).includes("SECRET-CHAIN-OF-THOUGHT"))).toBe(false);
    expect(off.events.some((event) => event.reasoning === true)).toBe(false);

    // Opted in through configuration: the same session now stores it, and marks it.
    const on = await runStream({ level: "assistant", reasoning: true, executionId: "exec_reason_cfg" });
    const marked = on.events.filter((event) => event.reasoning === true);
    expect(marked.length).toBeGreaterThan(0);
    expect(String(marked[0]?.text)).toContain("SECRET-CHAIN-OF-THOUGHT");
    // Narration in the same run is still present and still unmarked.
    expect(on.events.some((event) => event.kind === "assistant_text" && event.reasoning === undefined)).toBe(true);

    // The environment can raise it for one process, and cannot be raised by anything else.
    const env = await runStream({ level: "assistant", reasoningEnv: "1", executionId: "exec_reason_env" });
    expect(env.events.some((event) => event.reasoning === true)).toBe(true);
    const rejected = await runStream({ level: "assistant", reasoningEnv: "maybe", executionId: "exec_reason_bad" });
    expect(rejected.events.some((event) => event.reasoning === true)).toBe(false);

    // And the switch alone buys nothing: with the dial off there is no content recorder, so the
    // only narration on disk is the bounded end-of-message summary that predates all of this, and
    // no record may carry the reasoning marker or the thinking text.
    const dialOff = await runStream({ level: "none", reasoning: true, executionId: "exec_reason_dialoff" });
    expect(dialOff.events.filter((event) => event.reasoning === true)).toHaveLength(0);
    expect(dialOff.events.some((event) => JSON.stringify(event).includes("SECRET-CHAIN-OF-THOUGHT"))).toBe(false);
  });

  it("honours a per-role dial", async () => {
    const { dir, events } = await runStream({ level: "transcript", byRole: { scout: "assistant" } });
    try {
      expect(events.some((event) => event.kind === "assistant_text")).toBe(true);
      expect(events.some((event) => event.kind === "tool_output")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets the environment dial win for one run and reports a rejected value", async () => {
    const raised = await runStream({ level: "none", envValue: "transcript", executionId: "exec_env_dial" });
    try {
      expect(raised.events.some((event) => event.kind === "tool_output")).toBe(true);
    } finally {
      await rm(raised.dir, { recursive: true, force: true });
    }
    const rejected = await runStream({ level: "none", envValue: "yes-please", executionId: "exec_env_bad" });
    try {
      expect(rejected.events.some((event) => event.kind === "tool_output")).toBe(false);
      const capabilities = await rejected.runtime.getCapabilities();
      expect(capabilities.limitations.join(" ")).toContain("EXPERT_COUNCIL_CONTENT");
    } finally {
      await rm(rejected.dir, { recursive: true, force: true });
    }
  });

  it("drops content but keeps observing when the file ceiling is reached", async () => {
    const big = (marker: string) => ({
      type: "tool_execution_end",
      toolCallId: `tc-${marker}`,
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: `${marker}${"z".repeat(60_000)}` }] },
    });
    const { dir, events, result } = await runStream({
      level: "transcript",
      fileBytes: 65_536,
      executionId: "exec_overflow",
      events: [
        big("A"),
        big("B"),
        big("C"),
        big("D"),
        ...ASSISTANT_EVENTS,
      ],
    });
    try {
      // The delegation still succeeds, the ceiling is announced rather than going quiet, and
      // the terminator the follower waits on is never the thing that got dropped.
      expect(result.status).toBe("success");
      expect(events.some((event) => event.kind === "stream_truncated")).toBe(true);
      const written = events.filter((event) => event.kind === "tool_output");
      expect(written.length).toBeGreaterThan(0);
      expect(written.length).toBeLessThan(4);
      // Content stopped, the ceiling was announced, and the outcome still arrived. Only this
      // runtime-level call can end the file here: the delegation-level `delegation_final`
      // marker is written by the service on top of it, and the same exempt list covers both.
      expect(events[events.length - 1]?.kind).toBe("completed");
      expect(events.some((event) => event.kind === "tool_output")).toBe(true);
      expect(events.some((event) => event.kind === "assistant_text")).toBe(false); // dropped after the cap
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the stream directory has a budget", () => {
  async function seed(dir: string, names: string[], bytes: number, agesMinutes: number[]) {
    for (const [index, name] of names.entries()) {
      const file = path.join(dir, name);
      await writeFile(file, "s".repeat(bytes), "utf8");
      const when = new Date(Date.now() - (agesMinutes[index] ?? 0) * 60_000);
      await utimes(file, when, when);
    }
  }

  async function runtimeWithBudget(dir: string, totalBytes: number) {
    const { sdk, modelRuntime } = streamHarness();
    return PiExpertRuntime.create({
      cwd: process.cwd(),
      config: parseCouncilConfig({
        security: {
          observability: {
            expertWindow: "interactive",
            contentStream: "transcript",
            contentTotalBytes: totalBytes,
          },
        },
      }),
      sdk,
      modelRuntime: modelRuntime as never,
      roleDirectory,
      observabilityDir: dir,
    });
  }

  it("evicts oldest-first down to the ceiling, and never the newest stream", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ec-budget-"));
    try {
      // 900 KB of streams against a 500 KB ceiling: the two older ones go, the newest stays.
      // "Newest stays" matters beyond tidiness: a live stream always has the newest
      // modification time, so a budget sweep cannot delete what a window is following.
      await seed(dir, ["exec_old.jsonl", "exec_mid.jsonl", "exec_new.jsonl"], 300_000, [30, 20, 1]);
      await runtimeWithBudget(dir, 500_000);
      expect(existsSync(path.join(dir, "exec_old.jsonl"))).toBe(false);
      expect(existsSync(path.join(dir, "exec_mid.jsonl"))).toBe(false);
      expect(existsSync(path.join(dir, "exec_new.jsonl"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the directory alone while it is under the ceiling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ec-budget-ok-"));
    try {
      await seed(dir, ["exec_a.jsonl", "exec_b.jsonl"], 100_000, [30, 1]);
      await runtimeWithBudget(dir, 5_000_000);
      expect(existsSync(path.join(dir, "exec_a.jsonl"))).toBe(true);
      expect(existsSync(path.join(dir, "exec_b.jsonl"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
