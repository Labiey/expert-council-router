import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

  it("ships targets for every link its mirrored READMEs make (defect #38)", () => {
    // The per-package READMEs are generated mirrors that ship inside the published tarballs,
    // and they pointed at repository-root files that never entered those tarballs: SECURITY.md,
    // the shared Skill and the example configurations were dead links in the published artifact,
    // next to a language switcher aimed at a README.zh-CN.md that was never copied at all. The
    // sync step now ships the Chinese mirror and rewrites links that cannot resolve inside the
    // package into repository URLs. This guard fails if a shipped README ever points outside
    // its own package again - a documentation defect nobody would notice until a user clicked.
    const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));
    const offenders: string[] = [];
    for (const dir of readdirSync(packagesDir)) {
      if (!statSync(path.join(packagesDir, dir)).isDirectory()) continue;
      for (const name of ["README.md", "README.zh-CN.md"]) {
        const file = path.join(packagesDir, dir, name);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, "utf8");
        let cursor = 0;
        while (true) {
          const open = text.indexOf("](", cursor);
          if (open < 0) break;
          const close = text.indexOf(")", open + 2);
          if (close < 0) break;
          const target = text.slice(open + 2, close).trim();
          cursor = close;
          if (!target || target.startsWith("#")) continue;
          if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) continue;
          const local = (target.split("#")[0] ?? "").trim();
          if (!local) continue;
          if (!existsSync(path.join(packagesDir, dir, local))) {
            offenders.push(dir + "/" + name + " -> " + target);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
