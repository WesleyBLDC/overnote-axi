// Resolves the Overnote checkout that @overnote/core is bundled from.
// OVERNOTE_DIR wins; otherwise the sibling folder ../overnote is used.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function overnoteDir() {
  const dir = path.resolve(repoRoot, process.env.OVERNOTE_DIR ?? "../overnote");
  const core = path.join(dir, "packages", "core", "src", "index.ts");
  if (!existsSync(core)) {
    throw new Error(
      `No Overnote checkout at ${dir} (missing packages/core/src/index.ts). ` +
        "Clone https://github.com/WesleyBLDC/overnote next to this repo and run npm install there, or set OVERNOTE_DIR.",
    );
  }
  if (!/\bduplicateContent\b/.test(readFileSync(core, "utf8"))) {
    throw new Error(
      `The Overnote core at ${dir} does not export duplicateContent (packages/core/src/index.ts). ` +
        "overnote-axi needs Overnote protocol v3.0 or newer: update that checkout to a commit that has it, or set OVERNOTE_DIR.",
    );
  }
  if (!existsSync(path.join(dir, "node_modules", "@tiptap", "core"))) {
    throw new Error(`The Overnote checkout at ${dir} has no node_modules yet. Run npm install there first.`);
  }
  return dir;
}
