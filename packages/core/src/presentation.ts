import type { CouncilPlan, ExpertEventKind, ExpertObservabilityEvent, ResourceInventory } from "./types.js";

export type PresentationDetail = "compact" | "full";

export function presentResourceInventory(inventory: ResourceInventory, detail: PresentationDetail = "compact") {
  if (detail === "full") return inventory;

  const providers = new Map<string, {
    provider: string;
    modelCount: number;
    reasoningModelCount: number;
    billingType: string;
    billingSource?: string;
    billingReason?: string;
  }>();
  for (const model of inventory.models) {
    const current = providers.get(model.provider) ?? {
      provider: model.provider,
      modelCount: 0,
      reasoningModelCount: 0,
      billingType: inventory.billing[model.billingProfile ?? model.provider]?.billingType ?? "unknown",
      ...(inventory.billingSources?.[model.billingProfile ?? model.provider]
        ? {
            billingSource: inventory.billingSources[model.billingProfile ?? model.provider]!.source,
            billingReason: inventory.billingSources[model.billingProfile ?? model.provider]!.reason,
          }
        : {}),
    };
    current.modelCount += 1;
    if (model.reasoning) current.reasoningModelCount += 1;
    providers.set(model.provider, current);
  }

  return {
    summary: {
      modelCount: inventory.models.length,
      providerCount: providers.size,
      enabledSkillCount: inventory.skills.filter((skill) => skill.installed && skill.enabled).length,
      roleCount: inventory.roles.length,
    },
    providers: [...providers.values()],
    roles: inventory.roles.map((role) => ({ role: role.role, readOnly: role.readOnly })),
    skills: inventory.skills
      .filter((skill) => skill.installed && skill.enabled)
      .map((skill) => skill.name),
    runtimeCapabilities: {
      hostType: inventory.runtimeCapabilities.hostType,
      modelDiscovery: inventory.runtimeCapabilities.modelDiscovery,
      hardToolRestriction: inventory.runtimeCapabilities.hardToolRestriction,
      skillOverride: inventory.runtimeCapabilities.skillOverride,
      subagentBackend: inventory.runtimeCapabilities.subagentBackend,
      realtimeInteraction: inventory.runtimeCapabilities.realtimeInteraction,
      dynamicToolPermissions: inventory.runtimeCapabilities.dynamicToolPermissions,
      mutation: inventory.runtimeCapabilities.mutation,
      workspaceIsolation: inventory.runtimeCapabilities.workspaceIsolation,
      ...(inventory.runtimeCapabilities.sourceWorkspaceDirty !== undefined
        ? { sourceWorkspaceDirty: inventory.runtimeCapabilities.sourceWorkspaceDirty }
        : {}),
      ...(inventory.runtimeCapabilities.workspaceProvisioning
        ? { workspaceProvisioning: inventory.runtimeCapabilities.workspaceProvisioning }
        : {}),
      ...(inventory.runtimeCapabilities.eventStream
        ? { eventStream: inventory.runtimeCapabilities.eventStream }
        : {}),
      limitations: inventory.runtimeCapabilities.limitations,
    },
    modelAssessment: inventory.modelAssessmentStatus?.status === "required"
      ? {
          status: "required" as const,
          reason: inventory.modelAssessmentStatus.reason,
          assessedAt: inventory.modelAssessmentStatus.assessedAt,
          maxAgeDays: inventory.modelAssessmentStatus.maxAgeDays,
          requiredModels: inventory.modelAssessmentStatus.requiredModels,
          researchModels: inventory.modelAssessmentStatus.researchModels,
          missingModels: inventory.modelAssessmentStatus.missingModels,
          unavailableAssessedModels: inventory.modelAssessmentStatus.unavailableAssessedModels,
          instructions: inventory.modelAssessmentStatus.instructions,
        }
      : inventory.modelAssessment
        ? {
            status: "current" as const,
            asOf: inventory.modelAssessment.asOf,
            refreshAfter: inventory.modelAssessmentStatus?.refreshAfter,
            modelCount: Object.keys(inventory.modelAssessment.models).length,
            billingProviderCount: Object.keys(inventory.modelAssessment.billing ?? {}).length,
            sources: inventory.modelAssessment.sources,
            ...(inventory.modelAssessment.summary ? { summary: inventory.modelAssessment.summary } : {}),
          }
        : {
            status: "required" as const,
            reason: "missing" as const,
            refreshHint: "A current web-audited modelAssessment is required before expert_build can assemble a council.",
          },
    routePolicy: {
      // `routePolicy` is required on ResourceInventory, so it is read directly. The
      // optional chaining here implied a null case the type never allowed, and a suite
      // nobody typechecked could not notice the difference (defect #27).
      sessionKey: inventory.routePolicy.sessionKey ?? "default",
      effective: inventory.routePolicy.effective ?? {},
      ...(inventory.routePolicy.system ? { system: inventory.routePolicy.system } : {}),
      ...(inventory.routePolicy.session ? { session: inventory.routePolicy.session } : {}),
      ...(inventory.routePolicy.sourcePath ? { sourcePath: inventory.routePolicy.sourcePath } : {}),
    },
    ...(inventory.compositions ? { compositions: inventory.compositions } : {}),
    ...(inventory.operatorConfig ? { operatorConfig: inventory.operatorConfig } : {}),
    ...(inventory.providerLimits ? { providerLimits: inventory.providerLimits } : {}),
    warnings: inventory.warnings,
    detail: "compact" as const,
    fullDetailHint: "Call expert_inspect with detail='full' only when exact model metadata is required.",
  };
}

export function presentCouncilPlan(plan: CouncilPlan, detail: PresentationDetail = "compact") {
  if (detail === "full") return plan;
  return {
    id: plan.id,
    taskClass: plan.taskClass,
    ...(plan.costPolicy ? { costPolicy: plan.costPolicy } : {}),
    ...(plan.composition ? { composition: plan.composition } : {}),
    ...(plan.compositionMenu ? { compositionMenu: plan.compositionMenu } : {}),
    experts: plan.experts.map((expert) => ({
      role: expert.role,
      model: expert.model,
      reason: expert.reason.slice(0, 2),
      readOnly: expert.readOnly,
      ...(expert.reasoningLevel ? { reasoningLevel: expert.reasoningLevel } : {}),
    })),
    warnings: plan.warnings,
    detail: "compact" as const,
    fullDetailHint: "Call expert_build with detail='full' only when alternatives, scores, tools, or skills are required.",
  };
}

/**
 * Every event kind, enumerated through a `Record` over the union so that adding a kind to
 * `ExpertEventKind` without listing it here fails the build rather than falling through to
 * the renderer's default branch. Defect #21 was exactly that class: `attention` had no
 * case, so live warnings reached an operator's terminal as a bare word with the sentence
 * and the numbers dropped on the floor.
 */
const EVENT_KIND_COVERAGE: Record<ExpertEventKind, true> = {
  started: true,
  tool_started: true,
  tool_finished: true,
  assistant_text: true,
  tool_output: true,
  attention: true,
  interaction_opened: true,
  interaction_answered: true,
  stopped: true,
  completed: true,
  failed: true,
  stream_truncated: true,
  delegation_final: true,
};

/** The full set of renderable event kinds, for tests that must stay in step with it. */
export const EXPERT_EVENT_KINDS: readonly ExpertEventKind[] = Object.keys(EVENT_KIND_COVERAGE) as ExpertEventKind[];

/**
 * Render one expert event as a single terminal line. The clamp at the end is deliberate:
 * text fields are bounded where the runtime writes them, but a hand-edited, truncated, or
 * future-versioned stream must never push a second line into an operator's window and
 * desynchronise it from the rest of the tail. Deliberately ANSI-free and single-line:
 * it has to survive Windows pipes, redirection to a file, and interleaving with other
 * sources without corrupting output.
 */
export function formatExpertEvent(event: ExpertObservabilityEvent): string {
  return formatExpertEventLine(event)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatExpertEventLine(event: ExpertObservabilityEvent): string {
  const clock = typeof event.t === "string" && event.t.length >= 19 ? event.t.slice(11, 19) : "--:--:--";
  const head = `${clock} [${event.role}${event.model ? ` ${event.model}` : ""}${typeof event.attempt === "number" && event.attempt > 1 ? ` #${event.attempt}` : ""}]`;
  switch (event.kind) {
    case "started":
      return `${head} started`;
    case "tool_started":
      return `${head} tool ${event.tool ?? "?"}${event.argsSummary ? ` (${event.argsSummary})` : ""}`;
    case "tool_finished":
      return `${head} tool ${event.tool ?? "?"} ${event.ok === false ? "FAILED" : "ok"}`;
    case "assistant_text":
      // Reasoning is labelled as such on purpose: an operator skimming a window must never take
      // what a model thought at itself for what the model told them.
      return `${head} ${event.reasoning === true ? "thinks" : "says"}: ${event.text ?? ""}`;
    case "tool_output": {
      // The header stays one bounded line: what streamed, whether it worked, and where the
      // full record lives. The body is the operator's view of the content itself.
      const bits = [event.tool ?? "tool", event.streaming === true ? "streaming" : "returned"];
      if (event.ok === false) bits.push("error");
      if (typeof event.omittedBytes === "number" && event.omittedBytes > 0) bits.push(`${event.omittedBytes} B omitted`);
      if (typeof event.line === "number") bits.push(`full record on line ${event.line}`);
      return `${head} ${bits.join(" - ")}`;
    }
    case "attention": {
      // A struggle warning is the one event an operator acts on, so it must arrive with
      // its detail and its numbers rather than as a bare kind name.
      const facts = [
        typeof event.budgetFractionUsed === "number" ? `budget ${Math.round(event.budgetFractionUsed * 100)}%` : undefined,
        typeof event.toolErrors === "number" ? `tool errors ${event.toolErrors}/${event.toolCalls ?? 0}` : undefined,
        event.nudgedExpert ? "expert steered" : undefined,
      ].filter((fact): fact is string => fact !== undefined);
      return `${head} WARNING: ${event.text ?? "struggle detected"}${facts.length ? ` (${facts.join(", ")})` : ""}`;
    }
    case "delegation_final":
      return `${head} delegation finished (no further attempts)`;
    case "interaction_opened":
      return `${head} WAITING FOR HOST: ${event.text ?? ""}`;
    case "interaction_answered":
      return `${head} host answered: ${event.text ?? ""}`;
    case "stopped":
      return `${head} stopped by expert: ${event.status ?? "partial"}${event.failureType ? ` (${event.failureType})` : ""}`;
    case "completed":
    case "failed": {
      const duration = typeof event.durationMs === "number" ? ` in ${Math.round(event.durationMs / 1000)}s` : "";
      return `${head} ${event.kind}: ${event.status ?? ""}${event.failureType ? ` (${event.failureType})` : ""}${duration}`;
    }
    case "stream_truncated":
      return `${head} stream truncated: ${event.text ?? "further events dropped"}`;
    default:
      return `${head} ${event.kind}`;
  }
}

/**
 * Kinds that carry recorded conversation content rather than a name and a counter. The
 * follower shows these as a header plus a bounded body; every other kind stays exactly one
 * line, which is what keeps an interleaved terminal from desynchronising (#18).
 */
export const CONTENT_EVENT_KINDS: readonly ExpertEventKind[] = ["assistant_text", "tool_output"];

export function isContentEvent(event: Pick<ExpertObservabilityEvent, "kind">): boolean {
  return (CONTENT_EVENT_KINDS as readonly string[]).includes(event.kind);
}

/**
 * Body lines for an observer window: the *tail* (the newest part is what one watches for),
 * at most `maxLines` lines of the payload plus one notice line when some were hidden - so a
 * caller asking for 10 can receive 11, which the repo's own test pins - each clamped to
 * `maxChars` so a single minified line cannot wrap the console. Control characters are stripped
 * per line - a stream is data, not a terminal protocol - and hidden lines are announced rather
 * than silently dropped (#21's rule that a truncation must be visible where it happened).
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f]", "g");
const ELLIPSIS = "…";

export function formatExpertEventBody(
  event: Pick<ExpertObservabilityEvent, "text">,
  options: { maxLines: number; maxChars: number },
): string[] {
  const raw = typeof event.text === "string" ? event.text : "";
  if (!raw.trim()) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(CONTROL_CHARS, "").replace(/\s+$/g, ""))
    .filter((line) => line.length > 0);
  const width = Math.max(20, options.maxChars);
  const clamped = lines.map((line) => (line.length > width ? line.slice(0, width - 1) + ELLIPSIS : line));
  const wanted = Math.max(1, options.maxLines);
  const shown = clamped.slice(Math.max(0, clamped.length - wanted));
  const hidden = clamped.length - shown.length;
  if (hidden > 0) shown.unshift(`[\u2191 ${hidden} earlier line${hidden === 1 ? "" : "s"} not shown]`);
  return shown;
}

// ---------------------------------------------------------------------------
// Panel rendering - the observer window's layout
// ---------------------------------------------------------------------------

/**
 * The layout an operator actually reads: narration as prose with no per-line attribution, and
 * each tool call as a shaded block whose header names the tool and shows what it was asked to
 * run. The stream file is unaffected - this is a view over it, and `--style plain` keeps the
 * byte-for-byte single-line form for pipes, redirection, and any consumer reading a stream that
 * interleaves several experts, where attribution has to sit on every line.
 */
export interface ExpertPanelOptions {
  /** Console width when known. Used only to pad a coloured block to the full width. */
  columns?: number;
  /** Emit ANSI backgrounds and weights. Off for pipes, `NO_COLOR`, and `TERM=dumb`. */
  color?: boolean;
  /** Tail cap for a block body, in lines. */
  maxLines?: number;
}

const ANSI_BACKGROUND = "\u001b[48;5;236m";
// One step lighter than the body, so two blocks that end up adjacent still show a seam. The grey
// ramp runs 232 (darkest) to 255 (lightest), so 238 reads as a header band rather than a new block.
const ANSI_HEADER_BACKGROUND = "\u001b[48;5;238m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_ITALIC = "\u001b[3m";
const ANSI_RESET = "\u001b[0m";

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
];

/**
 * Terminal columns a string occupies. East Asian text is two columns per character, and without
 * this the right edge of a shaded block lands half a cell off on exactly the lines where it is
 * most visible. Control sequences are never counted, because they occupy no cells.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x1b) break;                       // our own colour prefix ends the visible text
    width += WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
  }
  return width;
}

function collapseLine(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001b\u001c-\u001f\u007f\u0085\u00a0]/g, "\u2423").replace(/\r?\n/g, " ");
}

/** A shaded block line: background for the whole terminal width, or plain text when uncoloured. */
function blockLine(text: string, options: ExpertPanelOptions, bold = false): string {
  if (options.color !== true) return text;
  const columns = typeof options.columns === "number" && options.columns > 0 ? options.columns : 0;
  const pad = columns > displayWidth(text) ? " ".repeat(columns - displayWidth(text)) : "";
  return `${bold ? ANSI_BOLD : ""}${bold ? ANSI_HEADER_BACKGROUND : ANSI_BACKGROUND}${text}${pad}${ANSI_RESET}`;
}

/**
 * Render one event as the lines it should occupy in an observer window. Returns an empty array
 * for anything with nothing to say, so a whitespace-only fragment cannot print a blank block.
 */
export function formatExpertPanel(event: ExpertObservabilityEvent, options: ExpertPanelOptions = {}): string[] {
  const kind = typeof event.kind === "string" ? event.kind : "";
  const attempt = typeof event.attempt === "number" ? ` #${event.attempt}` : "";

  if (kind === "assistant_text") {
    const text = typeof event.text === "string" ? event.text : "";
    if (!text.trim()) return [];
    // Prose: no prefix, no clamp. The terminal wraps it, which is what keeps a sentence whole.
    const lines = text.replace(/\s+$/, "").split(/\r?\n/).map((line) => collapseLine(line));
    if (event.reasoning !== true) return lines;
    // Reasoning is marked wherever it appears, so a window cannot be read as the expert's speech
    // by accident: a left rule in plain text, dim and italic once colour is on. Continuation lines
    // indent to the cell *after* the rule, not to an arbitrary width - six spaces against a nine
    // cell marker left every wrapped line hanging three cells to the left of the rule it follows.
    const marker = "thinks \u2502 ";
    return lines.map((line, index) => {
      const marked = index === 0 ? marker + line : " ".repeat(displayWidth(marker)) + line;
      return options.color === true ? `${ANSI_DIM}${ANSI_ITALIC}${marked}${ANSI_RESET}` : marked;
    });
  }

  if (kind === "tool_output") {
    const tool = typeof event.tool === "string" && event.tool ? event.tool : "tool";
    const streaming = event.streaming === true;
    const args =
      typeof event.argsText === "string" && event.argsText.trim()
        ? collapseLine(event.argsText)
        : typeof event.argsSummary === "string" && event.argsSummary.trim()
          ? event.argsSummary
          : "";
    const subject = args
      ? tool === "bash" || tool === "shell"
        ? `$ ${args}`
        : `${tool} ${args}`
      : tool;
    const header = `${subject}${attempt}${
      streaming
        ? " - running"
        : typeof event.line === "number"
          ? ` - full record on line ${event.line}`
          : event.ok === false
            ? " - failed"
            : ""
    }`;
    const lines = [blockLine(header, options, true)];
    const text = typeof event.text === "string" ? event.text : "";
    if (text.trim()) {
      const all = text.replace(/\s+$/, "").split(/\r?\n/).map((line) => collapseLine(line));
      const cap = typeof options.maxLines === "number" && options.maxLines > 0 ? options.maxLines : 0;
      const shown = cap > 0 && all.length > cap ? all.slice(all.length - cap) : all;
      if (shown.length < all.length) {
        lines.push(blockLine(`[\u2191 ${all.length - shown.length} earlier lines not shown]`, options));
      }
      for (const line of shown) lines.push(blockLine(`  ${line}`, options));
    }
    return lines;
  }

  if (kind === "tool_started" || kind === "tool_finished") {
    const tool = typeof event.tool === "string" && event.tool ? event.tool : "tool";
    const summary = typeof event.argsSummary === "string" && event.argsSummary ? ` ${event.argsSummary}` : "";
    const outcome = kind === "tool_finished" ? (event.ok === false ? " failed" : " ok") : "";
    const text = `${tool}${summary}${outcome}${attempt}`;
    return [options.color === true ? `${ANSI_DIM}${text}${ANSI_RESET}` : text];
  }

  if (kind === "attention") {
    return [`! ${collapseLine(typeof event.text === "string" && event.text ? event.text : "expert attention")}${attempt}`];
  }

  if (kind === "started") {
    const role = typeof event.role === "string" ? event.role : "expert";
    const model = typeof event.model === "string" ? event.model : "unknown";
    return [`\u2500\u2500 ${role} \u00b7 ${model}${attempt} \u2500\u2500`];
  }

  const body = formatExpertEvent(event);
  return [options.color === true ? `${ANSI_DIM}${body}${ANSI_RESET}` : body];
}
