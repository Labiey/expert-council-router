import { z } from "zod";
import { ConfigValidationError } from "./config.js";
import type { ProviderLimits, ProviderLimitsDocument, ProviderLimitsEntry, RoutePolicy, RoutePolicyDocument, RoutePolicyEntry } from "./types.js";

export const ROUTE_POLICY_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Default weighted-token allowance per UTC calendar day. */
export const DEFAULT_DAILY_TOKEN_CAP = 20_000_000;
/** Default weighted-token allowance per ISO week (Monday start, UTC). */
export const DEFAULT_WEEKLY_TOKEN_CAP = 150_000_000;
/** Default simultaneous-execution limit; 0 means unlimited. */
export const DEFAULT_MAX_CONCURRENCY = 0;

/** Effective limits applied to providers without an explicit entry. */
export const DEFAULT_PROVIDER_LIMITS: ProviderLimits = {
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  dailyTokenCap: DEFAULT_DAILY_TOKEN_CAP,
  weeklyTokenCap: DEFAULT_WEEKLY_TOKEN_CAP,
};

const routePolicyEntriesSchema = z.array(z.string().min(1).max(200)).max(32);

const routePolicyEntrySchema = z.object({
  allow: routePolicyEntriesSchema.optional(),
  deny: routePolicyEntriesSchema.optional(),
  updatedAt: z.string().min(1).max(60).optional(),
  note: z.string().min(1).max(500).optional(),
  workspace: z.string().min(1).max(500).optional(),
});

const providerLimitsEntrySchema = z.object({
  maxConcurrency: z.number().int().min(0).optional(),
  dailyTokenCap: z.number().int().positive().optional(),
  weeklyTokenCap: z.number().int().positive().optional(),
});

export const routePolicyDocumentSchema = z.object({
  version: z.literal(1),
  system: routePolicyEntrySchema.optional(),
  sessions: z.record(z.string().min(1).max(200), routePolicyEntrySchema).optional(),
  providers: z.record(z.string().min(1).max(200), providerLimitsEntrySchema).optional(),
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

function sanitizeProviderKey(value: string): string | undefined {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned && cleaned.length <= 200 ? cleaned : undefined;
}

function sanitizeProviderEntry(entry: ProviderLimitsEntry | undefined): ProviderLimitsEntry | undefined {
  if (!entry) return undefined;
  const cleaned: ProviderLimitsEntry = {};
  if (entry.maxConcurrency !== undefined) cleaned.maxConcurrency = entry.maxConcurrency;
  if (entry.dailyTokenCap !== undefined) cleaned.dailyTokenCap = entry.dailyTokenCap;
  if (entry.weeklyTokenCap !== undefined) cleaned.weeklyTokenCap = entry.weeklyTokenCap;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function sanitizeProviders(
  providers: Record<string, ProviderLimitsEntry> | undefined,
): Record<string, ProviderLimitsEntry> | undefined {
  if (!providers) return undefined;
  const kept: Record<string, ProviderLimitsEntry> = {};
  for (const [provider, entry] of Object.entries(providers)) {
    const key = sanitizeProviderKey(provider);
    const sanitized = sanitizeProviderEntry(entry);
    if (key && sanitized) kept[key] = sanitized;
  }
  return Object.keys(kept).length ? kept : undefined;
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
  const providers = sanitizeProviders(parsed.data.providers);
  return {
    version: 1,
    ...(system ? { system } : {}),
    ...(Object.keys(sessions).length ? { sessions } : {}),
    ...(providers ? { providers } : {}),
  };
}

/**
 * Drop session entries older than the configured lifetime so the persisted
 * document cannot grow without bound. System entries and provider limits are
 * user configuration and are never pruned.
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
    : {
        version: 1,
        ...(document.system ? { system: document.system } : {}),
        ...(Object.keys(kept).length ? { sessions: kept } : {}),
        ...(document.providers ? { providers: document.providers } : {}),
      };
}

/**
 * Apply defaults to every provider entry in a route-policy document, returning
 * effective per-provider limits. Providers absent from the document use
 * {@link DEFAULT_PROVIDER_LIMITS}.
 */
export function resolveProviderLimits(document: ProviderLimitsDocument | undefined): Record<string, ProviderLimits> {
  const providers = document?.providers ?? {};
  return Object.fromEntries(
    Object.entries(providers).map(([provider, entry]) => [
      provider,
      {
        maxConcurrency: entry.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        dailyTokenCap: entry.dailyTokenCap ?? DEFAULT_DAILY_TOKEN_CAP,
        weeklyTokenCap: entry.weeklyTokenCap ?? DEFAULT_WEEKLY_TOKEN_CAP,
      },
    ]),
  );
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
