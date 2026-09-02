import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

function assertPrivateOwnership(info: Stats, label: string): void {
  if (typeof process.getuid !== "function") return;
  if (info.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user.`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} is writable by another user or group.`);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAllowedWindowsAppDataRedirect(expectedParent: string, resolvedParent: string): boolean {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return false;
  return isWithin(process.env.LOCALAPPDATA, expectedParent) && isWithin(process.env.LOCALAPPDATA, resolvedParent);
}

export async function ensurePrivateStoragePath(value: string): Promise<string> {
  if (!value || value.length > 32_768 || value.includes("\0")) {
    throw new Error("Storage path must be non-empty, at most 32768 characters, and contain no NUL bytes.");
  }
  const filePath = path.resolve(value);
  const expectedParent = path.dirname(filePath);
  await mkdir(expectedParent, { recursive: true, mode: 0o700 });
  const parentLink = await lstat(expectedParent);
  if (parentLink.isSymbolicLink()) throw new Error(`Storage directory ${expectedParent} must not be a symbolic link.`);
  const resolvedParent = await realpath(expectedParent);
  if (path.relative(expectedParent, resolvedParent) !== "" && !isAllowedWindowsAppDataRedirect(expectedParent, resolvedParent)) {
    throw new Error(`Storage directory ${expectedParent} resolves through a redirected path.`);
  }
  const resolvedFilePath = path.join(resolvedParent, path.basename(filePath));
  const parentInfo = await stat(resolvedParent);
  if (!parentInfo.isDirectory()) throw new Error(`Storage parent ${resolvedParent} is not a directory.`);
  assertPrivateOwnership(parentInfo, `Storage directory ${resolvedParent}`);
  await chmod(resolvedParent, 0o700).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32") throw error;
  });

  try {
    const target = await lstat(resolvedFilePath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error(`Storage file ${resolvedFilePath} must be a regular file, not a link or special file.`);
    }
    assertPrivateOwnership(target, `Storage file ${resolvedFilePath}`);
    await chmod(resolvedFilePath, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32") throw error;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolvedFilePath;
}
