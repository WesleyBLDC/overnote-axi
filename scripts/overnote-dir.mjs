// Resolves the Overnote checkout that @overnote/core is bundled from.
// OVERNOTE_DIR wins; otherwise the sibling folder ../overnote is used.
import { existsSync } from "node:fs";
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
  if (!existsSync(path.join(dir, "node_modules", "@tiptap", "core"))) {
    throw new Error(`The Overnote checkout at ${dir} has no node_modules yet. Run npm install there first.`);
  }
  return dir;
}
