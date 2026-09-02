import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseModelAssessmentSnapshot, type ModelAssessmentSnapshot } from "@expert-council/core";
import { ensurePrivateStoragePath } from "./file-security.js";

export class JsonModelAssessmentStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<ModelAssessmentSnapshot | undefined> {
    const filePath = await ensurePrivateStoragePath(this.filePath);
    try {
      return parseModelAssessmentSnapshot(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Unable to load Expert Council model assessment at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(snapshot: ModelAssessmentSnapshot): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      const filePath = await ensurePrivateStoragePath(this.filePath);
      const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(parseModelAssessmentSnapshot(snapshot))}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32") throw error;
      });
    });
    this.writeQueue = task;
    return task;
  }
}
