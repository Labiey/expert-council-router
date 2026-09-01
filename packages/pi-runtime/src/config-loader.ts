import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseCouncilConfig, type CouncilConfig } from "@expert-council/core";

export async function loadCouncilConfig(filePath?: string): Promise<CouncilConfig> {
  const selected = filePath ?? process.env.EXPERT_COUNCIL_CONFIG;
  if (!selected) return parseCouncilConfig({});
  if (selected.length > 32_768 || selected.includes("\0")) {
    throw new Error("Expert Council config path must be at most 32768 characters without NUL bytes.");
  }
  const resolved = path.resolve(selected);
  let text: string;
  try {
    text = await readFile(await realpath(resolved), "utf8");
  } catch (error) {
    throw new Error(`Unable to read Expert Council config at ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseCouncilConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in Expert Council config ${resolved}: ${error.message}`);
    throw error;
  }
}
