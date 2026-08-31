import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCouncilConfig, type CouncilConfig } from "@expert-council/core";

export async function loadCouncilConfig(filePath?: string): Promise<CouncilConfig> {
  const selected = filePath ?? process.env.EXPERT_COUNCIL_CONFIG;
  if (!selected) return parseCouncilConfig({});
  let text: string;
  try {
    text = await readFile(path.resolve(selected), "utf8");
  } catch (error) {
    throw new Error(`Unable to read Expert Council config at ${path.resolve(selected)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseCouncilConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in Expert Council config ${path.resolve(selected)}: ${error.message}`);
    throw error;
  }
}
