import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
for (const packageName of documentationTargets) {
  const packageDirectory = path.join(root, "packages", packageName);
  await cp(path.join(root, "README.md"), path.join(packageDirectory, "README.md"));
  await cp(path.join(root, "LICENSE"), path.join(packageDirectory, "LICENSE"));
}
await cp(
  path.join(root, "LICENSE"),
  path.join(root, "packages", "codex-integration", "plugin", "expert-council", "LICENSE"),
);
