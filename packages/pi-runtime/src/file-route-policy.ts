import { stat, readFile } from "node:fs/promises";
import {
  parseRoutePolicyDocument,
  pruneRoutePolicyDocument,
  type RoutePolicyDocument,
} from "@expert-council/core";

/**
 * File-backed route-policy store with mtime-based reload caching. Hosts edit
 * route-policy.json directly; every expert call observes the newest document
 * without a restart. Stale session entries are pruned on load and written
 * back so the persisted file cannot grow without bound.
 */
export class JsonRoutePolicyStore {
  private cached: RoutePolicyDocument | undefined;
  private cachedMtimeMs = -1;
  private cachedMissing = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<RoutePolicyDocument | undefined> {
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
        this.cached = undefined;
        this.cachedMtimeMs = -1;
        this.cachedMissing = true;
        return undefined;
      }
      // Parse/validation errors surface through the service warning path.
      this.cached = undefined;
      this.cachedMtimeMs = -1;
      this.cachedMissing = true;
      throw error;
    }
    const parsed = parseRoutePolicyDocument(raw);
    const pruned = pruneRoutePolicyDocument(parsed);
    if (pruned !== parsed) {
      // Persist pruning so removed session entries do not linger forever.
      await this.save(pruned).catch(() => undefined);
      this.cachedMtimeMs = -1; // force a fresh stat after our own write
    }
    this.cached = pruned;
    return pruned;
  }

  private async save(document: RoutePolicyDocument): Promise<void> {
    const { writeFile, rename } = await import("node:fs/promises");
    const path = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const temporary = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.filePath);
  }
}
