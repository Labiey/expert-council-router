import type { ContentStreamLevel } from "@expert-council/core";

/**
 * What the observability stream records about a running expert.
 *
 * The stream exists so a second terminal can follow a delegation without the Main Agent
 * spending context on it. Historically it carried names and counters only. These dials widen
 * that in ascending order of what reaches disk, so an operator picks the exposure rather than
 * inheriting it from a boolean - recorded content is plaintext project material, and the top
 * dial also records shell commands and paths.
 *
 * Deliberately absent here: any notion of *who* asked. The level is resolved from
 * configuration and the environment only, never from a delegation request, because a task
 * text or a tool argument must not be able to turn recording on.
 */
export interface ContentRecorderOptions {
  level: ContentStreamLevel;
  /** Cap for one stored payload; beyond it a head+tail seam is written instead. */
  eventBytes: number;
  /**
   * Record model reasoning as well as narration. Off unless the operator set
   * `security.observability.recordReasoning` or `EXPERT_COUNCIL_REASONING`; it also requires a
   * dial that records assistant text, because reasoning travels in the same message. Nothing on a
   * delegation request can raise it - see the note in SECURITY.md about why.
   */
  reasoning?: boolean;
  /** Narration is held until it reaches this many bytes, then flushed at a boundary. */
  minFlushBytes?: number;
  /** Ceiling for held narration; an oversized cut backs off to the last whitespace. */
  maxFlushBytes?: number;
  /** One record per line of the stream file, so the emitter can supply the line pointer. */
  emit: (kind: "assistant_text" | "tool_output", fields: Record<string, unknown>) => void;
  /** Test seam. */
  now?: () => number;
}

/** Dials at which assistant text is recorded, incrementally rather than once at the end. */
const RECORDS_ASSISTANT: ReadonlySet<ContentStreamLevel> = new Set<ContentStreamLevel>([
  "assistant",
  "assistant+tool-tail",
  "transcript",
  "transcript+args",
]);
/** Dials at which a tool result is recorded, and whether the whole of it is. */
const RECORDS_TOOL: ReadonlySet<ContentStreamLevel> = new Set<ContentStreamLevel>([
  "assistant+tool-tail",
  "transcript",
  "transcript+args",
]);
const FULL_TOOL: ReadonlySet<ContentStreamLevel> = new Set<ContentStreamLevel>(["transcript", "transcript+args"]);
const FULL_ARGS: ReadonlySet<ContentStreamLevel> = new Set<ContentStreamLevel>(["transcript+args"]);

export function recordsAssistant(level: ContentStreamLevel): boolean {
  return RECORDS_ASSISTANT.has(level);
}
export function recordsToolOutput(level: ContentStreamLevel): boolean {
  return RECORDS_TOOL.has(level);
}
export function recordsToolArgs(level: ContentStreamLevel): boolean {
  return FULL_ARGS.has(level);
}

/**
 * Resolve the dial for one execution: built-in `none` < global `contentStream` <
 * `contentByRole[role]` < `EXPERT_COUNCIL_CONTENT`. An unrecognised environment value is
 * reported rather than guessed at, because silently ignoring the knob an operator reached for
 * is how a security setting becomes folklore.
 */
export function resolveContentLevel(input: {
  levels: readonly ContentStreamLevel[];
  global: ContentStreamLevel;
  byRole?: Partial<Record<string, ContentStreamLevel>>;
  role: string;
  envValue?: string;
}): { level: ContentStreamLevel; warning?: string } {
  const fromRole = input.byRole?.[input.role] ?? input.global;
  if (input.envValue === undefined || input.envValue === "") return { level: fromRole };
  // Narrowing does not survive into the callback below, so read the value once, first.
  const wanted = input.envValue.trim();
  const match = input.levels.find((level) => level === wanted);
  if (!match) {
    return {
      level: fromRole,
      warning: `EXPERT_COUNCIL_CONTENT="${input.envValue}" is not one of ${input.levels.join(" | ")}; using ${fromRole}`,
    };
  }
  return { level: match };
}

/**
 * Cut a payload to `maxBytes`, keeping the head and the tail and naming the gap. The tail is
 * the part that decides most debugging questions (the failing line is at the end), while the
 * head identifies what the block is; a bare truncation would hide that anything went missing.
 */
export function headTailSeam(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, omittedBytes: 0 };
  const chars = Math.max(0, Math.floor(maxBytes / 2) - 40);
  if (chars < 1) return { text: "", omittedBytes: bytes };
  // Slicing by UTF-16 index can cut an astral character in half and leave a lone surrogate in the
  // stored text, which then survives JSON and shows up as a replacement glyph. Snap both edges
  // back onto a character boundary.
  const head = snapToBoundary(text.slice(0, chars), "end");
  const tail = snapToBoundary(text.slice(text.length - chars), "start");
  const seam = `
[+${bytes - headTailBytes(head, tail)} bytes between head and tail omitted]
`;
  return { text: head + seam + tail, omittedBytes: bytes - Buffer.byteLength(head) - Buffer.byteLength(tail) };
}

function headTailBytes(head: string, tail: string): number {
  return Buffer.byteLength(head) + Buffer.byteLength(tail);
}

/** Drop a split surrogate from one edge of a byte-sliced string. */
function snapToBoundary(text: string, edge: "start" | "end"): string {
  if (text.length === 0) return text;
  if (edge === "end") {
    const last = text.charCodeAt(text.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
  }
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

/**
 * How much held narration to write now; 0 means keep holding. A boundary is a line end or a
 * sentence end. The ceiling exists so an unbroken wall of text still arrives eventually, and it
 * backs off to the last whitespace rather than cutting a word in half - that mid-word cut is
 * what the operator saw as `"Def` / `ect numbers` in the window.
 */
const NARRATION_BOUNDARY = /[\n.!?\u3002\uff01\uff1f]["')\]]?$/;

export function flushPoint(held: string, final: boolean, minBytes = 80, maxBytes = 600): number {
  if (final) return held.length;
  const bytes = Buffer.byteLength(held);
  if (bytes >= minBytes && NARRATION_BOUNDARY.test(held)) return held.length;
  if (bytes < maxBytes) return 0;
  // The ceiling is stated in bytes but a cut is a UTF-16 index, and one CJK character is three
  // bytes: measuring the limit in units emitted 1500 bytes against a 600-byte ceiling. Walk
  // forward by code points to the last index that still fits, which also cannot split a pair.
  let ceiling = 0;
  let used = 0;
  for (const character of held) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) break;
    used += size;
    ceiling += character.length;
  }
  for (let index = ceiling; index > 0; index -= 1) {
    const char = held[index - 1];
    // Include the whitespace in what is emitted, so the held remainder starts on a word.
    if (char === " " || char === "\t" || char === "\n") return index;
  }
  // One enormous unbroken token: nothing better exists, and stalling forever is worse.
  return ceiling;
}
/** Keep only the tail of a payload: the `assistant+tool-tail` storage policy. The cut is
 * byte-exact and walks back from the end, so a multi-byte character is never split. */
export function tailOnly(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, omittedBytes: 0 };
  let start = text.length;
  let used = 0;
  while (start > 0) {
    const code = text.codePointAt(start - 1) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + size > maxBytes) break;
    used += size;
    start -= code > 0xffff ? 2 : 1;
  }
  return { text: text.slice(start), omittedBytes: bytes - used };
}

/** One streamed tool block's progress: characters seen and lines seen. */
interface StreamState {
  chars: number;
  lines: number;
}

export class ContentRecorder {
  /**
   * What has already been written per channel, and the last cumulative text seen for it.
   * The second half is not redundant: a closing event may carry a message without the part that
   * was streamed earlier (Pi's `message_end` does not repeat `thinking` content), and a flush
   * driven by an empty string would then discard whatever was still held - losing the last
   * sentence, which is the one thing this design promised not to do.
   */
  private readonly narration = new Map<"text" | "reasoning", { sent: string; last: string }>();
  /** Arguments seen at `tool_execution_start`, keyed for the closing record. */
  private readonly pendingArgs = new Map<string, { summary?: string; full?: string }>();
  private readonly toolStreams = new Map<string, StreamState>();
  private bytesConsidered = 0;
  private recordsWritten = 0;

  constructor(private readonly options: ContentRecorderOptions) {}

  get level(): ContentStreamLevel {
    return this.options.level;
  }

  /** What this execution contributed to the stream file (reported through runtime limitations). */
  get stats(): { bytes: number; records: number } {
    return { bytes: this.bytesConsidered, records: this.recordsWritten };
  }

  /**
   * A cumulative assistant message. One slot is enough: text that extends what was already
   * sent appends only the new characters; anything else is a new block and is written whole.
   * Keying on message-object identity was tried first and re-sent the entire paragraph at
   * `message_end`, because the runtime is not promised the same object twice.
   *
   * When to write is a readability decision, measured rather than imagined. The first rule
   * ("a newline or 240 bytes is worth a record") produced 28 records for 4.2 KB on a real
   * run - two of them nothing but `],`, and three splitting the word "Defect" across records,
   * because a byte threshold cuts wherever it lands. So: hold a short fragment, flush at a
   * line or sentence boundary once there is something to say, and when a fragment must be
   * cut, cut it at the last whitespace instead of mid-word. `final` flushes the remainder,
   * because losing the last sentence is the worst possible place to lose text.
   */
  onAssistantText(fullText: string, final = false): void {
    this.narrate("text", fullText, final, true);
  }

  /**
   * The same rule as narration, on its own cursor, and only when the operator asked for it.
   * Recorded as an `assistant_text` event carrying `reasoning: true` rather than a new kind: the
   * event whitelist, the retention rules and the ceilings all already apply, and the only thing
   * that must differ is whether an operator can tell the two apart when reading - which is what
   * the marker is for, in both renderers.
   */
  onReasoningText(fullText: string, final = false): void {
    this.narrate("reasoning", fullText, final, this.options.reasoning === true);
  }

  private narrate(channel: "text" | "reasoning", fullText: string, final: boolean, enabled: boolean): void {
    if (!enabled || !recordsAssistant(this.options.level)) return;
    const state = this.narration.get(channel) ?? { sent: "", last: "" };
    if (fullText) state.last = fullText;
    // Stored before any decision to hold, or the text we chose not to write yet would be
    // forgotten by the very call that decided to keep holding it.
    this.narration.set(channel, state);
    if (!state.last) return;
    const continuation = state.last.startsWith(state.sent);
    const held = continuation ? state.last.slice(state.sent.length) : state.last;
    if (!held) return;
    const cut = flushPoint(held, final, this.options.minFlushBytes, this.options.maxFlushBytes);
    if (cut <= 0) return;
    const emitText = held.slice(0, cut);
    if (!final && !emitText.trim()) return;
    state.sent = continuation ? state.sent + emitText : emitText;
    this.narration.set(channel, state);
    this.bytesConsidered += Buffer.byteLength(emitText);
    this.bytesConsidered += Buffer.byteLength(emitText);
    this.push("assistant_text", {
      text: headTailSeam(emitText, this.options.eventBytes).text,
      ...(channel === "reasoning" ? { reasoning: true } : {}),
    });
  }

  /**
   * A growing tool result. Recorded live only when it has actually grown a line (or 240
   * characters), so a chatty command cannot write one event per token; the complete record at
   * the end supersedes the partial view for anyone reading the file.
   */
  onToolPartial(callId: string, tool: string, partialText: string): void {
    if (!recordsToolOutput(this.options.level) || !partialText) return;
    const seen = this.toolStreams.get(callId) ?? { chars: 0, lines: 0 };
    const lines = countLines(partialText);
    if (partialText.length <= seen.chars) return;
    if (lines <= seen.lines && partialText.length - seen.chars < 240) return;
    const fresh = partialText.slice(seen.chars);
    this.toolStreams.set(callId, { chars: partialText.length, lines });
    this.bytesConsidered += Buffer.byteLength(fresh);
    this.push("tool_output", { tool, streaming: true, text: headTailSeam(fresh, this.options.eventBytes).text });
  }

  /**
   * Pi forwards arguments on `tool_execution_start` only - the closing event carries just
   * `result`/`isError` - so the recorder holds whatever is allowed until the record is written.
   * The bounded summary is governed by `redactToolArgs` (the caller hands it over only when
   * redaction is off); the full text only ever arrives from the top dial. Carrying them on the
   * same record as the result is deliberate: a follower that had to pair two events would need
   * state across lines and could not survive a capped or truncated stream.
   */
  noteArgs(callId: string, args: { summary?: string; full?: string }): void {
    if (!recordsToolOutput(this.options.level)) return;
    if (args.summary === undefined && args.full === undefined) return;
    this.pendingArgs.set(callId, args);
  }

  /**
   * A finished tool call. `transcript` and above store the whole payload behind a head+tail
   * seam; `assistant+tool-tail` stores only the tail, which is what the dial's name promises.
   */
  onToolResult(callId: string, tool: string, ok: boolean, resultText: string | null): void {
    if (!recordsToolOutput(this.options.level)) return;
    const full = resultText ?? "";
    const seam = FULL_TOOL.has(this.options.level)
      ? headTailSeam(full, this.options.eventBytes)
      : tailOnly(full, this.options.eventBytes);
    const fields: Record<string, unknown> = { tool, ok };
    if (seam.omittedBytes > 0) fields.omittedBytes = seam.omittedBytes;
    fields.text = resultText === null ? "[no result returned]" : seam.text;
    const args = this.pendingArgs.get(callId);
    if (args) {
      this.pendingArgs.delete(callId);
      if (recordsToolArgs(this.options.level) && args.full !== undefined) {
        fields.argsText = headTailSeam(args.full, this.options.eventBytes).text;
      } else if (args.summary !== undefined) {
        fields.argsSummary = args.summary;
      }
    }
    this.bytesConsidered += Buffer.byteLength(seam.text);
    this.toolStreams.set(callId, { chars: Number.MAX_SAFE_INTEGER, lines: Number.MAX_SAFE_INTEGER });
    this.push("tool_output", fields);
  }

  private push(kind: "assistant_text" | "tool_output", fields: Record<string, unknown>): void {
    this.recordsWritten += 1;
    try {
      this.options.emit(kind, fields);
    } catch {
      // Observation is never a dependency of the run.
    }
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  return lines;
}
