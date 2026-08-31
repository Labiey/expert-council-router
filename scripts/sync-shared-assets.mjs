import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skill = path.join(root, "shared", "skills", "expert-council", "SKILL.md");
const skillTargets = [
  path.join(root, "packages", "pi-package", "skills", "expert-council", "SKILL.md"),
  path.join(root, "packages", "codex-integration", "plugin", "expert-council", "skills", "expert-council", "SKILL.md"),
];
for (const target of skillTargets) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skill, target);
}

const roleSource = path.join(root, "packages", "core", "src", "roles", "prompts");
const roleTargets = [
  path.join(root, "packages", "core", "dist", "roles"),
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
