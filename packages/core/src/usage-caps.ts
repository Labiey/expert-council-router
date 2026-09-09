import type { ProviderLimits, UsageLedger, UsageLedgerBucket, UsageLedgerProvider } from "./types.js";

const MAX_PROVIDER_KEY_LENGTH = 200;
const MAX_BUCKET_KEY_LENGTH = 40;

/** Empty ledger used when no persisted usage exists yet. */
export function instantiateLedger(): UsageLedger {
  return { providers: {}, updatedAt: new Date(0).toISOString() };
}

/** UTC calendar day key, "YYYY-MM-DD". */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * ISO week key, "YYYY-Www" (Monday start, UTC). The week belongs to the ISO
 * week-numbering year, so 2027-01-01 resolves to 2026-W53.
 */
export function weekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber); // Thursday of this ISO week
  const isoYear = target.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function sanitizeTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Validate and normalize an untrusted persisted ledger. Unknown or malformed
 * entries are dropped instead of crashing routing.
 */
export function parseUsageLedger(input: unknown): UsageLedger {
  const fallback = instantiateLedger();
  if (!input || typeof input !== "object" || Array.isArray(input)) return fallback;
  const raw = input as Record<string, unknown>;
  const rawProviders = raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)
    ? raw.providers as Record<string, unknown>
    : {};
  const providers: Record<string, UsageLedgerProvider> = {};
  const bucket = (value: unknown): UsageLedgerBucket | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const rawBucket = value as Record<string, unknown>;
    const key = typeof rawBucket.key === "string"
      ? rawBucket.key.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_BUCKET_KEY_LENGTH)
      : "";
    return key ? { key, tokens: sanitizeTokens(rawBucket.tokens) } : undefined;
  };
  for (const [provider, value] of Object.entries(rawProviders)) {
    if (!provider || provider.length > MAX_PROVIDER_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(provider)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const day = bucket(entry.day);
    const week = bucket(entry.week);
    if (day && week) providers[provider] = { day, week };
  }
  return {
    providers,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.length <= MAX_BUCKET_KEY_LENGTH
      ? raw.updatedAt
      : fallback.updatedAt,
  };
}

/**
 * Add weighted tokens for one provider. Day/week buckets roll over when their
 * key changes; the returned ledger is a new object and the input is untouched.
 */
export function applyUsage(
  ledger: UsageLedger,
  provider: string,
  tokens: number,
  now: Date = new Date(),
): UsageLedger {
  const day = dayKey(now);
  const week = weekKey(now);
  const amount = sanitizeTokens(tokens);
  const current = ledger.providers[provider];
  const dayBucket: UsageLedgerBucket = current?.day.key === day
    ? { key: day, tokens: current.day.tokens + amount }
    : { key: day, tokens: amount };
  const weekBucket: UsageLedgerBucket = current?.week.key === week
    ? { key: week, tokens: current.week.tokens + amount }
    : { key: week, tokens: amount };
  return {
    providers: { ...ledger.providers, [provider]: { day: dayBucket, week: weekBucket } },
    updatedAt: now.toISOString(),
  };
}

/** Current day/week weighted usage for one provider, ignoring rolled-over buckets. */
export function providerUsage(
  ledger: UsageLedger,
  provider: string,
  now: Date = new Date(),
): { usedToday: number; usedWeek: number } {
  const entry = ledger.providers[provider];
  const day = dayKey(now);
  const week = weekKey(now);
  return {
    usedToday: entry?.day.key === day ? entry.day.tokens : 0,
    usedWeek: entry?.week.key === week ? entry.week.tokens : 0,
  };
}

export interface UsageBreach {
  dailyBreached: boolean;
  weeklyBreached: boolean;
  /** Next UTC reset boundary: next Monday 00:00 when weekly, else next UTC midnight. */
  nextReset: Date;
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function nextMondayUtc(now: Date): Date {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  const daysUntilNextMonday = (8 - dayNumber) % 7 || 7; // strictly the next Monday
  target.setUTCDate(target.getUTCDate() + daysUntilNextMonday);
  return target;
}

/** Detect whether a provider has reached its daily or weekly weighted cap. */
export function detectBreach(
  ledger: UsageLedger,
  provider: string,
  limits: ProviderLimits,
  now: Date = new Date(),
): UsageBreach {
  const { usedToday, usedWeek } = providerUsage(ledger, provider, now);
  const dailyBreached = limits.dailyTokenCap > 0 && usedToday >= limits.dailyTokenCap;
  const weeklyBreached = limits.weeklyTokenCap > 0 && usedWeek >= limits.weeklyTokenCap;
  return {
    dailyBreached,
    weeklyBreached,
    nextReset: weeklyBreached ? nextMondayUtc(now) : nextUtcMidnight(now),
  };
}
