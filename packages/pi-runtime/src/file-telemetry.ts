import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import {
  aggregateOutcomes,
  sanitizeOutcome,
  type ExpertOutcome,
  type TelemetryAggregate,
  type TelemetryStore,
} from "@expert-council/core";
import { ensurePrivateStoragePath } from "./file-security.js";

export class JsonlTelemetryStore implements TelemetryStore {
  constructor(private readonly filePath: string) {}

  async record(outcome: ExpertOutcome): Promise<void> {
    const filePath = await ensurePrivateStoragePath(this.filePath);
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(sanitizeOutcome(outcome))}\n`, { encoding: "utf8" });
    } finally {
      await handle.close();
    }
  }

  async list(): Promise<ExpertOutcome[]> {
    let content: string;
    try {
      content = await readFile(await ensurePrivateStoragePath(this.filePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [sanitizeOutcome(JSON.parse(line) as ExpertOutcome)];
        } catch {
          return [];
        }
      });
  }

  async aggregate(): Promise<TelemetryAggregate[]> {
    return aggregateOutcomes(await this.list());
  }
}
