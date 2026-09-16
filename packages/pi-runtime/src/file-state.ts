import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCouncilStateSnapshot, type CouncilStatePersistence, type CouncilStateSnapshot } from "@expert-council/core";
import { ensurePrivateStoragePath } from "./file-security.js";

export class JsonCouncilStateStore implements CouncilStatePersistence {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<CouncilStateSnapshot | undefined> {
    const filePath = await ensurePrivateStoragePath(this.filePath);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      return parseCouncilStateSnapshot(parsed);
    } catch (error) {
      throw new Error(`Unable to load Expert Council state at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(snapshot: CouncilStateSnapshot): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      const filePath = await ensurePrivateStoragePath(this.filePath);
      const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
      // Indented like every other persisted document: a single minified line is opaque
      // to our own read-only roles, whose `read` caps a line at 50KB and whose `grep`
      // truncates a match to 500 characters from the line start. Per-attempt failure
      // detail was unreachable for exactly that reason.
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32") throw error;
      });
    });
    this.writeQueue = task;
    return task;
  }
}
