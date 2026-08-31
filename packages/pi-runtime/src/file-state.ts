import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CouncilStatePersistence, CouncilStateSnapshot } from "@expert-council/core";

function isSnapshot(value: unknown): value is CouncilStateSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CouncilStateSnapshot>;
  return candidate.version === 1 &&
    Array.isArray(candidate.plans) &&
    Array.isArray(candidate.executions) &&
    Array.isArray(candidate.results);
}

export class JsonCouncilStateStore implements CouncilStatePersistence {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<CouncilStateSnapshot | undefined> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isSnapshot(parsed)) throw new Error("unsupported or malformed state snapshot");
      return parsed;
    } catch (error) {
      throw new Error(`Unable to load Expert Council state at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(snapshot: CouncilStateSnapshot): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writeQueue = task;
    return task;
  }
}
