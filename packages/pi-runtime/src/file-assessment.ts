import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseModelAssessmentSnapshot, type ModelAssessmentSnapshot } from "@expert-council/core";
import { ensurePrivateStoragePath } from "./file-security.js";

export class JsonModelAssessmentStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async loadUnqueued(): Promise<ModelAssessmentSnapshot | undefined> {
    const filePath = await ensurePrivateStoragePath(this.filePath);
    try {
      return parseModelAssessmentSnapshot(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Unable to load Expert Council model assessment at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async load(): Promise<ModelAssessmentSnapshot | undefined> {
    return this.loadUnqueued();
  }

  private async saveUnqueued(snapshot: ModelAssessmentSnapshot): Promise<void> {
    const filePath = await ensurePrivateStoragePath(this.filePath);
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(parseModelAssessmentSnapshot(snapshot), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32") throw error;
    });
  }

  async save(snapshot: ModelAssessmentSnapshot): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(() => this.saveUnqueued(snapshot));
    this.writeQueue = task;
    return task;
  }

  /**
   * Serialize a fresh read-modify-write against the stored snapshot. Unlike
   * `save`, the mutator always sees the newest on-disk assessment, so a
   * targeted runtime update never reverts a newer snapshot written by another
   * Pi/Codex service instance between this instance's load and save.
   */
  async update(
    mutate: (current: ModelAssessmentSnapshot | undefined) => ModelAssessmentSnapshot | undefined,
  ): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      const next = mutate(await this.loadUnqueued());
      if (!next) return;
      await this.saveUnqueued(next);
    });
    this.writeQueue = task;
    return task;
  }
}
