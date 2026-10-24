// Leaf module: no imports at all. bin/overnote-axi.ts reads it before the command graph loads,
// so `--version` costs nothing beyond Node's own startup. Keep it in sync with package.json
// (test/unit/version.test.ts checks).
export const VERSION = "0.1.0";

/**
 * node:sqlite needs Node 22.16: 22.5 to 22.12 cannot import it without a flag and FTS5 is missing
 * before 22.16. Hook environments often run older, so the bin gate checks this before loading anything.
 */
export function nodeTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < 22 || (major === 22 && minor < 16);
}
