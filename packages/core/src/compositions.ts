import { z } from "zod";
import { ConfigValidationError, expertRoleSchema } from "./config.js";
import type {
  Composition,
  CompositionDocument,
  CompositionMenuEntry,
  CompositionPools,
  CompositionSessionBinding,
  ExpertRole,
} from "./types.js";

/** Session bindings older than this are pruned on load, mirroring route-policy sessions. */
export const COMPOSITION_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Maximum saved compositions; order is menu priority. */
export const MAX_COMPOSITIONS = 32;
/** Maximum composition name length. */
export const MAX_COMPOSITION_NAME_LENGTH = 80;
/** Maximum model keys per role pool. */
export const MAX_COMPOSITION_MODELS_PER_ROLE = 16;
/** Number of saved compositions offered in the first-build menu (plus the auto option). */
export const COMPOSITION_MENU_LIMIT = 3;

export const EXPERT_ROLES: readonly ExpertRole[] = [
  "planner",
  "scout",
  "architecture-oracle",
  "implementation-worker",
  "debugger",
  "reviewer",
  "verifier",
];

const modelKeyPattern = /^[^/]+\/[^/]+$/;
const controlCharacters = /[\u0000-\u001f\u007f]/g;

/** Strip control characters and bound a `provider/id` model key. */
export function sanitizeCompositionModelKey(value: string): string | undefined {
  const cleaned = value.replace(controlCharacters, "").trim();
  return cleaned && cleaned.length <= 200 && modelKeyPattern.test(cleaned) ? cleaned : undefined;
}

/** Strip control characters and bound a composition name. */
export function sanitizeCompositionName(value: string): string | undefined {
  const cleaned = value.replace(controlCharacters, "").trim();
  return cleaned && cleaned.length <= MAX_COMPOSITION_NAME_LENGTH ? cleaned : undefined;
}

function sanitizeSessionKey(value: string): string | undefined {
  const cleaned = value.replace(controlCharacters, "").trim();
  return cleaned && cleaned.length <= 200 ? cleaned : undefined;
}

const compositionSchema = z.object({
  name: z.string().min(1).max(MAX_COMPOSITION_NAME_LENGTH),
  // Partial by design: an omitted or empty role routes normally. Enum-record
  // would require every key, so use a strict object over the 7 roles.
  roles: z
    .strictObject(
      Object.fromEntries(
        (expertRoleSchema.options as readonly ExpertRole[]).map((role) => [
          role,
          z.array(z.string().min(1).max(200)).max(100).optional(),
        ]),
      ),
    )
    .optional(),
});

const compositionSessionSchema = z.union([
  z.string().min(1).max(MAX_COMPOSITION_NAME_LENGTH),
  z.object({
    name: z.string().min(1).max(MAX_COMPOSITION_NAME_LENGTH),
    updatedAt: z.string().min(1).max(60).optional(),
  }),
]);

export const compositionDocumentSchema = z.object({
  version: z.literal(1).optional(),
  compositions: z.array(compositionSchema).max(MAX_COMPOSITIONS),
  sessions: z.record(z.string().min(1).max(200), compositionSessionSchema).optional(),
});

/**
 * Parse and validate an untrusted council-compositions document. Structural
 * violations (bad role keys, oversized pools, unknown types) throw
 * ConfigValidationError; malformed individual model keys are dropped so one
 * typo cannot disable the whole roster. Duplicate composition names throw
 * because names are the user-facing selection key.
 */
export function parseCompositionDocument(input: unknown): CompositionDocument {
  const parsed = compositionDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((issue) => `compositions.${issue.path.join(".") || "root"}: ${issue.message}`),
    );
  }
  const compositions: Composition[] = [];
  const seen = new Set<string>();
  const duplicateNames: string[] = [];
  for (const entry of parsed.data.compositions) {
    const name = sanitizeCompositionName(entry.name);
    if (!name) continue;
    if (seen.has(name)) {
      duplicateNames.push(name);
      continue;
    }
    seen.add(name);
    const roles: Partial<Record<ExpertRole, string[]>> = {};
    for (const role of Object.keys(entry.roles ?? {})) {
      if (!EXPERT_ROLES.includes(role as ExpertRole)) {
        throw new ConfigValidationError([
          `compositions.${name}.roles.${role}: unknown expert role; expected one of ${EXPERT_ROLES.join(", ")}`,
        ]);
      }
    }
    for (const [role, rawKeys] of Object.entries(entry.roles ?? {})) {
      const keys = rawKeys ?? [];
      const cleaned = [
        ...new Set(keys.map(sanitizeCompositionModelKey).filter((value): value is string => Boolean(value))),
      ].slice(0, MAX_COMPOSITION_MODELS_PER_ROLE);
      if (cleaned.length) roles[role as ExpertRole] = cleaned;
    }
    compositions.push({ name, roles });
  }
  if (duplicateNames.length) {
    throw new ConfigValidationError(
      [...new Set(duplicateNames)].map((name) => `compositions: duplicate composition name "${name}"`),
    );
  }
  const sessions: Record<string, CompositionSessionBinding> = {};
  for (const [key, value] of Object.entries(parsed.data.sessions ?? {})) {
    const sessionKey = sanitizeSessionKey(key);
    if (!sessionKey) continue;
    const binding = typeof value === "string" ? { name: value } : value;
    const name = sanitizeCompositionName(binding.name);
    if (!name) continue;
    sessions[sessionKey] = {
      name,
      ...(binding.updatedAt ? { updatedAt: binding.updatedAt } : {}),
    };
  }
  return {
    version: 1,
    compositions,
    ...(Object.keys(sessions).length ? { sessions } : {}),
  };
}

/**
 * Drop session bindings older than the configured lifetime so the persisted
 * document cannot grow without bound. Saved compositions are user
 * configuration and are never pruned. Hand-written bindings without
 * `updatedAt` are kept, matching route-policy session behavior.
 */
export function pruneCompositionDocument(
  document: CompositionDocument,
  now = Date.now(),
  maxAgeMs = COMPOSITION_SESSION_MAX_AGE_MS,
): CompositionDocument {
  const sessions = document.sessions;
  if (!sessions) return document;
  const kept: Record<string, CompositionSessionBinding> = {};
  for (const [key, entry] of Object.entries(sessions)) {
    const updated = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
    if (!Number.isFinite(updated) || now - updated <= maxAgeMs) kept[key] = entry;
  }
  return Object.keys(kept).length === Object.keys(sessions).length
    ? document
    : {
        version: 1,
        compositions: document.compositions,
        ...(Object.keys(kept).length ? { sessions: kept } : {}),
      };
}

/** Look up a saved composition by exact name. */
export function compositionByName(document: CompositionDocument | undefined, name: string): Composition | undefined {
  return document?.compositions.find((composition) => composition.name === name);
}

/** Resolve a composition to full per-role pools; missing roles resolve to an empty pool. */
export function compositionPools(composition: Composition): CompositionPools {
  const pools = Object.fromEntries(EXPERT_ROLES.map((role) => [role, [] as string[]])) as CompositionPools;
  for (const role of EXPERT_ROLES) {
    const list = composition.roles[role];
    if (list?.length) pools[role] = [...list];
  }
  return pools;
}

/** Compact role -> model-count summary for menus and inspect output. */
export function compositionRolesSummary(composition: Composition): Record<string, number> {
  return Object.fromEntries(
    EXPERT_ROLES.filter((role) => composition.roles[role]?.length).map((role) => [
      role,
      composition.roles[role]!.length,
    ]),
  );
}

/**
 * Resolve the session-bound composition: binding name -> saved composition ->
 * full per-role pools. Returns undefined when the session has no binding or the
 * binding points at a composition that no longer exists.
 */
export function resolveCompositionForSession(
  document: CompositionDocument | undefined,
  sessionKey: string,
): { name: string; pools: CompositionPools } | undefined {
  const binding = document?.sessions?.[sessionKey];
  if (!binding) return undefined;
  const composition = compositionByName(document, binding.name);
  if (!composition) return undefined;
  return { name: composition.name, pools: compositionPools(composition) };
}

/** Per-role pools of the session-bound composition, or undefined when none resolves. */
export function resolveCompositionPools(
  document: CompositionDocument | undefined,
  sessionKey: string,
): CompositionPools | undefined {
  return resolveCompositionForSession(document, sessionKey)?.pools;
}

/** Bind a session to a saved composition name, stamping `updatedAt` for pruning. */
export function bindCompositionSession(
  document: CompositionDocument,
  sessionKey: string,
  name: string,
  now = Date.now(),
): CompositionDocument {
  const key = sanitizeSessionKey(sessionKey);
  const cleanedName = sanitizeCompositionName(name);
  if (!key || !cleanedName) {
    throw new ConfigValidationError([
      "compositions: session binding requires a non-empty session key and a composition name of at most 80 characters",
    ]);
  }
  return {
    version: 1,
    compositions: document.compositions,
    sessions: {
      ...(document.sessions ?? {}),
      [key]: { name: cleanedName, updatedAt: new Date(now).toISOString() },
    },
  };
}

/** Remove a session binding; returns the same document when nothing changes. */
export function unbindCompositionSession(document: CompositionDocument, sessionKey: string): CompositionDocument {
  const sessions = document.sessions;
  if (!sessions || !(sessionKey in sessions)) return document;
  const { [sessionKey]: _removed, ...rest } = sessions;
  return {
    version: 1,
    compositions: document.compositions,
    ...(Object.keys(rest).length ? { sessions: rest } : {}),
  };
}

/**
 * First-build menu: up to `limit` saved compositions in file order plus a
 * final `auto` option that routes to the cost-policy flow. Bounded by design so
 * the build response stays small.
 */
export function compositionMenu(
  document: CompositionDocument | undefined,
  limit = COMPOSITION_MENU_LIMIT,
): CompositionMenuEntry[] {
  const saved = (document?.compositions ?? []).slice(0, Math.max(0, limit)).map((composition) => ({
    name: composition.name,
    rolesSummary: compositionRolesSummary(composition),
  }));
  return [
    ...saved,
    { name: "auto", description: "create a session composition via costPolicy (economy/balanced/speed)" },
  ];
}
