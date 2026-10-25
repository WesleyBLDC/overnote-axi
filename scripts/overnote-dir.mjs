// Resolves the Overnote checkout that @overnote/core is bundled from.
// OVERNOTE_DIR wins; otherwise the sibling folder ../overnote is used, and inside a git worktree
// without one, the sibling of the main checkout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIT_TIMEOUT_MS = 5000;

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The source with comments blanked out, keeping string and regex literals (so a "//" or a quote
 * inside one stays). A "/" starts a regex literal only after an operator or opening bracket.
 */
function withoutComments(source) {
  const literals =
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|(?<=[(,=:[!&|?{};]\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  return source.replace(literals, (match, literal) =>
    literal ?? " ",
  );
}

/** The TypeScript file a relative module specifier names, or null when there is none. */
function resolveModule(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const bare = base.replace(/\.js$/, "");
  for (const candidate of [base, `${bare}.ts`, `${bare}.tsx`, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
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

/** The main checkout's parent folder when `root` is a linked git worktree, else null. */
function mainCheckoutParent(root) {
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return path.dirname(path.dirname(path.resolve(root, common)));
  } catch {
    return null;
  }
}

/** The folder to bundle @overnote/core from: OVERNOTE_DIR, else ../overnote, else the main checkout's sibling. */
export function locateOvernote({ root = repoRoot, env = process.env } = {}) {
  if (env.OVERNOTE_DIR) return path.resolve(root, env.OVERNOTE_DIR);
  const sibling = path.resolve(root, "../overnote");
  if (existsSync(sibling)) return sibling;
  const parent = mainCheckoutParent(root);
  return parent ? path.join(parent, "overnote") : sibling;
}

/** True when packages/core of the checkout at `dir` has uncommitted changes to tracked files. */
export function coreIsDirty(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no", "--", "packages/core"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return out.trim() !== "";
  } catch {
    return false;
  }
}

export function overnoteDir({ root = repoRoot, env = process.env, warn = console.warn } = {}) {
  const dir = locateOvernote({ root, env });
  const core = path.join(dir, "packages", "core", "src", "index.ts");
  if (!existsSync(core)) {
    throw new Error(
      `No Overnote checkout at ${dir} (missing packages/core/src/index.ts). ` +
        "Clone https://github.com/WesleyBLDC/overnote next to this repo and run npm install there, or set OVERNOTE_DIR.",
    );
  }
  if (env.OVERNOTE_REQUIRE_CLEAN !== "1" && coreIsDirty(dir)) {
    warn(
      `warning: packages/core in ${dir} has uncommitted changes, so the bundled core differs from its commit. ` +
        "Set OVERNOTE_DIR to a clean checkout to avoid that.",
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
