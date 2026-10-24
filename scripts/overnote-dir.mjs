// Resolves the Overnote checkout that @overnote/core is bundled from.
// OVERNOTE_DIR wins; otherwise the sibling folder ../overnote is used.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The source with comments blanked out, keeping string literals (so a "//" inside one stays). */
function withoutComments(source) {
  return source.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, literal) =>
    literal ?? " ",
  );
}

/** The TypeScript file a relative module specifier names, or null when there is none. */
function resolveModule(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * True when the module at `file` exports `name` as a value: `export function name`, a declared
 * `export const`/`let`/`var`/`class`, a name in an `export { ... }` list (after `as` when renamed),
 * or through `export * from "./module"` of a module that exports it. Comments never count.
 */
export function exportsName(file, name, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = withoutComments(readFileSync(file, "utf8"));
  const declared = new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}\\b`);
  if (declared.test(source)) return true;
  // `export type { ... }` and `type` items export types only, so they are skipped.
  for (const [, list] of source.matchAll(/\bexport\s+\{([^}]*)\}/g)) {
    for (const item of list.split(",").map((part) => part.trim())) {
      if (item.startsWith("type ")) continue;
      if (item.split(/\s+as\s+/).at(-1) === name) return true;
    }
  }
  for (const [, specifier] of source.matchAll(/\bexport\s+\*\s+from\s+["']([^"']+)["']/g)) {
    const target = specifier.startsWith(".") ? resolveModule(file, specifier) : null;
    if (target && exportsName(target, name, seen)) return true;
  }
  return false;
}

export function overnoteDir() {
  const dir = path.resolve(repoRoot, process.env.OVERNOTE_DIR ?? "../overnote");
  const core = path.join(dir, "packages", "core", "src", "index.ts");
  if (!existsSync(core)) {
    throw new Error(
      `No Overnote checkout at ${dir} (missing packages/core/src/index.ts). ` +
        "Clone https://github.com/WesleyBLDC/overnote next to this repo and run npm install there, or set OVERNOTE_DIR.",
    );
  }
  if (!exportsName(core, "duplicateContent")) {
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
