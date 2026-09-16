import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every TypeScript source under packages/, skipping build output.
 */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === "dist" || entry === "node_modules") continue;
    const info = statSync(full);
    if (info.isDirectory()) found.push(...sources(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("source hygiene", () => {
  it("leaves no documentation block orphaned above another block", () => {
    // Shape: a `*/` with nothing between it and the next `/**`. That means an earlier doc
    // comment no longer documents anything, because a new declaration was inserted between
    // the comment and the code it described. It happened six times while patching this
    // repository (defect #30) - once with a stale block still promising "there is nothing
    // to redact here" after 0.8.4 had added real argument redaction, which is worse than no
    // comment at all because it is read as current.
    const orphaned: string[] = [];
    const pattern = /\*\/[ \t]*\r?\n[ \t]*\/\*\*/;
    for (const file of sources(fileURLToPath(new URL("../packages/", import.meta.url)))) {
      const text = readFileSync(file, "utf8");
      const match = pattern.exec(text);
      if (match) orphaned.push(`${path.basename(file)}:${text.slice(0, match.index).split(/\r?\n/).length}`);
    }
    expect(orphaned).toEqual([]);
  });
});
