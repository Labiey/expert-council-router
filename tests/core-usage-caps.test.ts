import { describe, expect, it } from "vitest";
import {
  applyUsage,
  dayKey,
  detectBreach,
  instantiateLedger,
  parseUsageLedger,
  providerUsage,
  weekKey,
} from "../packages/core/src/index.js";

const limits = { maxConcurrency: 0, dailyTokenCap: 100, weeklyTokenCap: 500 };

describe("usage ledger keys", () => {
  it("uses UTC calendar days", () => {
    expect(dayKey(new Date("2026-09-05T23:59:59.999Z"))).toBe("2026-09-05");
    expect(dayKey(new Date("2026-09-06T00:00:00.000Z"))).toBe("2026-09-06");
  });

  it("uses ISO weeks with Monday start and year-boundary rollover", () => {
    expect(weekKey(new Date("2026-09-05T00:00:00.000Z"))).toBe("2026-W36");
    expect(weekKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-W01");
    // 2027-01-01 is a Friday and belongs to 2026-W53.
    expect(weekKey(new Date("2027-01-01T00:00:00.000Z"))).toBe("2026-W53");
    expect(weekKey(new Date("2027-01-04T00:00:00.000Z"))).toBe("2027-W01");
  });
});

describe("applyUsage", () => {
  it("accumulates within a day and rolls over at day and week boundaries", () => {
    const t1 = new Date("2026-09-05T08:00:00.000Z");
    const t2 = new Date("2026-09-05T20:00:00.000Z");
    const t3 = new Date("2026-09-06T01:00:00.000Z");
    const t4 = new Date("2026-09-07T01:00:00.000Z"); // Monday, new ISO week
    let ledger = instantiateLedger();
    ledger = applyUsage(ledger, "p", 30, t1);
    ledger = applyUsage(ledger, "p", 12, t2);
    expect(providerUsage(ledger, "p", t2)).toEqual({ usedToday: 42, usedWeek: 42 });
    ledger = applyUsage(ledger, "p", 5, t3);
    expect(providerUsage(ledger, "p", t3)).toEqual({ usedToday: 5, usedWeek: 47 });
    ledger = applyUsage(ledger, "p", 7, t4);
    expect(providerUsage(ledger, "p", t4)).toEqual({ usedToday: 7, usedWeek: 7 });
    expect(ledger.updatedAt).toBe(t4.toISOString());
  });

  it("isolates providers and never mutates the input ledger", () => {
    const base = instantiateLedger();
    const next = applyUsage(base, "p", 10, new Date("2026-09-05T00:00:00.000Z"));
    expect(base.providers.p).toBeUndefined();
    expect(providerUsage(next, "q", new Date("2026-09-05T00:00:00.000Z"))).toEqual({ usedToday: 0, usedWeek: 0 });
  });
});

describe("detectBreach", () => {
  it("flags daily and weekly breaches at the cap boundary", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    let ledger = instantiateLedger();
    ledger = applyUsage(ledger, "p", 99, now);
    expect(detectBreach(ledger, "p", limits, now)).toMatchObject({ dailyBreached: false, weeklyBreached: false });
    ledger = applyUsage(ledger, "p", 1, now);
    const breach = detectBreach(ledger, "p", limits, now);
    expect(breach.dailyBreached).toBe(true);
    expect(breach.weeklyBreached).toBe(false);
    expect(breach.nextReset.toISOString()).toBe("2026-09-06T00:00:00.000Z");
  });

  it("resets to the next Monday when the weekly cap is breached", () => {
    const now = new Date("2026-09-05T12:00:00.000Z"); // Saturday
    let ledger = instantiateLedger();
    ledger = applyUsage(ledger, "p", 500, now);
    const breach = detectBreach(ledger, "p", limits, now);
    expect(breach.weeklyBreached).toBe(true);
    expect(breach.nextReset.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("treats zero caps as unlimited and ignores rolled-over buckets", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    let ledger = instantiateLedger();
    ledger = applyUsage(ledger, "p", 1_000, now);
    expect(detectBreach(ledger, "p", { maxConcurrency: 0, dailyTokenCap: 0, weeklyTokenCap: 0 }, now).dailyBreached)
      .toBe(false);
    const later = new Date("2026-09-08T00:00:00.000Z"); // next UTC day and ISO week
    expect(detectBreach(ledger, "p", limits, later).dailyBreached).toBe(false);
    expect(detectBreach(ledger, "p", limits, later).weeklyBreached).toBe(false);
  });
});

describe("parseUsageLedger", () => {
  it("drops malformed entries and normalizes token counts", () => {
    const ledger = parseUsageLedger({
      providers: {
        p: { day: { key: "2026-09-05", tokens: 12.9 }, week: { key: "2026-W36", tokens: -3 } },
        bad: { day: { key: "", tokens: 1 }, week: { key: "2026-W36", tokens: 1 } },
        worse: "nope",
      },
      updatedAt: "2026-09-05T00:00:00.000Z",
    });
    expect(ledger.providers.p).toEqual({
      day: { key: "2026-09-05", tokens: 12 },
      week: { key: "2026-W36", tokens: 0 },
    });
    expect(ledger.providers.bad).toBeUndefined();
    expect(ledger.providers.worse).toBeUndefined();
    expect(ledger.updatedAt).toBe("2026-09-05T00:00:00.000Z");
    expect(parseUsageLedger(undefined)).toEqual(instantiateLedger());
  });
});
