import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyUsage,
  instantiateLedger,
  parseUsageLedger,
  type ProviderLimitsDocument,
  type UsageLedger,
} from "@expert-council/core";
import type { JsonRoutePolicyStore } from "./file-route-policy.js";

/**
 * File-backed weighted-token usage ledger with mtime-based reload caching and
 * atomic-ish writes. The ledger is created lazily on the first `record`; a
 * missing file is an empty ledger. `JsonUsageLedgerStore` structurally matches
 * the `CouncilStateOptions.usageLedger` callback shape.
 */
export class JsonUsageLedgerStore {
  private cached: UsageLedger = instantiateLedger();
  private cachedMtimeMs = -1;
  private cachedMissing = true;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<UsageLedger> {
    let raw: unknown;
    try {
      const stats = await stat(this.filePath);
      if (this.cachedMissing === false && stats.mtimeMs === this.cachedMtimeMs && this.cachedMtimeMs >= 0) {
        return this.cached;
      }
      raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.cachedMtimeMs = stats.mtimeMs;
      this.cachedMissing = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cached = instantiateLedger();
        this.cachedMtimeMs = -1;
        this.cachedMissing = true;
        return this.cached;
      }
      // A malformed ledger must not block routing; start from a clean ledger
      // and let the next successful record rewrite the file.
      this.cached = instantiateLedger();
      this.cachedMtimeMs = -1;
      this.cachedMissing = true;
      return this.cached;
    }
    this.cached = parseUsageLedger(raw);
    return this.cached;
  }

  async record(provider: string, tokens: number, now: Date): Promise<UsageLedger> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      const current = await this.load();
      const next = applyUsage(current, provider, tokens, now);
      await this.save(next);
      this.cached = next;
      this.cachedMtimeMs = -1; // force a fresh stat after our own write
      this.cachedMissing = false;
      return next;
    });
    this.writeQueue = task.then(() => undefined);
    return task;
  }

  private async save(ledger: UsageLedger): Promise<void> {
    const temporary = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.filePath);
  }
}

/**
 * Build the `CouncilStateOptions.readProviderLimits` callback from the same
 * route-policy document store the model allow/deny policy uses: the `providers`
 * map lives in route-policy.json.
 */
export function createProviderLimitsReader(
  routePolicyStore: Pick<JsonRoutePolicyStore, "load">,
): () => Promise<ProviderLimitsDocument | undefined> {
  return () => routePolicyStore.load();
}
