import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  bindCompositionSession,
  parseCompositionDocument,
  pruneCompositionDocument,
  unbindCompositionSession,
  type CompositionDocument,
} from "@expert-council/core";

/**
 * File-backed council-compositions store with mtime-based reload caching and
 * atomic-ish writes. Hosts edit council-compositions.json directly; every build
 * or delegation observes the newest document without a restart. Stale session
 * bindings are pruned on load and written back so the file cannot grow without
 * bound. The file is created lazily on the first bind. Structurally matches the
 * `CouncilStateOptions.readCompositions` and `compositionsStore` callback shapes.
 */
export class JsonCompositionsStore {
  private cached: CompositionDocument | undefined;
  private cachedMtimeMs = -1;
  private cachedMissing = true;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<CompositionDocument | undefined> {
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
    const parsed = parseCompositionDocument(raw);
    const pruned = pruneCompositionDocument(parsed);
    if (pruned !== parsed) {
      // Persist pruning so removed session bindings do not linger forever.
      await this.save(pruned).catch(() => undefined);
      this.cachedMtimeMs = -1; // force a fresh stat after our own write
    }
    this.cached = pruned;
    return pruned;
  }

  async bind(sessionKey: string, name: string, now: Date = new Date()): Promise<void> {
    await this.mutate((document) => bindCompositionSession(document, sessionKey, name, now.getTime()));
  }

  async unbind(sessionKey: string, now: Date = new Date()): Promise<void> {
    await this.mutate((document) => unbindCompositionSession(document, sessionKey));
  }

  private mutate(update: (document: CompositionDocument) => CompositionDocument): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      const current = (await this.load().catch(() => undefined)) ?? ({ version: 1, compositions: [] } as CompositionDocument);
      const next = update(current);
      if (next === current) return;
      await this.save(next);
      this.cached = next;
      this.cachedMtimeMs = -1; // force a fresh stat after our own write
      this.cachedMissing = false;
    });
    this.writeQueue = task.then(() => undefined);
    return task;
  }

  private async save(document: CompositionDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.filePath);
  }
}
