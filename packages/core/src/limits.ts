/**
 * Execution-time budget bounds, stated once for the whole system.
 *
 * These used to be literals in nine places: the delegation contract, the persisted-state schema, the
 * MCP tool schemas that a Codex host sees, the Pi extension's parameter schema, the CLI's argument
 * parser, the retry-budget growth cap and the observer window's own ceiling. Raising one of them - the
 * observer window, say, so it could cover a delegation with three long attempts - was cosmetic,
 * because the runtime and the MCP schema still rejected an attempt longer than an hour. Any future
 * host that needs to follow a 75-minute delegation has to be able to *ask* for one.
 *
 * This module is a leaf on purpose: the state schema evaluates these at import time, so importing
 * them from a module that also imports the state schema would risk a temporal-dead-zone read.
 *
 * A per-attempt budget is not a delegation budget. The aggregate limit for one delegation is a
 * separate, opt-in control: `security.guardrails.maxTotalWallMs`.
 */

/** Smallest explicit per-attempt budget. Below this a delegation is almost certainly a mistake. */
export const MIN_EXPERT_TIMEOUT_MS = 1_000;

/** Largest explicit per-attempt budget: six hours. */
export const MAX_EXPERT_TIMEOUT_MS = 21_600_000;
