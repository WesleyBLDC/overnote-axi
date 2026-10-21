/**
 * Resolves every location the CLI touches (slice: foundation).
 *
 * Defaults mirror the app (overnote docs/architecture.md sections 1 and 9):
 * - support dir: `~/Library/Application Support/com.raycast.macos/extensions/overnote`
 * - database: `<support dir>/notes.sqlite`
 * - runtime dir: `/tmp/overnote-<uid>`, socket `<runtime dir>/helper.sock`
 *
 * `OVERNOTE_SUPPORT_DIR` and `OVERNOTE_RUNTIME_DIR` override them, the same variables the app's
 * own scripts and end to end tests use. Tests always set both to temporary folders.
 */
import type { OvernotePaths } from "../domain/types.js";
import { notImplemented } from "../errors.js";

export interface PathEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly uid: number;
}

export const DEFAULT_SUPPORT_SUBPATH = "Library/Application Support/com.raycast.macos/extensions/overnote";

export function resolvePaths(_input: PathEnv): OvernotePaths {
  throw notImplemented("resolvePaths");
}

/**
 * Checks that the runtime dir is a real directory owned by `uid` and closed to other users
 * before the CLI connects to a socket inside it. Never creates it (the app does).
 */
export function isTrustedRuntimeDir(_dir: string, _uid: number): boolean {
  throw notImplemented("isTrustedRuntimeDir");
}
