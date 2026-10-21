/**
 * The last line of defense for "tests never touch Wesley's real notes or agent config".
 * Fixtures and integration tests call assertIsolated() on every path they are about to hand to
 * the CLI (support dir, runtime dir, socket, hook targets, skill dir); test/setup.ts calls it on
 * the environment it installs, so a broken setup fails the whole run before any test starts.
 */
import os from "node:os";
import path from "node:path";

/** The real home, from the user database: HOME may already point at a temp dir. */
export const REAL_HOME = os.userInfo().homedir;
/** The real Overnote runtime dir, where the user's live helper listens. */
export const REAL_RUNTIME_DIR = `/tmp/overnote-${os.userInfo().uid}`;

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertIsolated(target: string, what = "path"): void {
  const resolved = path.resolve(target);
  if (inside(resolved, REAL_HOME) || inside(resolved, REAL_RUNTIME_DIR)) {
    throw new Error(`Test isolation: ${what} ${resolved} is inside the real home or the real Overnote runtime dir`);
  }
}
