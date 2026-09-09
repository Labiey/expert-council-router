import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseCouncilConfig, type CouncilConfig } from "@expert-council/core";

export interface LoadedCouncilConfig {
  config: CouncilConfig;
  /** The path actually loaded, if any; `undefined` means all defaults. */
  sourcePath?: string;
  /** How the path was chosen: an explicit option/environment override or the data-directory default file. */
  source: "explicit" | "default-file" | "none";
}

async function readConfigFile(resolved: string): Promise<CouncilConfig> {
  let text: string;
  try {
    text = await readFile(await realpath(resolved), "utf8");
  } catch (error) {
    // Preserve the errno code (ENOENT, EACCES, ...) so callers can branch on it.
    const wrapped = new Error(
      `Unable to read Expert Council config at ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    ) as Error & { code?: string };
    wrapped.code = (error as NodeJS.ErrnoException).code;
    throw wrapped;
  }
  try {
    return parseCouncilConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in Expert Council config ${resolved}: ${error.message}`);
    throw error;
  }
}

/**
 * Load the operator configuration. Resolution order:
 * 1. explicit `filePath` argument or the `EXPERT_COUNCIL_CONFIG` environment
 *    variable — a missing file is an error (the operator declared it);
 * 2. the data-directory default `council-config.json` — a missing file is
 *    fine and yields an all-defaults configuration, so depending on the
 *    config file is never required;
 * 3. otherwise all defaults.
 */
export async function loadCouncilConfig(filePath: string | undefined, defaultPath?: string): Promise<LoadedCouncilConfig> {
  const selected = filePath ?? process.env.EXPERT_COUNCIL_CONFIG;
  if (selected) {
    if (selected.length > 32_768 || selected.includes("\0")) {
      throw new Error("Expert Council config path must be at most 32768 characters without NUL bytes.");
    }
    return { config: await readConfigFile(path.resolve(selected)), sourcePath: path.resolve(selected), source: "explicit" };
  }
  if (defaultPath) {
    const resolved = path.resolve(defaultPath);
    try {
      return { config: await readConfigFile(resolved), sourcePath: resolved, source: "default-file" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The default file is optional by design; malformed JSON still fails
      // loudly so an operator typo never silently disables a security setting.
      if (code === "ENOENT") return { config: parseCouncilConfig({}), source: "none" };
      throw error;
    }
  }
  return { config: parseCouncilConfig({}), source: "none" };
}
