import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  aggregateOutcomes,
  sanitizeOutcome,
  type ExpertOutcome,
  type TelemetryAggregate,
  type TelemetryStore,
} from "@expert-council/core";

export class JsonlTelemetryStore implements TelemetryStore {
  constructor(private readonly filePath: string) {}

  async record(outcome: ExpertOutcome): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(sanitizeOutcome(outcome))}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async list(): Promise<ExpertOutcome[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
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
