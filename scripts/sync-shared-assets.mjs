import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const skillDirectory = path.join(root, "shared", "skills", "expert-council");
const skill = path.join(skillDirectory, "SKILL.md");
const skillTargets = [
  {
    host: "pi",
    target: path.join(root, "packages", "pi-package", "skills", "expert-council", "SKILL.md"),
  },
  {
    host: "codex",
    target: path.join(root, "packages", "codex-integration", "plugin", "expert-council", "skills", "expert-council", "SKILL.md"),
  },
];
const sharedSkill = (await readFile(skill, "utf8")).trimEnd();
for (const { host, target } of skillTargets) {
  const hostGuidance = (await readFile(path.join(skillDirectory, "hosts", `${host}.md`), "utf8")).trim();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${sharedSkill}\n\n${hostGuidance}\n`, "utf8");
}

const roleSource = path.join(root, "packages", "core", "src", "roles", "prompts");
const roleTargets = [
  path.join(root, "packages", "core", "dist", "roles"),
  path.join(root, "packages", "pi-runtime", "dist", "roles"),
  path.join(root, "packages", "codex-integration", "plugin", "expert-council", "dist", "roles"),
];
const roleFiles = (await readdir(roleSource)).filter((file) => file.endsWith(".md"));
for (const targetDirectory of roleTargets) {
  await mkdir(targetDirectory, { recursive: true });
  for (const file of roleFiles) await cp(path.join(roleSource, file), path.join(targetDirectory, file));
}

const documentationTargets = ["core", "pi-runtime", "cli", "mcp-server", "pi-package"];
const repositoryDocsBase = "https://github.com/Labiey/expert-council-router/blob/main";

/**
 * A mirrored README keeps relative links that only resolve at the repository root -
 * SECURITY.md, the shared Skill, the example configurations - and inside a published
 * tarball every one of those is a dead link (defect #38). Rather than ship three more
 * copies of repository files in every package, the mirror rewrites exactly the links that
 * do not resolve next to itself into repository URLs and leaves the rest byte-identical,
 * so the source keeps working offline while the published docs stay clickable.
 */
async function mirrorDocumentation(source, packageDirectory) {
  const text = await readFile(path.join(root, source), "utf8");
  const rewritten = text.replace(
    /\]\((?!https?:|mailto:|#)([^)\s]+)(#[^)]*)?\)/g,
    (match, target, hash) => {
      const local = path.join(packageDirectory, path.posix.normalize(target));
      return existsSync(local) ? match : `](${repositoryDocsBase}/${path.posix.normalize(target)}${hash ?? ""})`;
    },
  );
  await writeFile(path.join(packageDirectory, source), rewritten, "utf8");
}

for (const packageName of documentationTargets) {
  const packageDirectory = path.join(root, "packages", packageName);
  await mirrorDocumentation("README.md", packageDirectory);
  // The mirrored README links to its Chinese counterpart, so the counterpart has to ship
  // with it or every published package publishes a dead link.
  await mirrorDocumentation("README.zh-CN.md", packageDirectory);
  await cp(path.join(root, "LICENSE"), path.join(packageDirectory, "LICENSE"));
}
await cp(
  path.join(root, "LICENSE"),
  path.join(root, "packages", "codex-integration", "plugin", "expert-council", "LICENSE"),
);
