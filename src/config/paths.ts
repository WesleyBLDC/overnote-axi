/**
 * Resolves every location the CLI touches.
 *
 * Defaults mirror the app (overnote docs/architecture.md sections 1 and 9):
 * - support dir: `~/Library/Application Support/com.raycast.macos/extensions/overnote`
 * - database: `<support dir>/notes.sqlite`
 * - runtime dir: `/tmp/overnote-<uid>`, socket `<runtime dir>/helper.sock`
 *
 * `OVERNOTE_SUPPORT_DIR` and `OVERNOTE_RUNTIME_DIR` override them, the same variables the app's
 * own scripts and end to end tests use. Tests always set both to temporary folders.
 */
import { lstatSync } from "node:fs";
import path from "node:path";

import type { OvernotePaths } from "../domain/types.js";

export interface PathEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly uid: number;
}

export const DEFAULT_SUPPORT_SUBPATH = "Library/Application Support/com.raycast.macos/extensions/overnote";
export const DATABASE_FILE = "notes.sqlite";
export const SOCKET_FILE = "helper.sock";

/** The app's runtime dir for `uid` (overnote src/domain/paths.ts `runtimeDirFor`). */
export function defaultRuntimeDir(uid: number): string {
  return `/tmp/overnote-${uid}`;
}

/** An override counts only when it is set and not blank; relative values resolve against the cwd. */
function override(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? path.resolve(value) : undefined;
}

export function resolvePaths(input: PathEnv): OvernotePaths {
  const supportDir = override(input.env.OVERNOTE_SUPPORT_DIR) ?? path.join(input.home, DEFAULT_SUPPORT_SUBPATH);
  const runtimeDir = override(input.env.OVERNOTE_RUNTIME_DIR) ?? defaultRuntimeDir(input.uid);
  return {
    supportDir,
    database: path.join(supportDir, DATABASE_FILE),
    runtimeDir,
    socket: path.join(runtimeDir, SOCKET_FILE),
  };
}

/**
 * Checks that the runtime dir is a real directory owned by `uid` and closed to other users
 * before the CLI connects to a socket inside it. Never creates it (the app does).
 */
export function isTrustedRuntimeDir(dir: string, uid: number): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Checks the socket itself with lstat: a socket (not a symlink or regular file) owned by `uid`.
 * Runs after isTrustedRuntimeDir and before every connection.
 */
export function isTrustedSocket(socketPath: string, uid: number): boolean {
  try {
    const stat = lstatSync(socketPath);
    return stat.isSocket() && stat.uid === uid;
  } catch {
    return false;
  }
}
