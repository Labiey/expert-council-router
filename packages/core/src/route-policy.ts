import { z } from "zod";
import { ConfigValidationError } from "./config.js";
import type { RoutePolicy, RoutePolicyDocument, RoutePolicyEntry } from "./types.js";

export const ROUTE_POLICY_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const routePolicyEntriesSchema = z.array(z.string().min(1).max(200)).max(32);

const routePolicyEntrySchema = z.object({
  allow: routePolicyEntriesSchema.optional(),
  deny: routePolicyEntriesSchema.optional(),
  updatedAt: z.string().min(1).max(60).optional(),
  note: z.string().min(1).max(500).optional(),
  workspace: z.string().min(1).max(500).optional(),
});

export const routePolicyDocumentSchema = z.object({
  version: z.literal(1),
  system: routePolicyEntrySchema.optional(),
  sessions: z.record(z.string().min(1).max(200), routePolicyEntrySchema).optional(),
});

/** Strip control characters and bound a policy entry; `provider/id` or bare `provider`. */
export function sanitizePolicyEntry(value: string): string | undefined {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return /^[^/]+(\/[^/]+)?$/.test(cleaned) ? cleaned : undefined;
}

function sanitizeEntry(entry: RoutePolicyEntry | undefined): RoutePolicyEntry | undefined {
  if (!entry) return entry;
  const sanitize = (values: string[] | undefined): string[] | undefined => {
    const cleaned = values?.map(sanitizePolicyEntry).filter((value): value is string => Boolean(value)).slice(0, 32);
    return cleaned?.length ? cleaned : undefined;
  };
  const allow = sanitize(entry.allow);
  const deny = sanitize(entry.deny);
  if (!allow && !deny) return undefined;
  return {
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.workspace ? { workspace: entry.workspace } : {}),
  };
}

/** Parse and validate an untrusted route-policy document; throws ConfigValidationError. */
export function parseRoutePolicyDocument(input: unknown): RoutePolicyDocument {
  const parsed = routePolicyDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues.map((issue) => `routePolicy.${issue.path.join(".") || "root"}: ${issue.message}`));
  }
  const system = sanitizeEntry(parsed.data.system);
  const rawSessions = parsed.data.sessions ?? {};
  const sessions: Record<string, RoutePolicyEntry> = {};
  for (const [key, entry] of Object.entries(rawSessions)) {
    const sanitizedKey = sanitizePolicyEntry(key);
    const sanitized = sanitizeEntry(entry);
    if (sanitizedKey && sanitized) sessions[sanitizedKey] = sanitized;
  }
  return {
    version: 1,
    ...(system ? { system } : {}),
    ...(Object.keys(sessions).length ? { sessions } : {}),
  };
}

/**
 * Drop session entries older than the configured lifetime so the persisted
 * document cannot grow without bound. System entries are never pruned.
 */
export function pruneRoutePolicyDocument(document: RoutePolicyDocument, now = Date.now(), maxAgeMs = ROUTE_POLICY_SESSION_MAX_AGE_MS): RoutePolicyDocument {
  const sessions = document.sessions;
  if (!sessions) return document;
  const kept: Record<string, RoutePolicyEntry> = {};
  for (const [key, entry] of Object.entries(sessions)) {
    const updated = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
    if (!Number.isFinite(updated) || now - updated <= maxAgeMs) kept[key] = entry;
  }
  return Object.keys(kept).length === Object.keys(sessions).length
    ? document
    : { version: 1, ...(document.system ? { system: document.system } : {}), ...(Object.keys(kept).length ? { sessions: kept } : {}) };
}

/**
 * Merge the system-level entry with a session entry. Sessions may only narrow
 * the system policy: deny lists union, allow lists intersect when both exist,
 * and a session can never unlock a system-level deny. `deny` always wins over
 * `allow` at routing time.
 */
export function resolveEffectivePolicy(document: RoutePolicyDocument | undefined, sessionKey: string): RoutePolicy | undefined {
  const system = document?.system;
  const session = document?.sessions?.[sessionKey];
  if (!system && !session) return undefined;
  const denyUnion = [...new Set([...(system?.deny ?? []), ...(session?.deny ?? [])])];
  const allow =
    system?.allow && session?.allow
      ? system.allow.filter((value) => session.allow!.includes(value))
      : system?.allow ?? session?.allow;
  return {
    ...(allow?.length ? { allow } : {}),
    ...(denyUnion.length ? { deny: denyUnion } : {}),
  };
}
