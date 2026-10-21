/**
 * Small filesystem helpers for the integrations: every write to agent
 * config is atomic and keeps the file mode, and a symlinked config file (a dotfiles checkout)
 * is written through to its target instead of being replaced by a regular file.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The file's text, or null when nothing exists at that path. */
export function readIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/** True when the path is a directory (following symlinks). */
export function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Writes `content` atomically: a temp file in the destination directory, then a rename.
 * An existing file keeps its mode; a new one gets `mode`. Missing parent directories are created.
 */
export function writeAtomic(file: string, content: string, mode = 0o644): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  const keep = existsSync(target) ? statSync(target).mode & 0o7777 : mode;
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, content, { mode: keep, flag: "wx" });
    // The umask may have narrowed the mode on creation; set it exactly before the rename.
    chmodSync(temp, keep);
    renameSync(temp, target);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

/** True when the path itself is a symlink. */
export function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Removes a file (a symlink itself, never its target). */
export function removeFile(file: string): void {
  unlinkSync(file);
}

/** Removes a directory only when it is empty; anything else is left alone. */
export function removeDirIfEmpty(dir: string): void {
  try {
    if (lstatSync(dir).isDirectory()) rmdirSync(dir);
  } catch {
    // Not empty, or already gone: both are fine.
  }
}
