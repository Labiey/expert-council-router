import { describe, expect, it } from "vitest";
import {
  COMPOSITION_SESSION_MAX_AGE_MS,
  bindCompositionSession,
  compositionByName,
  compositionMenu,
  compositionPools,
  compositionRolesSummary,
  parseCompositionDocument,
  pruneCompositionDocument,
  resolveCompositionForSession,
  resolveCompositionPools,
  sanitizeCompositionModelKey,
  unbindCompositionSession,
} from "../packages/core/src/index.js";
import type { CompositionDocument } from "../packages/core/src/index.js";

const validDocument = {
  compositions: [
    {
      name: "daily-cheap",
      roles: {
        scout: ["qwen-token-plan-cn/deepseek-v4-flash"],
        "implementation-worker": ["zai/glm-5.3-flash", "deepseek/deepseek-v4-flash"],
      },
    },
    { name: "quality", roles: { planner: ["p/strong"] } },
    { name: "empty" },
  ],
  sessions: { "session-1": "daily-cheap" },
};

describe("council composition parsing", () => {
  it("parses a valid document and normalizes the version", () => {
    const parsed = parseCompositionDocument(validDocument);
    expect(parsed.version).toBe(1);
    expect(parsed.compositions.map((composition) => composition.name)).toEqual(["daily-cheap", "quality", "empty"]);
    expect(parsed.compositions[0]?.roles["implementation-worker"]).toEqual([
      { model: "zai/glm-5.3-flash" },
      { model: "deepseek/deepseek-v4-flash" },
    ]);
    expect(parsed.sessions?.["session-1"]).toEqual({ name: "daily-cheap" });
    // A composition with no roles is kept (it auto-routes every role).
    expect(parsed.compositions[2]?.roles).toEqual({});
  });

  it("accepts the documented string session form and an object binding form", () => {
    const parsed = parseCompositionDocument({
      compositions: [{ name: "a" }],
      sessions: { s1: "a", s2: { name: "a", updatedAt: "2026-09-07T00:00:00.000Z" } },
    });
    expect(parsed.sessions?.s1).toEqual({ name: "a" });
    expect(parsed.sessions?.s2).toEqual({ name: "a", updatedAt: "2026-09-07T00:00:00.000Z" });
  });

  it("rejects duplicate names and unknown role keys", () => {
    expect(() => parseCompositionDocument({
      compositions: [{ name: "dup" }, { name: "dup" }],
    })).toThrow(/duplicate composition name/);
    expect(() => parseCompositionDocument({
      compositions: [{ name: "bad", roles: { lead: ["p/a"] } }],
    })).toThrow();
  });

  it("drops malformed model keys and keeps the rest of the roster", () => {
    const parsed = parseCompositionDocument({
      compositions: [{
        name: "mixed",
        roles: {
          scout: ["p/good", "no-slash", "p/ok", "p/good", "p\u0000evil"],
        },
      }],
    });
    expect(parsed.compositions[0]?.roles.scout).toEqual([{ model: "p/good" }, { model: "p/ok" }]);
  });

  it("bounds names, pool size, and composition count", () => {
    expect(() => parseCompositionDocument({
      compositions: [{ name: "x".repeat(81) }],
    })).toThrow();
    expect(() => parseCompositionDocument({
      compositions: Array.from({ length: 33 }, (_, index) => ({ name: `c${index}` })),
    })).toThrow();
    const parsed = parseCompositionDocument({
      compositions: [{
        name: "big",
        roles: { scout: Array.from({ length: 20 }, (_, index) => `p/m${index}`) },
      }],
    });
    expect(parsed.compositions[0]?.roles.scout).toHaveLength(16);
  });

  it("sanitizes model keys", () => {
    expect(sanitizeCompositionModelKey(" p/a ")).toBe("p/a");
    expect(sanitizeCompositionModelKey("p/a/b")).toBeUndefined();
    expect(sanitizeCompositionModelKey("noslash")).toBeUndefined();
    expect(sanitizeCompositionModelKey("/leading")).toBeUndefined();
    expect(sanitizeCompositionModelKey("trailing/")).toBeUndefined();
  });
});

describe("composition pool resolution", () => {
  const document = parseCompositionDocument(validDocument);

  it("returns a full per-role pool record with empty roles auto-routing", () => {
    const pools = resolveCompositionPools(document, "session-1");
    expect(pools?.scout).toEqual(["qwen-token-plan-cn/deepseek-v4-flash"]);
    expect(pools?.["implementation-worker"]).toHaveLength(2);
    expect(pools?.planner).toEqual([]);
    expect(pools?.reviewer).toEqual([]);
  });

  it("returns undefined for an unbound session or a binding to a missing composition", () => {
    expect(resolveCompositionPools(document, "unknown")).toBeUndefined();
    const dangling = parseCompositionDocument({ compositions: [], sessions: { s: "gone" } });
    expect(resolveCompositionForSession(dangling, "s")).toBeUndefined();
  });

  it("summarizes role counts for menus", () => {
    const composition = compositionByName(document, "daily-cheap")!;
    expect(compositionRolesSummary(composition)).toEqual({ scout: 1, "implementation-worker": 2 });
    expect(compositionPools(composition).debugger).toEqual([]);
  });
});

describe("composition session bindings", () => {
  it("binds with a timestamp and unbinds", () => {
    const now = Date.parse("2026-09-07T00:00:00.000Z");
    const bound = bindCompositionSession({ version: 1, compositions: [{ name: "a", roles: {} }] }, "s1", "a", now);
    expect(bound.sessions?.s1).toEqual({ name: "a", updatedAt: "2026-09-07T00:00:00.000Z" });
    const unbound = unbindCompositionSession(bound, "s1");
    expect(unbound.sessions).toBeUndefined();
    // Unbinding an unknown session is a no-op identity.
    expect(unbindCompositionSession(unbound, "s1")).toBe(unbound);
  });

  it("prunes bindings older than 30 days but keeps fresh and hand-written entries", () => {
    const now = Date.parse("2026-09-07T00:00:00.000Z");
    const document: CompositionDocument = {
      version: 1,
      compositions: [{ name: "a", roles: {} }],
      sessions: {
        stale: { name: "a", updatedAt: new Date(now - COMPOSITION_SESSION_MAX_AGE_MS - 1).toISOString() },
        fresh: { name: "a", updatedAt: new Date(now - COMPOSITION_SESSION_MAX_AGE_MS + 60_000).toISOString() },
        hand: { name: "a" },
      },
    };
    const pruned = pruneCompositionDocument(document, now);
    expect(Object.keys(pruned.sessions ?? {}).sort()).toEqual(["fresh", "hand"]);
    // A document without stale entries is returned unchanged.
    expect(pruneCompositionDocument({ version: 1, compositions: [] }, now)).toEqual({ version: 1, compositions: [] });
  });
});

describe("composition menu", () => {
  it("offers up to three saved rosters in file order plus the auto option", () => {
    const document = parseCompositionDocument({
      compositions: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
    });
    const menu = compositionMenu(document);
    expect(menu.map((entry) => entry.name)).toEqual(["a", "b", "c", "auto"]);
    expect(menu.at(-1)).toEqual({
      name: "auto",
      description: "create a session composition via costPolicy (economy/balanced/speed)",
    });
    expect(menu[0]).toEqual({ name: "a", rolesSummary: {} });
    expect(compositionMenu(undefined)).toEqual([menu.at(-1)]);
  });
});

describe("composition reasoning levels", () => {
  it("parses object entries with reasoning levels and keeps bare strings", () => {
    const parsed = parseCompositionDocument({
      compositions: [{
        name: "tiered",
        roles: {
          planner: [
            { model: "p/max", reasoningLevel: "high" },
            "p/flash",
          ],
        },
      }],
    });
    expect(parsed.compositions[0]?.roles.planner).toEqual([
      { model: "p/max", reasoningLevel: "high" },
      { model: "p/flash" },
    ]);
  });

  it("exposes pinned levels through compositionReasoningLevels", async () => {
    const { compositionReasoningLevels } = await import("../packages/core/src/compositions.js");
    const parsed = parseCompositionDocument({
      compositions: [{
        name: "tiered",
        roles: {
          planner: [{ model: "p/max", reasoningLevel: "high" }, "p/flash"],
          scout: [{ model: "p/flash", reasoningLevel: "low" }],
        },
      }],
    });
    expect(compositionReasoningLevels(parsed.compositions[0]!)).toEqual({
      planner: { "p/max": "high" },
      scout: { "p/flash": "low" },
    });
  });
});
