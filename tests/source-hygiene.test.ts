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
  it("builds with a forced full compile, so generated artifacts cannot lag the source", () => {
    // Incremental `tsc -b` decided its output was current after a falsification script restored a
    // source file, and the tracked Codex bundle was committed without the fix that had just landed
    // in source. A gate that compares artifacts against a build is worthless if that build can lag.
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    expect(scripts.build).toContain("tsc -b --force");
    expect(scripts.validate).toContain("artifacts:check");
  });

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

  it("keeps the README's configuration examples true to the shipped schemas", async () => {
    // These blocks are the documented standard form, so nothing but a test stops them from
    // describing a schema that has since changed. Parse them with the real validators, and compare
    // the "every key at its default" block against what the code actually defaults to: a key added
    // later, a value that moves, or a key dropped from the example all fail here rather than in a
    // user's terminal.
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const zhReadme = readFileSync(fileURLToPath(new URL("../README.zh-CN.md", import.meta.url)), "utf8");
    const example = (marker: string): string => {
      const start = readme.indexOf(marker);
      if (start < 0) throw new Error(`README is missing the "${marker}" marker`);
      const open = readme.indexOf("```json", start);
      const body = readme.indexOf("\n", open) + 1;
      const close = readme.indexOf("\n```", body);
      if (open < 0 || close < 0) throw new Error(`README has no json fence after "${marker}"`);
      return readme.slice(body, close);
    };
    const { parseCouncilConfig } = await import("../packages/core/src/config.js");
    const { routePolicyDocumentSchema } = await import("../packages/core/src/route-policy.js");

    const complete = JSON.parse(example("<!-- council-config:complete -->"));
    expect(complete).toEqual(parseCouncilConfig({}));
    // The variant is a worked example, so it only has to be accepted, and must not accidentally
    // restate defaults as if they were recommendations.
    expect(() => parseCouncilConfig(JSON.parse(example("<!-- council-config:variant -->")))).not.toThrow();
    expect(routePolicyDocumentSchema.safeParse(JSON.parse(example("<!-- route-policy:complete -->"))).success).toBe(true);
    // The Chinese reference must carry the same executable documents, not a translation that has
    // quietly fallen behind - it is where most drift ends up.
    const fenceAt = (text: string, marker: string): string => {
      const start = text.indexOf(marker);
      if (start < 0) throw new Error(`a README is missing the "${marker}" marker`);
      const open = text.indexOf("```json", start);
      const close = text.indexOf("\n```", open);
      if (open < 0 || close < 0) throw new Error(`no json fence after "${marker}"`);
      return text.slice(open, close);
    };
    for (const marker of ["<!-- council-config:complete -->", "<!-- council-config:variant -->", "<!-- route-policy:complete -->"]) {
      // Both sides are sliced from their own document: feeding one file's index into the other's
      // indexOf compares the reference against an unrelated block, which is exactly what the first
      // version of this loop did.
      expect(fenceAt(zhReadme, marker)).toBe(fenceAt(readme, marker));
    }
    const names = (text: string) => new Set(text.match(/EXPERT_COUNCIL_[A-Z_]+/g) ?? []);
    expect([...names(zhReadme)].sort()).toEqual([...names(readme)].sort());
  });

  it("keeps every shipped manifest and every release reference on one version", () => {
    // Releasing 0.8.7 left three places still claiming 0.8.6: the mirrored per-package READMEs, the
    // Codex plugin manifest, and the version the MCP server reports in its initialize handshake - so
    // a host saw the previous release while npm served the new one. Rather than remembering to edit
    // them, one assertion now covers every place a release version is stated.
    const root = (JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string }).version;
    expect(root).toMatch(/^\d+\.\d+\.\d+/);
    const packagesDir = fileURLToPath(new URL("../packages", import.meta.url));
    for (const entry of readdirSync(packagesDir)) {
      const manifest = path.join(packagesDir, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
      expect([entry, version]).toEqual([entry, root]);
    }
    const pluginManifest = path.join(
      packagesDir, "codex-integration", "plugin", "expert-council", ".codex-plugin", "plugin.json",
    );
    expect((JSON.parse(readFileSync(pluginManifest, "utf8")) as { version: string }).version).toBe(root);
    // No source file may state a release version as a literal any more.
    const server = readFileSync(path.join(packagesDir, "mcp-server", "src", "index.ts"), "utf8");
    expect(/version:\s*"\d+\.\d+/.test(server)).toBe(false);
    expect(server).toContain("version: SERVER_VERSION");
    // And neither may the documentation's claims about which release is current.
    for (const [label, file] of [["README.md", "../README.md"], ["README.zh-CN.md", "../README.zh-CN.md"]] as const) {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      const head = (label === "README.md"
        ? /The current version \(([\d.]+)\) includes:/.exec(text)
        : /当前版本（([\d.]+)）已包含：/.exec(text))?.[1];
      expect([label, head]).toEqual([label, root]);
      const refs = [...text.matchAll(/--ref v([\d.]+)/g)].map((match) => match[1]);
      expect(refs.length).toBeGreaterThan(0);
      expect([...new Set(refs)]).toEqual([root]);
    }
  });
});
