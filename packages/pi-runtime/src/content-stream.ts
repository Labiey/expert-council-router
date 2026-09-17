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
  const head = text.slice(0, chars);
  const tail = text.slice(text.length - chars);
  const seam = `
[+${bytes - headTailBytes(head, tail)} bytes between head and tail omitted]
`;
  return { text: head + seam + tail, omittedBytes: bytes - Buffer.byteLength(head) - Buffer.byteLength(tail) };
}

function headTailBytes(head: string, tail: string): number {
  return Buffer.byteLength(head) + Buffer.byteLength(tail);
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
  /** What has already been written for the current narration stream. */
  private assistantSent = "";
  /** Arguments seen at `tool_execution_start`, keyed for the closing record. */
  private readonly pendingArgs = new Map<string, string>();
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
   * A cumulative assistant message. One slot is enough: if the new text starts with what was
   * already sent, the remainder is appended; anything else is a new block and is written whole.
   * Keying on message-object identity was tried first and re-sent the entire paragraph at
   * `message_end`, because the runtime is not promised the same object twice.
   *
   * A live model narrates in fragments too small to be worth a record - measured on a real
   * run at 129 records for 2.2 KB, which would exhaust the event ceiling inside a long answer
   * - so a fragment is held until it completes a line or reaches 240 bytes, exactly like a
   * streamed tool block. `final` flushes whatever is held, because dropping the last sentence
   * of a message would be the worst possible place to lose text.
   */
  onAssistantText(fullText: string, final = false): void {
    if (!recordsAssistant(this.options.level) || !fullText) return;
    const sent = this.assistantSent;
    const fresh = fullText.startsWith(sent) ? fullText.slice(sent.length) : fullText;
    if (!fresh) return;
    if (!final && !fresh.includes("\n") && Buffer.byteLength(fresh) < 240) return;
    this.assistantSent = fullText;
    this.bytesConsidered += Buffer.byteLength(fresh);
    this.push("assistant_text", { text: headTailSeam(fresh, this.options.eventBytes).text });
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
   * `result`/`isError` - so the top dial has to remember them until the record is written.
   */
  noteArgs(callId: string, tool: string, argsText: string): void {
    if (!recordsToolArgs(this.options.level)) return;
    this.pendingArgs.set(callId, argsText);
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
    const argsText = this.pendingArgs.get(callId);
    if (argsText !== undefined) {
      this.pendingArgs.delete(callId);
      fields.argsText = headTailSeam(argsText, this.options.eventBytes).text;
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
